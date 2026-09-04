import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import {
  decodeTeamProtocolV2AuthFrame,
  decodeTeamProtocolV2CurrentEvent,
  decodeTeamProtocolV2EventFrame,
  decodeTeamProtocolV2RpcFrame,
  decodeTeamProtocolV3WebRtcHttpResponse,
  encodeTeamProtocolV2Frame,
  encodeTeamProtocolV3WebRtcHttpRequest,
  TEAM_CURRENT_CAPABILITIES,
  TEAM_PROTOCOL_V2_CHANNELS,
  type TeamProtocolV2AuthFrame,
  type TeamProtocolV2Json,
  teamProtocolV2AuthenticationTranscript,
} from "@openbot/contracts/team-protocol";
import { createEd25519Identity, type Ed25519Identity, signEd25519, verifyEd25519Pem } from "./ed25519";
import { createTeamRequestId } from "./request-id";
import { encodeTeamWebRtcPayload, TeamWebRtcPayloadDecoder } from "./webrtc-framing";
export type RemoteTeamCommand =
  | { id: string; type: "connect"; hostId: string; hostPublicKey: string }
  | { id: string; type: "disconnect" }
  | { id: string; type: "request"; method: string; path: string; body: TeamProtocolV2Json };

export interface RemoteTeamBootstrapPayload {
  sessionId: string;
  expiresAt: number;
  signalUrl: string;
  ticket: string;
}

export interface RemoteTeamCommandResult {
  commandId: string;
  ok: boolean;
  status?: number;
  body?: TeamProtocolV2Json;
  error?: string;
}

/** Carries every outstanding command across the native/DOM bridge, keyed by request ID. */
export function createRemoteCommandMailbox(publish: (commands: RemoteTeamCommand[]) => void) {
  const pending = new Map<string, { command: RemoteTeamCommand; resolve: (result: RemoteTeamCommandResult) => void }>();
  let target: { hostId: string; hostPublicKey: string } | null = null;
  const cancel = () => {
    for (const [commandId, entry] of pending) {
      entry.resolve({ commandId, ok: false, error: "The server connection was replaced." });
    }
    pending.clear();
  };
  return {
    send(command: RemoteTeamCommand): Promise<RemoteTeamCommandResult> {
      if (command.type === "disconnect") {
        cancel();
        target = null;
      } else if (command.type === "connect") {
        if (target?.hostId !== command.hostId || target.hostPublicKey !== command.hostPublicKey) cancel();
        // A foreground refresh may reuse a healthy peer. Do not reject its live RPCs;
        // the peer itself rejects them if this turns out to require a reconnect.
        target = { hostId: command.hostId, hostPublicKey: command.hostPublicKey };
      }
      return new Promise((resolve) => {
        pending.set(command.id, { command, resolve });
        publish([...pending.values()].map((entry) => entry.command));
      });
    },
    receive(result: RemoteTeamCommandResult) {
      const entry = pending.get(result.commandId);
      if (!entry) return;
      pending.delete(result.commandId);
      entry.resolve(result);
      publish([...pending.values()].map((item) => item.command));
    },
    dispose: cancel,
  };
}

export interface RemoteTeamConnectionUpdate {
  hostId: string;
  state: "connecting" | "online" | "offline";
  message: string | null;
  resync?: boolean;
}

export interface RemoteTeamPeerActions {
  getBootstrap: (hostId: string, clientPublicKey: string) => Promise<RemoteTeamBootstrapPayload>;
  endSession: (sessionId: string) => Promise<void>;
  onConnectionUpdate: (update: RemoteTeamConnectionUpdate) => Promise<void>;
  onTeamEvent: (hostId: string, event: AgentEvent | TeamRealtimeEvent) => Promise<void>;
}
interface ActionsRef {
  current: RemoteTeamPeerActions;
}
type ChannelKind = "rpc" | "events" | "files" | "desktop";
type SignalClientMessage =
  | { type: "hello"; version: 1; peer: "client"; token: string }
  | { type: "offer"; version: 1; connectionId: string; channel: "team"; sdp: string }
  | {
      type: "ice-candidate";
      version: 1;
      connectionId: string;
      channel: "team";
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    }
  | { type: "turn-refresh"; version: 1; connectionId: string | null };

interface PendingRequest {
  method: string;
  path: string;
  resolve: (value: { status: number; body: TeamProtocolV2Json }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PeerState {
  generation: number;
  hostId: string;
  hostPublicKey: string;
  sessionId: string;
  ticket: string;
  resumeToken: string | null;
  signalUrl: string;
  socket: WebSocket | null;
  signalChain: Promise<void>;
  connectionId: string | null;
  connection: RTCPeerConnection | null;
  channels: Partial<Record<ChannelKind, RTCDataChannel>>;
  decoders: Partial<Record<ChannelKind, TeamWebRtcPayloadDecoder>>;
  channelChains: Partial<Record<ChannelKind, Promise<void>>>;
  identity: Ed25519Identity;
  clientPublicKey: string;
  clientNonce: string;
  hostNonce: string | null;
  binding: { clientFingerprint: string; hostFingerprint: string } | null;
  authenticated: boolean;
  closed: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  turnRefreshTimer: ReturnType<typeof setTimeout> | null;
  iceServers: RTCIceServer[];
  lastEventSequence: number;
  connectedResolve: (() => void) | null;
  connectedReject: ((error: Error) => void) | null;
  connectedTimer: ReturnType<typeof setTimeout> | null;
}

const CHANNELS: ChannelKind[] = ["rpc", "events", "files", "desktop"];
const REQUEST_TIMEOUT_MS = 10 * 60_000 + 30_000;

export function createRemoteTeamPeer(actions: ActionsRef) {
  let active = true;
  let peer: PeerState | null = null;
  let generation = 0;
  const pendingRequests = new Map<string, PendingRequest>();
  const closingSessions = new Map<string, Promise<void>>();

  return {
    execute: (command: RemoteTeamCommand) => executeCommand(command, actions),
    dispose: () => {
      active = false;
      return closePeer(actions.current.endSession);
    },
    setActive(value: boolean) {
      active = value;
      const state = peer;
      if (!state) return;
      if (!active) {
        if (state.reconnectTimer !== null) clearTimeout(state.reconnectTimer);
        if (state.turnRefreshTimer !== null) clearTimeout(state.turnRefreshTimer);
        state.reconnectTimer = null;
        state.turnRefreshTimer = null;
      } else {
        if (!isPeerOnline(state)) {
          failPeer(state, new Error("The desktop connection needs to be restored."), actions);
        } else {
          scheduleTurnRefresh(state);
          if (!state.socket) openSignal(state, actions);
        }
      }
    },
  };
  function isPeerOnline(state: PeerState): boolean {
    return (
      state.authenticated &&
      state.connection?.connectionState === "connected" &&
      CHANNELS.every((kind) => state.channels[kind]?.readyState === "open")
    );
  }
  async function executeCommand(command: RemoteTeamCommand, actions: ActionsRef): Promise<RemoteTeamCommandResult> {
    let commandGeneration = generation;
    try {
      if (command.type === "connect") {
        if (!active) throw new Error("The app is in the background.");
        if (
          peer &&
          isPeerOnline(peer) &&
          peer.hostId === command.hostId &&
          peer.hostPublicKey === command.hostPublicKey
        ) {
          return { commandId: command.id, ok: true };
        }
        // Tear down locally now; connectPeer only waits for this host's cleanup.
        void closePeer(actions.current.endSession);
        const connecting = connectPeer(command.hostId, command.hostPublicKey, actions);
        commandGeneration = generation;
        await connecting;
        return { commandId: command.id, ok: true };
      }
      if (command.type === "disconnect") {
        await closePeer(actions.current.endSession);
        return { commandId: command.id, ok: true };
      }
      const response = await request(command.method, command.path, command.body);
      return { commandId: command.id, ok: true, status: response.status, body: response.body };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The remote operation failed.";
      if (command.type === "connect" && commandGeneration === generation) {
        await actions.current.onConnectionUpdate({ hostId: command.hostId, state: "offline", message });
      }
      return {
        commandId: command.id,
        ok: false,
        error: message,
      };
    }
  }

  async function connectPeer(hostId: string, hostPublicKey: string, actions: ActionsRef): Promise<void> {
    if (!active) throw new Error("The app is in the background.");
    const currentGeneration = ++generation;
    await actions.current.onConnectionUpdate({ hostId, state: "connecting", message: null });
    const identity = await createEd25519Identity((size) => crypto.getRandomValues(new Uint8Array(size)));
    // The account API reuses an active logical session. A same-host bootstrap
    // must not race its revocation, even when failPeer already cleared `peer`.
    // Cleanup for a different host must never block switching servers.
    while (closingSessions.has(hostId)) await closingSessions.get(hostId);
    if (currentGeneration !== generation || !active) throw new Error("The connection was replaced.");
    const clientPublicKey = identity.publicKeyPem;
    const bootstrap = await actions.current.getBootstrap(hostId, clientPublicKey);
    if (currentGeneration !== generation || !active) {
      await actions.current.endSession(bootstrap.sessionId).catch(() => undefined);
      throw new Error("The connection was replaced.");
    }
    const state: PeerState = {
      generation: currentGeneration,
      hostId,
      hostPublicKey,
      sessionId: bootstrap.sessionId,
      ticket: bootstrap.ticket,
      resumeToken: null,
      signalUrl: bootstrap.signalUrl,
      socket: null,
      signalChain: Promise.resolve(),
      connectionId: null,
      connection: null,
      channels: {},
      decoders: {},
      channelChains: {},
      identity,
      clientPublicKey,
      clientNonce: randomBase64Url(32),
      hostNonce: null,
      binding: null,
      authenticated: false,
      closed: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      turnRefreshTimer: null,
      iceServers: [],
      lastEventSequence: 0,
      connectedResolve: null,
      connectedReject: null,
      connectedTimer: null,
    };
    peer = state;
    const connected = new Promise<void>((resolve, reject) => {
      state.connectedResolve = resolve;
      state.connectedReject = reject;
      state.connectedTimer = setTimeout(
        () => failPeer(state, new Error("The desktop did not connect."), actions),
        30_000,
      );
    });
    try {
      openSignal(state, actions);
    } catch (error) {
      failPeer(state, error, actions);
    }
    await connected;
  }

  function openSignal(state: PeerState, actions: ActionsRef): void {
    if (!active || state.closed || peer !== state || state.socket) return;
    const socket = new WebSocket(state.signalUrl);
    state.socket = socket;
    socket.onopen = () => {
      if (state.closed || peer !== state || state.socket !== socket) return;
      state.reconnectAttempt = 0;
      socket.send(
        JSON.stringify({ type: "hello", version: 1, peer: "client", token: state.resumeToken ?? state.ticket }),
      );
    };
    socket.onmessage = (event) => {
      if (!isString(event.data)) return;
      try {
        const message = JSON.parse(event.data);
        state.signalChain = state.signalChain
          .then(() => handleSignal(state, message, actions))
          .catch((error) => failPeer(state, error, actions));
      } catch (error) {
        failPeer(state, error, actions);
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (state.socket !== socket) return;
      state.socket = null;
      if (state.closed || peer !== state) return;
      scheduleReconnect(state, actions);
    };
  }

  async function handleSignal(state: PeerState, value: unknown, actions: ActionsRef): Promise<void> {
    if (state.closed || peer !== state) return;
    if (!isDynamicRecord(value) || value.version !== 1 || !isString(value.type)) {
      throw new Error("Signal returned an invalid message.");
    }
    if (value.type === "error") {
      throw new Error(isString(value.message) ? value.message : "Signal rejected the connection.");
    }
    if (value.type === "ready") {
      if (value.resumeToken !== undefined && !isString(value.resumeToken)) {
        throw new Error("Signal returned an incomplete connection.");
      }
      if (value.connectionId !== undefined && !isString(value.connectionId)) {
        throw new Error("Signal returned an incomplete connection.");
      }
      const nextIceServers = value.iceServers === undefined ? null : decodeIceServers(value.iceServers);
      if (value.iceServers !== undefined && !nextIceServers) {
        throw new Error("Signal returned an incomplete connection.");
      }
      state.resumeToken = isString(value.resumeToken) ? value.resumeToken : state.resumeToken;
      state.connectionId = isString(value.connectionId) ? value.connectionId : state.connectionId;
      state.iceServers = nextIceServers ?? state.iceServers;
      if (!state.connectionId || state.iceServers.length === 0)
        throw new Error("Signal returned an incomplete connection.");
      scheduleTurnRefresh(state);
      if (state.connection) {
        state.connection.setConfiguration({ iceServers: state.iceServers, bundlePolicy: "max-bundle" });
        if (nextIceServers) await restartIce(state);
      }
      if (!state.connection) {
        const connection = createPeerConnection(state, state.iceServers, actions);
        for (const kind of CHANNELS)
          bindChannel(state, kind, connection.createDataChannel(channelLabel(kind), { ordered: true }), actions);
        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);
        sendSignal(state, {
          type: "offer",
          version: 1,
          connectionId: state.connectionId,
          channel: "team",
          sdp: requiredSdp(offer),
        });
      }
      return;
    }
    if (value.type === "disconnect" && value.connectionId === state.connectionId) {
      failPeer(state, new Error("The desktop went offline."), actions);
      return;
    }
    if (value.channel !== "team" || value.connectionId !== state.connectionId) return;
    if (value.type === "answer" && isString(value.sdp)) {
      const previousFingerprint = state.binding?.hostFingerprint;
      const nextFingerprint = value.sdp
        .match(/^a=fingerprint:sha-256\s+([^\r\n]+)$/imu)?.[1]
        ?.trim()
        .toUpperCase();
      if (previousFingerprint && nextFingerprint !== previousFingerprint) {
        throw new Error("The desktop restarted. Reconnecting with a new authenticated session.");
      }
      await state.connection?.setRemoteDescription({ type: "answer", sdp: value.sdp });
    } else if (value.type === "ice-candidate" && isString(value.candidate)) {
      await state.connection?.addIceCandidate({
        candidate: value.candidate,
        sdpMid: isString(value.sdpMid) ? value.sdpMid : null,
        sdpMLineIndex: isNumber(value.sdpMLineIndex) ? value.sdpMLineIndex : null,
      });
    } else if (value.type === "ice-restart") {
      await restartIce(state);
    }
  }

  function createPeerConnection(state: PeerState, iceServers: RTCIceServer[], actions: ActionsRef): RTCPeerConnection {
    const connection = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    state.connection = connection;
    connection.onicecandidate = (event) => {
      if (!event.candidate || !state.connectionId || state.socket?.readyState !== WebSocket.OPEN) return;
      sendSignal(state, {
        type: "ice-candidate",
        version: 1,
        connectionId: state.connectionId,
        channel: "team",
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      });
    };
    connection.ondatachannel = (event) => {
      const kind = channelKind(event.channel.label);
      if (kind) bindChannel(state, kind, event.channel, actions);
    };
    connection.onconnectionstatechange = () => {
      if (state.connection !== connection) return;
      if (["disconnected", "failed", "closed"].includes(connection.connectionState)) {
        failPeer(state, new Error("The desktop went offline."), actions);
      }
    };
    return connection;
  }

  function bindChannel(state: PeerState, kind: ChannelKind, channel: RTCDataChannel, actions: ActionsRef): void {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 1024 * 1024;
    state.channels[kind] = channel;
    state.decoders[kind] = new TeamWebRtcPayloadDecoder();
    state.channelChains[kind] = Promise.resolve();
    channel.onopen = () => {
      if (CHANNELS.every((name) => state.channels[name]?.readyState === "open") && !state.binding) {
        void beginAuthentication(state).catch((error) => failPeer(state, error, actions));
      }
    };
    channel.onmessage = (event) => {
      const data = event.data;
      const previous = state.channelChains[kind] ?? Promise.resolve();
      state.channelChains[kind] = previous
        .then(async () => {
          if (!isString(data) && !(data instanceof ArrayBuffer)) {
            throw new Error("The host sent unsupported binary data.");
          }
          const decoded = state.decoders[kind]?.push(data);
          if (decoded !== undefined) await handleChannelData(state, kind, decoded, actions);
        })
        .catch((error) => failPeer(state, error, actions));
    };
    channel.onerror = () => failPeer(state, new Error(`${kind} channel failed.`), actions);
    channel.onclose = () => {
      if (state.authenticated) failPeer(state, new Error("The desktop went offline."), actions);
    };
  }

  async function beginAuthentication(state: PeerState): Promise<void> {
    const binding = {
      clientFingerprint: descriptionFingerprint(state.connection?.localDescription ?? null),
      hostFingerprint: descriptionFingerprint(state.connection?.remoteDescription ?? null),
    };
    state.binding = binding;
    const transcript = teamProtocolV2AuthenticationTranscript({
      hostId: state.hostId,
      sessionId: state.sessionId,
      ticket: state.ticket,
      clientPublicKey: state.clientPublicKey,
      clientNonce: state.clientNonce,
      clientFingerprint: binding.clientFingerprint,
      hostFingerprint: binding.hostFingerprint,
    });
    const signature = await signEd25519(new TextEncoder().encode(transcript), state.identity.secretKey);
    await sendPayload(
      state,
      "rpc",
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "auth-init",
        ticket: state.ticket,
        clientPublicKey: state.clientPublicKey,
        clientNonce: state.clientNonce,
        signature: bytesToBase64Url(signature),
      }),
    );
  }

  async function handleChannelData(
    state: PeerState,
    kind: ChannelKind,
    data: string | ArrayBuffer,
    actions: ActionsRef,
  ): Promise<void> {
    if (state.closed || peer !== state) return;
    if (!isString(data)) return;
    if (kind === "rpc" && !state.authenticated) {
      await handleAuthenticationFrame(state, decodeTeamProtocolV2AuthFrame(data), actions);
      return;
    }
    if (!state.authenticated) throw new Error("The host sent data before authentication.");
    if (kind === "rpc") {
      const frame = decodeTeamProtocolV2RpcFrame(data);
      if (frame.type !== "response") throw new Error("The host returned an invalid RPC frame.");
      const pending = pendingRequests.get(frame.requestId);
      if (!pending) return;
      if ("error" in frame) pending.reject(new Error(frame.error.message));
      else if (!isDynamicRecord(frame.result) || !isNumber(frame.result.status) || !("body" in frame.result)) {
        pending.reject(new Error("The host returned an invalid response."));
      } else {
        pending.resolve({
          status: frame.result.status,
          body: decodeTeamProtocolV3WebRtcHttpResponse(
            pending.method,
            pending.path,
            frame.result.status,
            frame.result.body,
          ),
        });
      }
      // Keep the request registered until decoding succeeds, so failPeer can
      // reject the caller if a malformed response tears down the connection.
      clearTimeout(pending.timer);
      pendingRequests.delete(frame.requestId);
      return;
    }
    if (kind !== "events") return;
    const frame = decodeTeamProtocolV2EventFrame(data);
    if (frame.type === "event-reset") {
      state.lastEventSequence = frame.nextSequence - 1;
      await actions.current.onConnectionUpdate({
        hostId: state.hostId,
        state: "online",
        message: null,
        resync: true,
      });
      await sendEventAck(state);
      return;
    }
    if (frame.type !== "event") throw new Error("The host returned an invalid event frame.");
    if (frame.sequence <= state.lastEventSequence) {
      await sendEventAck(state);
      return;
    }
    if (frame.sequence !== state.lastEventSequence + 1) throw new Error("The host event stream has a gap.");
    const decoded = decodeTeamProtocolV2CurrentEvent(frame);
    if (decoded.status === "invalid") throw new Error("The host returned a malformed event.");
    state.lastEventSequence = frame.sequence;
    if (decoded.status === "known") await actions.current.onTeamEvent(state.hostId, decoded.event);
    await sendEventAck(state);
  }

  async function handleAuthenticationFrame(
    state: PeerState,
    frame: TeamProtocolV2AuthFrame,
    actions: ActionsRef,
  ): Promise<void> {
    if (frame.type === "auth-ready") {
      if (!state.binding || frame.clientNonce !== state.clientNonce)
        throw new Error("Host authentication did not match.");
      const transcript = teamProtocolV2AuthenticationTranscript({
        hostId: state.hostId,
        sessionId: state.sessionId,
        ticket: state.ticket,
        clientPublicKey: state.clientPublicKey,
        clientNonce: state.clientNonce,
        hostNonce: frame.hostNonce,
        clientFingerprint: state.binding.clientFingerprint,
        hostFingerprint: state.binding.hostFingerprint,
      });
      const valid = await verifyEd25519Pem(
        base64UrlToBytes(frame.signature),
        new TextEncoder().encode(transcript),
        state.hostPublicKey,
      );
      if (state.closed || peer !== state) return;
      if (!valid) throw new Error("The desktop identity could not be verified.");
      state.hostNonce = frame.hostNonce;
      await sendPayload(
        state,
        "rpc",
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "auth-complete",
          clientNonce: state.clientNonce,
          hostNonce: frame.hostNonce,
        }),
      );
      return;
    }
    if (
      frame.type !== "auth-confirmed" ||
      frame.clientNonce !== state.clientNonce ||
      frame.hostNonce !== state.hostNonce
    ) {
      throw new Error("The desktop returned an invalid authentication confirmation.");
    }
    state.authenticated = true;
    settleConnected(state);
    await sendEventAck(state);
    await actions.current.onConnectionUpdate({ hostId: state.hostId, state: "online", message: null });
  }

  async function request(method: string, path: string, body: TeamProtocolV2Json) {
    const state = peer;
    if (!state || !isPeerOnline(state)) throw new Error("The selected server is offline.");
    const requestId = createTeamRequestId((size) => crypto.getRandomValues(new Uint8Array(size)));
    const result = new Promise<{ status: number; body: TeamProtocolV2Json }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error("The desktop request timed out."));
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(requestId, { method, path, resolve, reject, timer });
    });
    void sendPayload(
      state,
      "rpc",
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "request",
        requestId,
        operation: "http.request",
        payload: {
          method,
          path,
          body: encodeTeamProtocolV3WebRtcHttpRequest(method, path, body, { preserveSemanticTags: true }),
          capabilities: [...TEAM_CURRENT_CAPABILITIES],
        },
      }),
    ).catch((error) => {
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error("The request could not be sent."));
    });
    return result;
  }

  async function sendEventAck(state: PeerState): Promise<void> {
    await sendPayload(
      state,
      "events",
      encodeTeamProtocolV2Frame({ version: 2, type: "event-ack", throughSequence: state.lastEventSequence }),
    );
  }

  async function sendPayload(state: PeerState, kind: ChannelKind, data: string | ArrayBuffer): Promise<void> {
    const channel = state.channels[kind];
    if (channel?.readyState !== "open") throw new Error("The WebRTC channel is not open.");
    const maximumMessageSize = state.connection?.sctp?.maxMessageSize ?? Number.POSITIVE_INFINITY;
    for (const frame of encodeTeamWebRtcPayload(data, maximumMessageSize)) {
      await waitForWritable(channel);
      if (frame instanceof ArrayBuffer) channel.send(frame);
      else channel.send(frame);
    }
  }

  function waitForWritable(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= 4 * 1024 * 1024) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.removeEventListener("bufferedamountlow", onLow);
        reject(new Error("The WebRTC channel stayed under backpressure."));
      }, 60_000);
      const onLow = () => {
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", onLow);
    });
  }

  async function restartIce(state: PeerState): Promise<void> {
    const connection = state.connection;
    if (!connection || !state.connectionId) return;
    connection.restartIce();
    const offer = await connection.createOffer({ iceRestart: true });
    await connection.setLocalDescription(offer);
    sendSignal(state, {
      type: "offer",
      version: 1,
      connectionId: state.connectionId,
      channel: "team",
      sdp: requiredSdp(offer),
    });
  }

  function sendSignal(state: PeerState, message: SignalClientMessage): void {
    if (state.socket?.readyState !== WebSocket.OPEN) throw new Error("Signal is offline.");
    state.socket.send(JSON.stringify(message));
  }

  function scheduleReconnect(state: PeerState, actions: ActionsRef): void {
    if (!active || state.reconnectTimer !== null) return;
    // A signaling-only interruption can resume inside Signal's grace window while
    // the data channels stay online. Offline peers use the one-minute recovery cadence.
    const delay = isPeerOnline(state) ? Math.min(30_000, 500 * 2 ** state.reconnectAttempt++) : 60_000;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      openSignal(state, actions);
    }, delay);
  }

  function scheduleTurnRefresh(state: PeerState): void {
    if (!active || state.closed || peer !== state) return;
    if (state.turnRefreshTimer !== null) clearTimeout(state.turnRefreshTimer);
    state.turnRefreshTimer = setTimeout(() => {
      state.turnRefreshTimer = null;
      if (state.socket?.readyState === WebSocket.OPEN) {
        try {
          sendSignal(state, { type: "turn-refresh", version: 1, connectionId: state.connectionId });
        } catch {
          // The reconnect path will request fresh TURN credentials.
        }
      }
      scheduleTurnRefresh(state);
    }, 45 * 60_000);
  }

  function failPeer(state: PeerState, error: unknown, actions: ActionsRef): void {
    if (state.closed || peer !== state) return;
    const message = error instanceof Error ? error.message : "The WebRTC connection failed.";
    rejectConnection(state, new Error(message));
    void actions.current.onConnectionUpdate({ hostId: state.hostId, state: "offline", message });
    void closePeer(actions.current.endSession);
  }

  async function closePeer(endSession: (sessionId: string) => Promise<void>): Promise<void> {
    const state = peer;
    peer = null;
    generation += 1;
    if (!state) return;
    state.closed = true;
    if (state.reconnectTimer !== null) clearTimeout(state.reconnectTimer);
    if (state.turnRefreshTimer !== null) clearTimeout(state.turnRefreshTimer);
    if (state.connectedTimer !== null) clearTimeout(state.connectedTimer);
    state.socket?.close();
    state.connection?.close();
    for (const decoder of Object.values(state.decoders)) decoder?.reset();
    state.channelChains = {};
    for (const [requestId, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      pending.reject(new Error("The server disconnected."));
    }
    rejectConnection(state, new Error("The server disconnected."));
    const cleanup = (closingSessions.get(state.hostId) ?? Promise.resolve())
      .then(() => endSession(state.sessionId))
      .catch(() => undefined);
    closingSessions.set(state.hostId, cleanup);
    try {
      await cleanup;
    } finally {
      if (closingSessions.get(state.hostId) === cleanup) closingSessions.delete(state.hostId);
    }
  }

  function settleConnected(state: PeerState): void {
    if (state.connectedTimer !== null) clearTimeout(state.connectedTimer);
    state.connectedTimer = null;
    state.connectedResolve?.();
    state.connectedResolve = null;
    state.connectedReject = null;
  }

  function rejectConnection(state: PeerState, error: Error): void {
    if (state.connectedTimer !== null) clearTimeout(state.connectedTimer);
    state.connectedTimer = null;
    state.connectedReject?.(error);
    state.connectedResolve = null;
    state.connectedReject = null;
  }

  function channelLabel(kind: ChannelKind): string {
    if (kind === "desktop") return "openbot.remote-desktop.signal.v1";
    return TEAM_PROTOCOL_V2_CHANNELS[kind];
  }

  function channelKind(label: string): ChannelKind | null {
    if (label === TEAM_PROTOCOL_V2_CHANNELS.rpc) return "rpc";
    if (label === TEAM_PROTOCOL_V2_CHANNELS.events) return "events";
    if (label === TEAM_PROTOCOL_V2_CHANNELS.files) return "files";
    if (label === "openbot.remote-desktop.signal.v1") return "desktop";
    return null;
  }

  function descriptionFingerprint(description: RTCSessionDescription | null): string {
    const fingerprint = description?.sdp.match(/^a=fingerprint:sha-256\s+([^\r\n]+)$/imu)?.[1]?.trim();
    if (!fingerprint) throw new Error("The WebRTC channel binding is unavailable.");
    return fingerprint.toUpperCase();
  }

  function requiredSdp(description: RTCSessionDescriptionInit): string {
    if (!description.sdp) throw new Error("WebRTC did not create a session description.");
    return description.sdp;
  }

  function randomBase64Url(size: number): string {
    return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(size)));
  }

  function bytesToBase64Url(bytes: Uint8Array): string {
    return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  }

  function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    return base64ToBytes(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function decodeIceServers(value: unknown): RTCIceServer[] | null {
    if (!Array.isArray(value)) return null;
    const result: RTCIceServer[] = [];
    for (const candidate of value) {
      if (!isDynamicRecord(candidate)) return null;
      const urls = candidate.urls;
      if (!isString(urls) && !(Array.isArray(urls) && urls.every(isString))) return null;
      if (candidate.username !== undefined && !isString(candidate.username)) return null;
      if (candidate.credential !== undefined && !isString(candidate.credential)) return null;
      result.push({
        urls,
        ...(isString(candidate.username) ? { username: candidate.username } : {}),
        ...(isString(candidate.credential) ? { credential: candidate.credential } : {}),
      });
    }
    return result;
  }
}
