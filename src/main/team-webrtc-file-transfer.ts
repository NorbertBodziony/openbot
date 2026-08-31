import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { isString } from "@openbot/contracts/runtime-values";
import {
  decodeTeamProtocolV2FileChunk,
  decodeTeamProtocolV2FileControlFrame,
  encodeTeamProtocolV2FileChunk,
  encodeTeamProtocolV2Frame,
  TEAM_PROTOCOL_V2_MAX_FILE_BYTES,
  TEAM_PROTOCOL_V2_MAX_FILE_SET_BYTES,
} from "@openbot/contracts/team-protocol/v2";
import type { TeamWebRtcBridge } from "./team-webrtc-bridge";

const FILE_CHUNK_BYTES = 60 * 1024;
const ACK_INTERVAL_BYTES = 1024 * 1024;
const TRANSFER_RESUME_MILLISECONDS = 10 * 60_000;

interface IncomingTransfer {
  peerId: string;
  transferId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  path: string;
  file: FileHandle;
  received: number;
  lastAcknowledged: number;
}

interface OutgoingTransfer {
  peerId: string;
  transferId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  sha256: string;
  acknowledged: number;
  acknowledgementGeneration: number;
  cancelled: Error | null;
}

export interface ReceivedWebRtcFile {
  peerId: string;
  transferId: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
}

export class TeamWebRtcFileTransfer {
  readonly #bridge: TeamWebRtcBridge;
  readonly #directory: string;
  readonly #resumeMilliseconds: number;
  readonly #incoming = new Map<string, IncomingTransfer>();
  readonly #outgoing = new Map<string, OutgoingTransfer>();
  readonly #completed = new Map<string, ReceivedWebRtcFile>();
  readonly #expirationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #waiters = new Map<
    string,
    {
      resolve: (file: ReceivedWebRtcFile) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #chain = Promise.resolve();
  readonly #connectedPeers = new Set<string>();
  readonly #stateWaiters = new Set<() => void>();
  #stopped = false;

  constructor(bridge: TeamWebRtcBridge, directory: string, resumeMilliseconds = TRANSFER_RESUME_MILLISECONDS) {
    this.#bridge = bridge;
    this.#directory = directory;
    this.#resumeMilliseconds = resumeMilliseconds;
    bridge.on("data", this.#onData);
    bridge.on("connected", this.#onConnected);
    bridge.on("disconnected", this.#onDisconnected);
  }

  async send(peerId: string, input: { name: string; mimeType: string; bytes: Uint8Array }): Promise<string> {
    if (this.#stopped) throw new Error("The WebRTC file transport is stopped.");
    if (input.bytes.byteLength > TEAM_PROTOCOL_V2_MAX_FILE_BYTES) throw new Error("The file is larger than 100 MB.");
    const activeBytes = [...this.#outgoing.values()]
      .filter((transfer) => transfer.peerId === peerId)
      .reduce((sum, transfer) => sum + transfer.bytes.byteLength, 0);
    if (activeBytes + input.bytes.byteLength > TEAM_PROTOCOL_V2_MAX_FILE_SET_BYTES) {
      throw new Error("The active file set is larger than 250 MB.");
    }
    const transferId = randomUUID();
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const transfer: OutgoingTransfer = {
      peerId,
      transferId,
      name: basename(input.name) || "file",
      mimeType: input.mimeType || "application/octet-stream",
      bytes: input.bytes,
      sha256,
      acknowledged: 0,
      acknowledgementGeneration: 0,
      cancelled: null,
    };
    this.#outgoing.set(transferKey(peerId, transferId), transfer);
    try {
      await this.#sendWithResume(transfer);
      return transferId;
    } finally {
      this.#outgoing.delete(transferKey(peerId, transferId));
    }
  }

  receive(peerId: string, transferId: string, timeoutMs = 60_000): Promise<ReceivedWebRtcFile> {
    const key = transferKey(peerId, transferId);
    const completed = this.#completed.get(key);
    if (completed) return Promise.resolve(completed);
    const existing = this.#waiters.get(key);
    if (existing) return Promise.reject(new Error("The WebRTC file is already being received."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(key);
        reject(new Error("The WebRTC file transfer timed out."));
      }, timeoutMs);
      this.#waiters.set(key, { resolve, reject, timer });
    });
  }

  async consume(peerId: string, transferId: string): Promise<{ bytes: Uint8Array; name: string; mimeType: string }> {
    const file = await this.receive(peerId, transferId);
    try {
      return { bytes: new Uint8Array(await readFile(file.path)), name: file.name, mimeType: file.mimeType };
    } finally {
      const key = transferKey(peerId, transferId);
      this.#clearExpiration(key);
      this.#completed.delete(key);
      await rm(file.path, { force: true });
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#notifyStateChange();
    this.#bridge.off("data", this.#onData);
    this.#bridge.off("connected", this.#onConnected);
    this.#bridge.off("disconnected", this.#onDisconnected);
    for (const timer of this.#expirationTimers.values()) clearTimeout(timer);
    this.#expirationTimers.clear();
    await this.#chain.catch(() => undefined);
    await Promise.all([...this.#incoming.values()].map((transfer) => transfer.file.close().catch(() => undefined)));
    await Promise.all(
      [...this.#incoming.values(), ...this.#completed.values()].map((transfer) => rm(transfer.path, { force: true })),
    );
    for (const timer of this.#expirationTimers.values()) clearTimeout(timer);
    this.#incoming.clear();
    this.#outgoing.clear();
    this.#completed.clear();
    this.#expirationTimers.clear();
  }

  readonly #onConnected = (peerId: string): void => {
    this.#connectedPeers.add(peerId);
    this.#notifyStateChange();
  };

  readonly #onDisconnected = (peerId: string): void => {
    this.#connectedPeers.delete(peerId);
    this.#notifyStateChange();
  };

  readonly #onData = (
    peerId: string,
    channel: "rpc" | "events" | "files" | "desktop",
    data: string | ArrayBuffer,
  ): void => {
    if (channel !== "files") return;
    const transferId = fileTransferId(data);
    this.#chain = this.#chain
      .then(() => this.#handleData(peerId, data))
      .catch((error) => this.#failFrame(peerId, transferId, error));
  };

  async #handleData(peerId: string, data: string | ArrayBuffer): Promise<void> {
    if (isString(data)) {
      const frame = decodeTeamProtocolV2FileControlFrame(data);
      const key = transferKey(peerId, frame.transferId);
      if (frame.type === "file-open") {
        const existing = this.#incoming.get(key);
        if (existing) {
          if (existing.size !== frame.size || existing.sha256 !== frame.sha256)
            throw new Error("The resumed WebRTC file metadata changed.");
          await this.#bridge.send(
            peerId,
            "files",
            encodeTeamProtocolV2Frame({
              version: 2,
              type: "file-ack",
              transferId: frame.transferId,
              receivedThrough: existing.received,
            }),
          );
          return;
        }
        const activeBytes = [...this.#incoming.values(), ...this.#completed.values()]
          .filter((item) => item.peerId === peerId)
          .reduce((sum, item) => sum + item.size, 0);
        if (activeBytes + frame.size > TEAM_PROTOCOL_V2_MAX_FILE_SET_BYTES)
          throw new Error("The active file set is larger than 250 MB.");
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        const path = join(this.#directory, `${frame.transferId}.part`);
        const file = await open(path, "w", 0o600);
        this.#incoming.set(key, {
          peerId,
          transferId: frame.transferId,
          name: frame.name,
          mimeType: frame.mimeType,
          size: frame.size,
          sha256: frame.sha256,
          path,
          file,
          received: 0,
          lastAcknowledged: 0,
        });
        this.#scheduleExpiration(key);
        await this.#bridge.send(
          peerId,
          "files",
          encodeTeamProtocolV2Frame({ version: 2, type: "file-ack", transferId: frame.transferId, receivedThrough: 0 }),
        );
      } else if (frame.type === "file-ack") {
        const outgoing = this.#outgoing.get(key);
        if (
          !outgoing ||
          frame.receivedThrough < outgoing.acknowledged ||
          frame.receivedThrough > outgoing.bytes.byteLength
        )
          return;
        outgoing.acknowledged = frame.receivedThrough;
        outgoing.acknowledgementGeneration += 1;
        this.#notifyStateChange();
      } else if (frame.type === "file-complete") {
        const transfer = this.#incoming.get(key);
        if (!transfer || transfer.received !== transfer.size) throw new Error("The WebRTC file is incomplete.");
        await transfer.file.close();
        if ((await sha256File(transfer.path)) !== transfer.sha256) {
          const error = new Error("The WebRTC file hash is invalid.");
          await this.#bridge
            .send(
              peerId,
              "files",
              encodeTeamProtocolV2Frame({
                version: 2,
                type: "file-cancel",
                transferId: transfer.transferId,
                reason: error.message,
              }),
            )
            .catch(() => undefined);
          await this.#cancel(key, error);
          throw error;
        }
        this.#incoming.delete(key);
        const completed = {
          peerId,
          transferId: transfer.transferId,
          name: transfer.name,
          mimeType: transfer.mimeType,
          size: transfer.size,
          path: transfer.path,
        };
        this.#completed.set(key, completed);
        this.#scheduleExpiration(key);
        const waiter = this.#waiters.get(key);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.#waiters.delete(key);
          waiter.resolve(completed);
        }
      } else if (frame.type === "file-cancel") {
        const outgoing = this.#outgoing.get(key);
        if (outgoing) {
          outgoing.cancelled = new Error(frame.reason);
          this.#notifyStateChange();
        }
        await this.#cancel(key, new Error(frame.reason));
      }
      return;
    }
    const chunk = decodeTeamProtocolV2FileChunk(data);
    const key = transferKey(peerId, chunk.transferId);
    const transfer = this.#incoming.get(key);
    if (!transfer || chunk.offset !== transfer.received || transfer.received + chunk.bytes.byteLength > transfer.size) {
      throw new Error("The WebRTC file offset is invalid.");
    }
    await transfer.file.write(chunk.bytes, 0, chunk.bytes.byteLength, chunk.offset);
    transfer.received += chunk.bytes.byteLength;
    this.#scheduleExpiration(key);
    if (transfer.received === transfer.size || transfer.received - transfer.lastAcknowledged >= ACK_INTERVAL_BYTES) {
      transfer.lastAcknowledged = transfer.received;
      await this.#bridge.send(
        peerId,
        "files",
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "file-ack",
          transferId: transfer.transferId,
          receivedThrough: transfer.received,
        }),
      );
    }
  }

  async #cancel(key: string, error: Error): Promise<void> {
    this.#clearExpiration(key);
    const transfer = this.#incoming.get(key);
    if (transfer) {
      this.#incoming.delete(key);
      await transfer.file.close().catch(() => undefined);
      await rm(transfer.path, { force: true });
    }
    const completed = this.#completed.get(key);
    if (completed) {
      this.#completed.delete(key);
      await rm(completed.path, { force: true });
    }
    const waiter = this.#waiters.get(key);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.#waiters.delete(key);
      waiter.reject(error);
    }
  }

  async #failFrame(peerId: string, transferId: string | null, error: unknown): Promise<void> {
    if (!transferId) return;
    const failure = error instanceof Error ? error : new Error("The WebRTC file transfer failed.");
    await this.#bridge
      .send(
        peerId,
        "files",
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "file-cancel",
          transferId,
          reason: failure.message.slice(0, 512),
        }),
      )
      .catch(() => undefined);
    await this.#cancel(transferKey(peerId, transferId), failure);
  }

  async #sendWithResume(transfer: OutgoingTransfer): Promise<void> {
    const deadline = Date.now() + this.#resumeMilliseconds;
    while (Date.now() < deadline) {
      if (transfer.cancelled) throw transfer.cancelled;
      await this.#waitUntil(() => this.#connectedPeers.has(transfer.peerId), deadline);
      const generation = transfer.acknowledgementGeneration;
      try {
        await this.#bridge.send(
          transfer.peerId,
          "files",
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "file-open",
            transferId: transfer.transferId,
            name: transfer.name,
            size: transfer.bytes.byteLength,
            mimeType: transfer.mimeType,
            sha256: transfer.sha256,
          }),
        );
        await this.#waitUntil(
          () =>
            Boolean(transfer.cancelled) ||
            transfer.acknowledgementGeneration > generation ||
            !this.#connectedPeers.has(transfer.peerId),
          deadline,
        );
        if (transfer.cancelled) throw transfer.cancelled;
        if (!this.#connectedPeers.has(transfer.peerId)) continue;
        for (let offset = transfer.acknowledged; offset < transfer.bytes.byteLength; offset += FILE_CHUNK_BYTES) {
          const chunk = encodeTeamProtocolV2FileChunk({
            transferId: transfer.transferId,
            offset,
            bytes: transfer.bytes.slice(offset, Math.min(transfer.bytes.byteLength, offset + FILE_CHUNK_BYTES)),
          });
          const transferable = new Uint8Array(chunk.byteLength);
          transferable.set(chunk);
          await this.#bridge.send(transfer.peerId, "files", transferable.buffer);
        }
        await this.#bridge.send(
          transfer.peerId,
          "files",
          encodeTeamProtocolV2Frame({ version: 2, type: "file-complete", transferId: transfer.transferId }),
        );
        return;
      } catch {
        if (Date.now() >= deadline) break;
        await this.#waitUntil(
          () => !this.#connectedPeers.has(transfer.peerId),
          Math.min(deadline, Date.now() + 2_000),
        ).catch(() => undefined);
      }
    }
    throw new Error("The WebRTC file transfer could not resume before its deadline.");
  }

  #waitUntil(predicate: () => boolean, deadline: number): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const check = () => {
        if (this.#stopped) {
          clearTimeout(timer);
          this.#stateWaiters.delete(check);
          reject(new Error("The WebRTC file transport stopped."));
          return;
        }
        if (!predicate()) return;
        clearTimeout(timer);
        this.#stateWaiters.delete(check);
        resolve();
      };
      timer = setTimeout(
        () => {
          this.#stateWaiters.delete(check);
          reject(new Error("The WebRTC file transfer timed out."));
        },
        Math.max(1, deadline - Date.now()),
      );
      this.#stateWaiters.add(check);
    });
  }

  #notifyStateChange(): void {
    for (const waiter of [...this.#stateWaiters]) waiter();
  }

  #scheduleExpiration(key: string): void {
    this.#clearExpiration(key);
    const timer = setTimeout(() => {
      this.#expirationTimers.delete(key);
      this.#chain = this.#chain.then(() => this.#expire(key)).catch(() => undefined);
    }, this.#resumeMilliseconds);
    timer.unref?.();
    this.#expirationTimers.set(key, timer);
  }

  #clearExpiration(key: string): void {
    const timer = this.#expirationTimers.get(key);
    if (timer) clearTimeout(timer);
    this.#expirationTimers.delete(key);
  }

  async #expire(key: string): Promise<void> {
    const error = new Error("The WebRTC file transfer resume deadline expired.");
    const transfer = this.#incoming.get(key);
    if (transfer) {
      this.#incoming.delete(key);
      await transfer.file.close().catch(() => undefined);
      await rm(transfer.path, { force: true });
    }
    const completed = this.#completed.get(key);
    if (completed) {
      this.#completed.delete(key);
      await rm(completed.path, { force: true });
    }
    const waiter = this.#waiters.get(key);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.#waiters.delete(key);
      waiter.reject(error);
    }
  }
}

function transferKey(peerId: string, transferId: string): string {
  return `${peerId}\0${transferId}`;
}

function fileTransferId(data: string | ArrayBuffer): string | null {
  try {
    return isString(data)
      ? decodeTeamProtocolV2FileControlFrame(data).transferId
      : decodeTeamProtocolV2FileChunk(data).transferId;
  } catch {
    return null;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
