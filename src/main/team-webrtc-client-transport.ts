import { EventEmitter } from "node:events";
import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import {
  decodeTeamProtocolV2EventFrame,
  decodeTeamProtocolV2Json,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2Frame,
  type TeamProtocolV2Json,
  type TeamProtocolV2RpcFrame,
} from "@openbot/contracts/team-protocol/v2";
import { decodeTeamProtocolV2CurrentEvent } from "@openbot/contracts/team-protocol/v2-adapter";
import type {
  RemoteConnectionBootstrap,
  RemoteHostSummary,
  RemoteInvitePreview,
  RemoteInviteRecord,
  RemoteMemberRecord,
} from "./central-auth-manager";
import type { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcFileTransfer } from "./team-webrtc-file-transfer";

interface TeamWebRtcClientTransportEvents {
  connected: [hostId: string];
  disconnected: [hostId: string];
  event: [hostId: string, event: AgentEvent | TeamRealtimeEvent];
  path: [hostId: string, path: "p2p" | "relay"];
  error: [hostId: string, code: string, message: string];
  desktopData: [hostId: string, data: string | ArrayBuffer];
}

interface TeamWebRtcClientTransportOptions {
  bridge: TeamWebRtcBridge;
  listHosts: () => Promise<RemoteHostSummary[]>;
  startSession: (hostId: string) => Promise<{ sessionId: string; hostId: string; expiresAt: number }>;
  issueTicket: (sessionId: string) => Promise<RemoteConnectionBootstrap>;
  endSession: (sessionId: string) => Promise<void>;
  createInvite: (
    hostId: string,
    input: { role: "admin" | "member"; email?: string },
  ) => Promise<{ inviteId: string; token: string; expiresAt: number }>;
  listInvites: (hostId: string) => Promise<RemoteInviteRecord[]>;
  previewInvite: (token: string) => Promise<RemoteInvitePreview>;
  acceptInvite: (token: string) => Promise<{ hostId: string; membershipId: string; role: "admin" | "member" }>;
  revokeInvite: (inviteId: string) => Promise<void>;
  listMembers: (hostId: string) => Promise<RemoteMemberRecord[]>;
  updateMember: (hostId: string, membershipId: string, role: "admin" | "member") => Promise<void>;
  removeMember: (hostId: string, membershipId: string) => Promise<void>;
  controlPlaneUrl: string;
  downloadHostLogo: (hostId: string, version: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  transferDirectory: string;
}

interface ActiveHost {
  sessionId: string;
  connected: boolean;
  connecting: Promise<void> | null;
}

export class TeamWebRtcClientTransport extends EventEmitter<TeamWebRtcClientTransportEvents> {
  readonly #options: TeamWebRtcClientTransportOptions;
  readonly #active = new Map<string, ActiveHost>();
  readonly #files: TeamWebRtcFileTransfer;
  readonly #pending = new Map<
    string,
    {
      hostId: string;
      resolve: (value: TeamProtocolV2Json) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #lastEventSequence = new Map<string, number>();

  constructor(options: TeamWebRtcClientTransportOptions) {
    super();
    this.#options = options;
    this.#files = new TeamWebRtcFileTransfer(options.bridge, options.transferDirectory);
    options.bridge.on("connected", this.#onConnected);
    options.bridge.on("disconnected", this.#onDisconnected);
    options.bridge.on("data", this.#onData);
    options.bridge.on("path", this.#onPath);
    options.bridge.on("error", this.#onError);
  }

  listHosts(): Promise<RemoteHostSummary[]> {
    return this.#options.listHosts();
  }

  get controlPlaneUrl(): string {
    return this.#options.controlPlaneUrl;
  }

  downloadHostLogo(hostId: string, version: string) {
    return this.#options.downloadHostLogo(hostId, version);
  }

  createInvite(hostId: string, input: { role: "admin" | "member"; email?: string }) {
    return this.#options.createInvite(hostId, input);
  }

  listInvites(hostId: string) {
    return this.#options.listInvites(hostId);
  }

  previewInvite(token: string) {
    return this.#options.previewInvite(token);
  }

  acceptInvite(token: string) {
    return this.#options.acceptInvite(token);
  }

  revokeInvite(inviteId: string) {
    return this.#options.revokeInvite(inviteId);
  }

  listMembers(hostId: string) {
    return this.#options.listMembers(hostId);
  }

  updateMember(hostId: string, membershipId: string, role: "admin" | "member") {
    return this.#options.updateMember(hostId, membershipId, role);
  }

  removeMember(hostId: string, membershipId: string) {
    return this.#options.removeMember(hostId, membershipId);
  }

  async sendDesktop(hostId: string, data: string | ArrayBuffer): Promise<void> {
    await this.#ensureConnected(hostId);
    await this.#options.bridge.send(hostId, "desktop", data);
  }

  connect(hostId: string): Promise<void> {
    return this.#ensureConnected(hostId);
  }

  async request(
    hostId: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<TeamProtocolV2Json> {
    return (await this.requestResponse(hostId, path, init)).body;
  }

  async requestResponse(
    hostId: string,
    path: string,
    init: { method?: string; body?: unknown; contentType?: string } = {},
  ): Promise<{
    status: number;
    body: TeamProtocolV2Json;
    file?: { bytes: Uint8Array; name: string; mimeType: string };
  }> {
    await this.#ensureConnected(hostId);
    const binary = binaryBody(init.body);
    const bodyTransferId = binary
      ? await this.#files.send(hostId, {
          name: "upload",
          mimeType: init.contentType ?? "application/octet-stream",
          bytes: binary,
        })
      : null;
    const requestId = crypto.randomUUID();
    const frame = encodeTeamProtocolV2Frame({
      version: 2,
      type: "request",
      requestId,
      operation: "http.request",
      payload: {
        method: (init.method ?? "GET").toUpperCase(),
        path,
        body: binary ? null : wireJson(init.body),
        ...(bodyTransferId ? { bodyTransferId } : {}),
        ...(init.contentType ? { contentType: init.contentType } : {}),
      },
    });
    const result = new Promise<TeamProtocolV2Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new TeamWebRtcRequestError(504, "remote_timeout", "The remote request timed out."));
      }, 30_000);
      this.#pending.set(requestId, { hostId, resolve, reject, timer });
    });
    try {
      await this.#options.bridge.send(hostId, "rpc", frame);
    } catch (error) {
      const pending = this.#pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error("The remote request failed."));
      }
    }
    const envelope = await result;
    if (!isDynamicRecord(envelope) || !isNumber(envelope.status) || !Object.hasOwn(envelope, "body")) {
      throw new TeamWebRtcRequestError(502, "protocol_error", "The host returned an invalid response.");
    }
    const fileRecord = isDynamicRecord(envelope.file) ? envelope.file : null;
    const file =
      fileRecord && isString(fileRecord.transferId)
        ? await this.#files.consume(hostId, fileRecord.transferId)
        : undefined;
    return { status: envelope.status, body: decodeTeamProtocolV2Json(envelope.body), ...(file ? { file } : {}) };
  }

  async disconnect(hostId: string): Promise<void> {
    const active = this.#active.get(hostId);
    this.#active.delete(hostId);
    await this.#options.bridge.disconnect(hostId);
    if (active) await this.#options.endSession(active.sessionId).catch(() => undefined);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.#active.keys()].map((hostId) => this.disconnect(hostId)));
    this.#options.bridge.off("connected", this.#onConnected);
    this.#options.bridge.off("disconnected", this.#onDisconnected);
    this.#options.bridge.off("data", this.#onData);
    this.#options.bridge.off("path", this.#onPath);
    this.#options.bridge.off("error", this.#onError);
    await this.#files.stop();
  }

  async #ensureConnected(hostId: string): Promise<void> {
    const current = this.#active.get(hostId);
    if (current?.connected) return;
    if (current?.connecting) return current.connecting;
    const operation = this.#connect(hostId, current?.sessionId || null).catch((error) => {
      this.#active.delete(hostId);
      throw error;
    });
    this.#active.set(hostId, { sessionId: current?.sessionId ?? "", connected: false, connecting: operation });
    return operation;
  }

  async #connect(hostId: string, existingSessionId: string | null): Promise<void> {
    let sessionId = existingSessionId;
    let startedNewSession = false;
    let bootstrap: RemoteConnectionBootstrap;
    try {
      if (!sessionId) {
        sessionId = (await this.#options.startSession(hostId)).sessionId;
        startedNewSession = true;
      }
      try {
        bootstrap = await this.#options.issueTicket(sessionId);
      } catch (error) {
        if (!existingSessionId) throw error;
        await this.#options.endSession(existingSessionId).catch(() => undefined);
        sessionId = (await this.#options.startSession(hostId)).sessionId;
        startedNewSession = true;
        bootstrap = await this.#options.issueTicket(sessionId);
      }
    } catch (error) {
      if (sessionId) await this.#options.endSession(sessionId).catch(() => undefined);
      throw error;
    }
    if (startedNewSession) this.#lastEventSequence.delete(hostId);
    const connected = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("connected", onConnected);
        this.off("error", onError);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("The WebRTC host did not connect."));
      }, 30_000);
      const onConnected = (connectedHostId: string) => {
        if (connectedHostId !== hostId) return;
        cleanup();
        resolve();
      };
      const onError = (failedHostId: string, _code: string, message: string) => {
        if (failedHostId !== hostId) return;
        cleanup();
        reject(new Error(message));
      };
      this.on("connected", onConnected);
      this.on("error", onError);
    });
    this.#active.set(hostId, { sessionId, connected: false, connecting: connected });
    try {
      await this.#options.bridge.connect({
        peerId: hostId,
        signalUrl: bootstrap.signalUrl,
        token: bootstrap.ticket,
        peer: "client",
      });
      await connected;
    } catch (error) {
      this.#active.delete(hostId);
      await this.#options.endSession(sessionId).catch(() => undefined);
      throw error;
    }
  }

  readonly #onConnected = (hostId: string): void => {
    const active = this.#active.get(hostId);
    if (active) {
      active.connected = true;
      active.connecting = null;
    }
    void this.#options.bridge.send(
      hostId,
      "events",
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "event-ack",
        throughSequence: this.#lastEventSequence.get(hostId) ?? 0,
      }),
    );
    this.emit("connected", hostId);
  };

  readonly #onDisconnected = (hostId: string): void => {
    const active = this.#active.get(hostId);
    if (active) active.connected = false;
    for (const [requestId, pending] of this.#pending) {
      if (pending.hostId !== hostId) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.reject(new TeamWebRtcRequestError(503, "remote_disconnected", "The WebRTC host disconnected."));
    }
    this.emit("disconnected", hostId);
  };

  readonly #onData = (
    hostId: string,
    channel: "rpc" | "events" | "files" | "desktop",
    data: string | ArrayBuffer,
  ): void => {
    if (channel === "desktop") {
      this.emit("desktopData", hostId, data);
      return;
    }
    if (!isString(data)) return;
    if (channel === "rpc") this.#handleRpc(hostId, data);
    else if (channel === "events") this.#handleEvent(hostId, data);
  };

  #handleRpc(hostId: string, data: string): void {
    let frame: TeamProtocolV2RpcFrame;
    try {
      frame = decodeTeamProtocolV2RpcFrame(data);
    } catch {
      this.emit("error", hostId, "protocol_error", "The host returned an invalid RPC frame.");
      return;
    }
    if (frame.type !== "response") return;
    const pending = this.#pending.get(frame.requestId);
    if (!pending || pending.hostId !== hostId) return;
    clearTimeout(pending.timer);
    this.#pending.delete(frame.requestId);
    if ("error" in frame) {
      pending.reject(new TeamWebRtcRequestError(frame.error.status ?? 500, frame.error.code, frame.error.message));
    } else pending.resolve(frame.result);
  }

  #handleEvent(hostId: string, data: string): void {
    try {
      const frame = decodeTeamProtocolV2EventFrame(data);
      if (frame.type !== "event") return;
      const lastSequence = this.#lastEventSequence.get(hostId) ?? 0;
      if (frame.sequence <= lastSequence) {
        void this.#options.bridge.send(
          hostId,
          "events",
          encodeTeamProtocolV2Frame({ version: 2, type: "event-ack", throughSequence: lastSequence }),
        );
        return;
      }
      if (frame.sequence !== lastSequence + 1) {
        this.emit("error", hostId, "protocol_error", "The host event sequence has a gap.");
        return;
      }
      const decoded = decodeTeamProtocolV2CurrentEvent(frame);
      if (decoded) this.emit("event", hostId, decoded);
      this.#lastEventSequence.set(hostId, frame.sequence);
      void this.#options.bridge.send(
        hostId,
        "events",
        encodeTeamProtocolV2Frame({ version: 2, type: "event-ack", throughSequence: frame.sequence }),
      );
    } catch {
      this.emit("error", hostId, "protocol_error", "The host returned an invalid event frame.");
    }
  }

  readonly #onPath = (hostId: string, path: "p2p" | "relay"): void => {
    this.emit("path", hostId, path);
  };
  readonly #onError = (hostId: string, code: string, message: string): void => {
    this.emit("error", hostId, code, message);
  };
}

export class TeamWebRtcRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function wireJson(value: unknown): TeamProtocolV2Json {
  if (value === undefined) return null;
  return decodeTeamProtocolV2Json(JSON.parse(JSON.stringify(value)));
}

function binaryBody(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}
