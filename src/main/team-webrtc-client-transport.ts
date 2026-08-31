import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import {
  decodeTeamProtocolV2AuthFrame,
  decodeTeamProtocolV2EventFrame,
  decodeTeamProtocolV2Json,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2Frame,
  type TeamProtocolV2AuthFrame,
  type TeamProtocolV2Json,
  type TeamProtocolV2RpcFrame,
  teamProtocolV2AuthenticationTranscript,
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

const REMOTE_REQUEST_TIMEOUT_MILLISECONDS = 10 * 60_000 + 30_000;

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
  issueTicket: (sessionId: string, clientPublicKey: string) => Promise<RemoteConnectionBootstrap>;
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
  updateMember: (hostId: string, membershipId: string, role: "admin" | "member", reactivate?: boolean) => Promise<void>;
  removeMember: (hostId: string, membershipId: string) => Promise<void>;
  getPrincipalId: () => string;
  controlPlaneUrl: string;
  downloadHostLogo: (hostId: string, version: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
  transferDirectory: string;
}

interface ActiveHost {
  sessionId: string;
  expiresAt: number;
  principalId: string;
  connected: boolean;
  connecting: Promise<void> | null;
  cancelled: boolean;
  expirationTimer: ReturnType<typeof setTimeout> | null;
  authentication: {
    ticket: string;
    clientPublicKey: string;
    clientPrivateKey: string;
    clientNonce: string;
    hostPublicKey: string;
    binding: { localFingerprint: string; remoteFingerprint: string } | null;
    started: boolean;
    completed: boolean;
    hostNonce: string | null;
  } | null;
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
  readonly #hostPublicKeys = new Map<string, string>();

  constructor(options: TeamWebRtcClientTransportOptions) {
    super();
    this.#options = options;
    this.#files = new TeamWebRtcFileTransfer(
      options.bridge,
      options.transferDirectory,
      undefined,
      (peerId) => this.#active.get(peerId)?.connected === true,
    );
    options.bridge.on("connected", this.#onConnected);
    options.bridge.on("disconnected", this.#onDisconnected);
    options.bridge.on("data", this.#onData);
    options.bridge.on("path", this.#onPath);
    options.bridge.on("error", this.#onError);
  }

  async listHosts(): Promise<RemoteHostSummary[]> {
    const hosts = await this.#options.listHosts();
    for (const host of hosts) {
      if (host.devicePublicKey && !this.#hostPublicKeys.has(host.hostId)) {
        this.#hostPublicKeys.set(host.hostId, host.devicePublicKey);
      }
    }
    return hosts;
  }

  pinHostKey(hostId: string, publicKey: string): void {
    this.#hostPublicKeys.set(hostId, publicKey);
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

  updateMember(hostId: string, membershipId: string, role: "admin" | "member", reactivate = false) {
    return this.#options.updateMember(hostId, membershipId, role, reactivate);
  }

  removeMember(hostId: string, membershipId: string) {
    return this.#options.removeMember(hostId, membershipId);
  }

  async sendDesktop(hostId: string, data: string | ArrayBuffer): Promise<void> {
    await this.#ensureConnected(hostId);
    await this.#options.bridge.send(hostId, "desktop", data);
  }

  async requestRuntimeSnapshot(hostId: string): Promise<void> {
    await this.#sendEventControl(hostId, { type: "runtime-snapshot-request" });
  }

  async setTyping(hostId: string, botId: string | null, typing: boolean): Promise<void> {
    await this.#sendEventControl(hostId, { type: "team-typing", botId, typing });
  }

  async setDirectTyping(hostId: string, recipientMemberId: string, typing: boolean): Promise<void> {
    await this.#sendEventControl(hostId, { type: "team-direct-typing", recipientMemberId, typing });
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
      }, REMOTE_REQUEST_TIMEOUT_MILLISECONDS);
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
    if (active) active.cancelled = true;
    if (active?.expirationTimer) clearTimeout(active.expirationTimer);
    this.#active.delete(hostId);
    this.#files.setPeerAuthenticated(hostId, false);
    let disconnectError: unknown;
    try {
      await this.#options.bridge.disconnect(hostId);
    } catch (error) {
      disconnectError = error;
    }
    if (active?.sessionId) await this.#options.endSession(active.sessionId).catch(() => undefined);
    if (disconnectError) throw disconnectError;
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.#active.keys()].map((hostId) => this.disconnect(hostId)));
    this.#options.bridge.off("connected", this.#onConnected);
    this.#options.bridge.off("disconnected", this.#onDisconnected);
    this.#options.bridge.off("data", this.#onData);
    this.#options.bridge.off("path", this.#onPath);
    this.#options.bridge.off("error", this.#onError);
    await this.#files.stop();
  }

  async #ensureConnected(hostId: string): Promise<void> {
    const principalId = this.#options.getPrincipalId();
    let current = this.#active.get(hostId);
    if (current?.expiresAt && current.expiresAt <= Date.now() + 30_000) {
      await this.disconnect(hostId);
      current = undefined;
    }
    if (current && current.principalId !== principalId) {
      await this.disconnect(hostId);
      current = undefined;
    }
    if (current?.connected) return;
    if (current?.connecting) return current.connecting;
    const active: ActiveHost = {
      sessionId: current?.sessionId ?? "",
      expiresAt: current?.expiresAt ?? 0,
      principalId,
      connected: false,
      connecting: null,
      cancelled: false,
      expirationTimer: null,
      authentication: null,
    };
    const operation = this.#connect(hostId, active, current?.sessionId || null).catch((error) => {
      if (this.#active.get(hostId) === active) this.#active.delete(hostId);
      throw error;
    });
    active.connecting = operation;
    this.#active.set(hostId, active);
    return operation;
  }

  async #connect(hostId: string, active: ActiveHost, existingSessionId: string | null): Promise<void> {
    let hostPublicKey = this.#hostPublicKeys.get(hostId);
    if (!hostPublicKey) {
      const host = (await this.listHosts()).find((candidate) => candidate.hostId === hostId);
      hostPublicKey = host?.devicePublicKey ?? undefined;
    }
    if (!hostPublicKey) throw new Error("The remote host does not have a pinned device key.");
    const clientKeys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    let sessionId = existingSessionId;
    let startedNewSession = false;
    let bootstrap: RemoteConnectionBootstrap;
    try {
      if (!sessionId) {
        const session = await this.#options.startSession(hostId);
        sessionId = session.sessionId;
        active.sessionId = sessionId;
        active.expiresAt = session.expiresAt;
        startedNewSession = true;
        await this.#assertCurrent(hostId, active, sessionId);
      }
      try {
        bootstrap = await this.#options.issueTicket(sessionId, clientKeys.publicKey);
        await this.#assertCurrent(hostId, active, sessionId);
      } catch (error) {
        if (!existingSessionId) throw error;
        await this.#options.endSession(existingSessionId).catch(() => undefined);
        const session = await this.#options.startSession(hostId);
        sessionId = session.sessionId;
        active.sessionId = sessionId;
        active.expiresAt = session.expiresAt;
        startedNewSession = true;
        await this.#assertCurrent(hostId, active, sessionId);
        bootstrap = await this.#options.issueTicket(sessionId, clientKeys.publicKey);
        await this.#assertCurrent(hostId, active, sessionId);
      }
    } catch (error) {
      if (sessionId) await this.#options.endSession(sessionId).catch(() => undefined);
      throw error;
    }
    if (startedNewSession) this.#lastEventSequence.delete(hostId);
    let cleanupConnectionWait: () => void = () => undefined;
    const connected = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("connected", onConnected);
        this.off("error", onError);
      };
      cleanupConnectionWait = cleanup;
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
    active.sessionId = sessionId;
    active.authentication = {
      ticket: bootstrap.ticket,
      clientPublicKey: clientKeys.publicKey,
      clientPrivateKey: clientKeys.privateKey,
      clientNonce: randomBytes(32).toString("base64url"),
      hostPublicKey,
      binding: null,
      started: false,
      completed: false,
      hostNonce: null,
    };
    try {
      await this.#options.bridge.connect({
        peerId: hostId,
        signalUrl: bootstrap.signalUrl,
        token: bootstrap.ticket,
        peer: "client",
      });
      await this.#assertCurrent(hostId, active, sessionId);
      await connected;
      this.#scheduleExpiration(hostId, active);
    } catch (error) {
      cleanupConnectionWait();
      if (this.#active.get(hostId) === active) this.#active.delete(hostId);
      await this.#options.bridge.disconnect(hostId).catch(() => undefined);
      await this.#options.endSession(sessionId).catch(() => undefined);
      throw error;
    }
  }

  async #assertCurrent(hostId: string, active: ActiveHost, sessionId: string): Promise<void> {
    if (!active.cancelled && this.#active.get(hostId) === active) return;
    await this.#options.bridge.disconnect(hostId).catch(() => undefined);
    await this.#options.endSession(sessionId).catch(() => undefined);
    throw new Error("The remote connection was cancelled.");
  }

  async #sendEventControl(
    hostId: string,
    control:
      | { type: "runtime-snapshot-request" }
      | { type: "team-typing"; botId: string | null; typing: boolean }
      | { type: "team-direct-typing"; recipientMemberId: string; typing: boolean },
  ): Promise<void> {
    await this.#ensureConnected(hostId);
    await this.#options.bridge.send(
      hostId,
      "events",
      encodeTeamProtocolV2Frame({ version: 2, type: "event-control", control }),
    );
  }

  #scheduleExpiration(hostId: string, active: ActiveHost): void {
    if (active.expirationTimer) clearTimeout(active.expirationTimer);
    if (!active.expiresAt) return;
    const delay = Math.max(0, active.expiresAt - Date.now() - 30_000);
    active.expirationTimer = setTimeout(() => {
      active.expirationTimer = null;
      if (this.#active.get(hostId) === active) void this.disconnect(hostId).catch(() => undefined);
    }, delay);
    active.expirationTimer.unref?.();
  }

  readonly #onConnected = (hostId: string, binding?: { localFingerprint: string; remoteFingerprint: string }): void => {
    const active = this.#active.get(hostId);
    if (!active || active.cancelled) {
      void this.#options.bridge.disconnect(hostId).catch(() => undefined);
      return;
    }
    const authentication = active.authentication;
    if (!binding) {
      this.#failProtocol(hostId, "The WebRTC channel binding is unavailable.");
      return;
    }
    if (!authentication || authentication.started) return;
    authentication.started = true;
    authentication.binding = binding;
    const transcript = teamProtocolV2AuthenticationTranscript({
      hostId,
      sessionId: active.sessionId,
      ticket: authentication.ticket,
      clientPublicKey: authentication.clientPublicKey,
      clientNonce: authentication.clientNonce,
      clientFingerprint: binding.localFingerprint,
      hostFingerprint: binding.remoteFingerprint,
    });
    void this.#options.bridge
      .send(
        hostId,
        "rpc",
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "auth-init",
          ticket: authentication.ticket,
          clientPublicKey: authentication.clientPublicKey,
          clientNonce: authentication.clientNonce,
          signature: sign(null, Buffer.from(transcript), authentication.clientPrivateKey).toString("base64url"),
        }),
      )
      .catch(() => this.#failProtocol(hostId, "The client authentication handshake failed."));
  };

  #finishConnected(hostId: string, active: ActiveHost): void {
    this.#files.setPeerAuthenticated(hostId, true);
    active.connected = true;
    active.connecting = null;
    this.#sendRecoverable(
      hostId,
      "events",
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "event-ack",
        throughSequence: this.#lastEventSequence.get(hostId) ?? 0,
      }),
    );
    this.emit("connected", hostId);
  }

  readonly #onDisconnected = (hostId: string): void => {
    this.#files.setPeerAuthenticated(hostId, false);
    const active = this.#active.get(hostId);
    if (active) active.connected = false;
    this.#lastEventSequence.delete(hostId);
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
    const active = this.#active.get(hostId);
    const authFrame = isString(data) && channel === "rpc" ? authenticationFrame(data) : null;
    if (!active?.connected && authFrame?.type !== "auth-ready" && authFrame?.type !== "auth-confirmed") {
      this.#failProtocol(hostId, "The host sent data before end-to-end authentication.");
      return;
    }
    if (channel === "desktop") {
      this.emit("desktopData", hostId, data);
      return;
    }
    if (!isString(data)) return;
    if (authFrame?.type === "auth-ready") void this.#handleAuthentication(hostId, authFrame);
    else if (authFrame?.type === "auth-confirmed") this.#handleAuthenticationConfirmation(hostId, authFrame);
    else if (channel === "rpc") this.#handleRpc(hostId, data);
    else if (channel === "events") this.#handleEvent(hostId, data);
  };

  async #handleAuthentication(
    hostId: string,
    frame: Extract<TeamProtocolV2AuthFrame, { type: "auth-ready" }>,
  ): Promise<void> {
    try {
      const active = this.#active.get(hostId);
      const authentication = active?.authentication;
      if (!active || !authentication?.binding || active.connected || authentication.completed) {
        throw new Error("Authentication is not pending.");
      }
      if (frame.clientNonce !== authentication.clientNonce) {
        throw new Error("The host authentication response does not match the request.");
      }
      const transcript = teamProtocolV2AuthenticationTranscript({
        hostId,
        sessionId: active.sessionId,
        ticket: authentication.ticket,
        clientPublicKey: authentication.clientPublicKey,
        clientNonce: authentication.clientNonce,
        hostNonce: frame.hostNonce,
        clientFingerprint: authentication.binding.localFingerprint,
        hostFingerprint: authentication.binding.remoteFingerprint,
      });
      if (
        !verify(null, Buffer.from(transcript), authentication.hostPublicKey, Buffer.from(frame.signature, "base64url"))
      ) {
        throw new Error("The host device signature is invalid.");
      }
      authentication.completed = true;
      authentication.hostNonce = frame.hostNonce;
      await this.#options.bridge.send(
        hostId,
        "rpc",
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "auth-complete",
          clientNonce: authentication.clientNonce,
          hostNonce: frame.hostNonce,
        }),
      );
    } catch {
      this.#failProtocol(hostId, "The host failed end-to-end authentication.");
    }
  }

  #handleAuthenticationConfirmation(
    hostId: string,
    frame: Extract<TeamProtocolV2AuthFrame, { type: "auth-confirmed" }>,
  ): void {
    const active = this.#active.get(hostId);
    const authentication = active?.authentication;
    if (
      !active ||
      !authentication?.completed ||
      active.connected ||
      frame.clientNonce !== authentication.clientNonce ||
      frame.hostNonce !== authentication.hostNonce
    ) {
      this.#failProtocol(hostId, "The host returned an invalid authentication confirmation.");
      return;
    }
    this.#finishConnected(hostId, active);
  }

  #handleRpc(hostId: string, data: string): void {
    let frame: TeamProtocolV2RpcFrame;
    try {
      frame = decodeTeamProtocolV2RpcFrame(data);
    } catch {
      this.#failProtocol(hostId, "The host returned an invalid RPC frame.");
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
      if (frame.type === "event-reset") {
        this.#lastEventSequence.set(hostId, frame.nextSequence - 1);
        this.#sendRecoverable(
          hostId,
          "events",
          encodeTeamProtocolV2Frame({ version: 2, type: "event-ack", throughSequence: frame.nextSequence - 1 }),
        );
        this.#sendRecoverable(
          hostId,
          "events",
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "event-control",
            control: { type: "runtime-snapshot-request" },
          }),
        );
        return;
      }
      if (frame.type !== "event") return;
      const lastSequence = this.#lastEventSequence.get(hostId) ?? 0;
      if (frame.sequence <= lastSequence) {
        this.#sendRecoverable(
          hostId,
          "events",
          encodeTeamProtocolV2Frame({ version: 2, type: "event-ack", throughSequence: lastSequence }),
        );
        return;
      }
      if (frame.sequence !== lastSequence + 1) {
        this.#failProtocol(hostId, "The host event sequence has a gap.");
        return;
      }
      const decoded = decodeTeamProtocolV2CurrentEvent(frame);
      if (decoded.status === "invalid") {
        this.#failProtocol(hostId, "The host returned a malformed known event.");
        return;
      }
      if (decoded.status === "known") this.emit("event", hostId, decoded.event);
      this.#lastEventSequence.set(hostId, frame.sequence);
      this.#sendRecoverable(
        hostId,
        "events",
        encodeTeamProtocolV2Frame({ version: 2, type: "event-ack", throughSequence: frame.sequence }),
      );
    } catch {
      this.#failProtocol(hostId, "The host returned an invalid event frame.");
    }
  }

  #failProtocol(hostId: string, message: string): void {
    this.#files.setPeerAuthenticated(hostId, false);
    const error = new TeamWebRtcRequestError(502, "protocol_error", message);
    for (const [requestId, pending] of this.#pending) {
      if (pending.hostId !== hostId) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.reject(error);
    }
    this.emit("error", hostId, error.code, error.message);
    void this.disconnect(hostId).catch(() => undefined);
  }

  readonly #onPath = (hostId: string, path: "p2p" | "relay"): void => {
    this.emit("path", hostId, path);
  };
  readonly #onError = (hostId: string, code: string, message: string): void => {
    this.emit("error", hostId, code, message);
  };

  #sendRecoverable(hostId: string, channel: "events", data: string): void {
    void this.#options.bridge.send(hostId, channel, data).catch(() => undefined);
  }
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

function authenticationFrame(data: string): TeamProtocolV2AuthFrame | null {
  try {
    return decodeTeamProtocolV2AuthFrame(data);
  } catch {
    return null;
  }
}

function binaryBody(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}
