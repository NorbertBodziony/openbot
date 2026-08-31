import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isString } from "@openbot/contracts/runtime-values";
import {
  decodeTeamProtocolV2FileChunk,
  decodeTeamProtocolV2FileControlFrame,
  encodeTeamProtocolV2FileChunk,
  encodeTeamProtocolV2Frame,
} from "@openbot/contracts/team-protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcFileTransfer } from "./team-webrtc-file-transfer";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeBridge extends TeamWebRtcBridge {
  readonly sent: Array<{ peerId: string; channel: string; data: string | ArrayBuffer }> = [];

  async send(peerId: string, channel: string, data: string | ArrayBuffer): Promise<void> {
    this.sent.push({ peerId, channel, data });
  }
}

describe("TeamWebRtcFileTransfer", () => {
  it("lets only the transfer service that owns a peer process its file frames", async () => {
    const bridge = new FakeBridge();
    const first = new TeamWebRtcFileTransfer(
      bridge,
      await temporaryDirectory(),
      undefined,
      (peerId) => peerId === "host-1",
    );
    const second = new TeamWebRtcFileTransfer(
      bridge,
      await temporaryDirectory(),
      undefined,
      (peerId) => peerId === "host-2",
    );
    bridge.emit(
      "data",
      "host-1",
      "files",
      fileOpen("transfer-1", 4, createHash("sha256").update("test").digest("hex")),
    );
    await vi.waitFor(() => expect(bridge.sent).toHaveLength(1));
    await first.stop();
    await second.stop();
  });

  it("resumes at the last exact offset and verifies SHA-256", async () => {
    const bridge = new FakeBridge();
    const directory = await temporaryDirectory();
    const transfers = new TeamWebRtcFileTransfer(bridge, directory);
    const bytes = new TextEncoder().encode("hello-world");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const complete = transfers.receive("host-1", "transfer-1");
    bridge.emit("data", "host-1", "files", fileOpen("transfer-1", bytes.byteLength, sha256));
    bridge.emit("data", "host-1", "files", chunk("transfer-1", 0, bytes.slice(0, 5)));
    bridge.emit("data", "host-1", "files", fileOpen("transfer-1", bytes.byteLength, sha256));
    bridge.emit("data", "host-1", "files", chunk("transfer-1", 5, bytes.slice(5)));
    bridge.emit(
      "data",
      "host-1",
      "files",
      encodeTeamProtocolV2Frame({ version: 2, type: "file-complete", transferId: "transfer-1" }),
    );

    await expect(complete).resolves.toMatchObject({ transferId: "transfer-1", size: bytes.byteLength });
    await expect(transfers.consume("host-1", "transfer-1")).resolves.toMatchObject({ bytes });
    expect(bridge.sent.some((message) => isString(message.data) && message.data.includes('"receivedThrough":5'))).toBe(
      true,
    );
    await transfers.stop();
  });

  it("rejects a non-contiguous offset", async () => {
    const bridge = new FakeBridge();
    const transfers = new TeamWebRtcFileTransfer(bridge, await temporaryDirectory());
    const waiting = transfers.receive("host-1", "transfer-2");
    bridge.emit(
      "data",
      "host-1",
      "files",
      fileOpen("transfer-2", 4, createHash("sha256").update("test").digest("hex")),
    );
    bridge.emit("data", "host-1", "files", chunk("transfer-2", 2, new Uint8Array([1, 2])));
    await expect(waiting).rejects.toThrow("offset");
    await transfers.stop();
  });

  it("rejects a completed file with the wrong hash", async () => {
    const bridge = new FakeBridge();
    const transfers = new TeamWebRtcFileTransfer(bridge, await temporaryDirectory());
    const waiting = transfers.receive("host-1", "transfer-3");
    bridge.emit("data", "host-1", "files", fileOpen("transfer-3", 4, "0".repeat(64)));
    bridge.emit("data", "host-1", "files", chunk("transfer-3", 0, new TextEncoder().encode("test")));
    bridge.emit(
      "data",
      "host-1",
      "files",
      encodeTeamProtocolV2Frame({ version: 2, type: "file-complete", transferId: "transfer-3" }),
    );
    await expect(waiting).rejects.toThrow("hash");
    await transfers.stop();
  });

  it("keeps a malformed peer frame isolated from other hosts", async () => {
    const bridge = new FakeBridge();
    const transfers = new TeamWebRtcFileTransfer(bridge, await temporaryDirectory());
    const first = transfers.receive("host-1", "transfer-1");
    const second = transfers.receive("host-2", "transfer-2");
    bridge.emit(
      "data",
      "host-1",
      "files",
      fileOpen("transfer-1", 4, createHash("sha256").update("test").digest("hex")),
    );
    bridge.emit(
      "data",
      "host-2",
      "files",
      fileOpen("transfer-2", 4, createHash("sha256").update("safe").digest("hex")),
    );
    bridge.emit("data", "host-1", "files", chunk("transfer-1", 2, new Uint8Array([1, 2])));
    bridge.emit("data", "host-2", "files", chunk("transfer-2", 0, new TextEncoder().encode("safe")));
    bridge.emit(
      "data",
      "host-2",
      "files",
      encodeTeamProtocolV2Frame({ version: 2, type: "file-complete", transferId: "transfer-2" }),
    );

    await expect(first).rejects.toThrow("offset");
    await expect(second).resolves.toMatchObject({ peerId: "host-2", transferId: "transfer-2" });
    await transfers.stop();
  });

  it("keeps the transfer ID and resumes from the last acknowledged offset", async () => {
    const bridge = new ResumingBridge();
    const transfers = new TeamWebRtcFileTransfer(bridge, await temporaryDirectory());
    const bytes = new Uint8Array(2 * 1024 * 1024);
    bytes.fill(7);
    const sending = transfers.send("host-1", { name: "large.bin", mimeType: "application/octet-stream", bytes });
    bridge.emit("connected", "host-1");
    const transferId = await sending;

    expect(bridge.openTransferIds).toEqual([transferId, transferId]);
    expect(bridge.firstOffsetAfterReconnect).toBe(bridge.resumeAcknowledged);
    expect(bridge.acknowledged).toBe(bytes.byteLength);
    await transfers.stop();
  });

  it("releases quota for file declarations that make no progress", async () => {
    const bridge = new FakeBridge();
    const transfers = new TeamWebRtcFileTransfer(bridge, await temporaryDirectory(), 10);
    try {
      const maximumFileBytes = 100 * 1024 * 1024;
      bridge.emit("data", "host-1", "files", fileOpen("transfer-1", maximumFileBytes, "1".repeat(64)));
      bridge.emit("data", "host-1", "files", fileOpen("transfer-2", maximumFileBytes, "2".repeat(64)));
      bridge.emit("data", "host-1", "files", fileOpen("transfer-3", maximumFileBytes / 2, "3".repeat(64)));
      await vi.waitFor(() => expect(bridge.sent).toHaveLength(3));

      await new Promise((resolve) => setTimeout(resolve, 20));
      bridge.emit("data", "host-1", "files", fileOpen("transfer-4", maximumFileBytes, "4".repeat(64)));
      await vi.waitFor(() => expect(bridge.sent).toHaveLength(4));

      const last = bridge.sent.at(-1)?.data;
      expect(isString(last) ? decodeTeamProtocolV2FileControlFrame(last) : null).toMatchObject({
        type: "file-ack",
        transferId: "transfer-4",
        receivedThrough: 0,
      });
    } finally {
      await transfers.stop();
    }
  });
});

class ResumingBridge extends TeamWebRtcBridge {
  readonly openTransferIds: string[] = [];
  acknowledged = 0;
  resumeAcknowledged = 0;
  firstOffsetAfterReconnect: number | null = null;
  #transferId = "";
  #disconnected = false;

  async send(peerId: string, channel: string, data: string | ArrayBuffer): Promise<void> {
    if (channel !== "files") return;
    if (isString(data)) {
      const frame = decodeTeamProtocolV2FileControlFrame(data);
      if (frame.type === "file-open") {
        this.#transferId = frame.transferId;
        this.openTransferIds.push(frame.transferId);
        setTimeout(
          () =>
            this.emit(
              "data",
              peerId,
              "files",
              encodeTeamProtocolV2Frame({
                version: 2,
                type: "file-ack",
                transferId: frame.transferId,
                receivedThrough: this.acknowledged,
              }),
            ),
          0,
        );
      }
      return;
    }
    const chunk = decodeTeamProtocolV2FileChunk(data);
    if (this.#disconnected && this.firstOffsetAfterReconnect === null) this.firstOffsetAfterReconnect = chunk.offset;
    if (!this.#disconnected && this.acknowledged >= 1024 * 1024) {
      this.#disconnected = true;
      this.resumeAcknowledged = this.acknowledged;
      this.emit("disconnected", peerId);
      setTimeout(() => this.emit("connected", peerId), 5);
      throw new Error("simulated network change");
    }
    this.acknowledged = Math.max(this.acknowledged, chunk.offset + chunk.bytes.byteLength);
    if (this.#disconnected && chunk.bytes.byteLength < 60 * 1024) {
      this.emit(
        "data",
        peerId,
        "files",
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "file-ack",
          transferId: this.#transferId,
          receivedThrough: this.acknowledged,
        }),
      );
    }
    if (!this.#disconnected && this.acknowledged >= 1024 * 1024) {
      this.emit(
        "data",
        peerId,
        "files",
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "file-ack",
          transferId: this.#transferId,
          receivedThrough: this.acknowledged,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

function fileOpen(transferId: string, size: number, sha256: string): string {
  return encodeTeamProtocolV2Frame({
    version: 2,
    type: "file-open",
    transferId,
    name: "file.bin",
    size,
    mimeType: "application/octet-stream",
    sha256,
  });
}

function chunk(transferId: string, offset: number, bytes: Uint8Array): ArrayBuffer {
  const encoded = encodeTeamProtocolV2FileChunk({ transferId, offset, bytes });
  const result = new Uint8Array(encoded.byteLength);
  result.set(encoded);
  return result.buffer;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "openbot-webrtc-files-"));
  directories.push(path);
  return path;
}
