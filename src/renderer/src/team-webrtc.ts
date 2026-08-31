import { isString } from "@openbot/contracts/runtime-values";
import { TEAM_PROTOCOL_V2_CHANNELS } from "@openbot/contracts/team-protocol/v2";
import { z } from "zod";

interface BridgeCommand {
  commandId: string;
  type: "connect" | "disconnect" | "send" | "restart-ice" | "close";
  peerId: string;
  signalUrl?: string;
  token?: string;
  peer?: "host" | "client";
  channel?: "rpc" | "events" | "files" | "desktop";
  data?: string | ArrayBuffer;
}

const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
const signalMessageSchema = z
  .object({
    type: z.string(),
    version: z.literal(1),
    connectionId: z.string().nullable().optional(),
    channel: z.enum(["team", "remote-desktop"]).optional(),
    sdp: z.string().optional(),
    candidate: z.string().optional(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    resumeToken: z.string().optional(),
    iceServers: z.array(iceServerSchema).optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    sessionId: z.string().optional(),
    userId: z.string().optional(),
    membershipId: z.string().optional(),
    role: z.enum(["owner", "admin", "member"]).optional(),
    sessionExpiresAt: z.number().int().positive().optional(),
  })
  .loose();
type SignalMessage = z.infer<typeof signalMessageSchema>;

type SignalClientMessage =
  | { type: "offer" | "answer"; version: 1; connectionId: string; channel: "team"; sdp: string }
  | {
      type: "ice-candidate";
      version: 1;
      connectionId: string;
      channel: "team";
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    }
  | { type: "turn-refresh"; version: 1; connectionId: string };

interface MainBridgeMessage {
  type: string;
  commandId?: string;
  peerId?: string;
  channel?: "rpc" | "events" | "files" | "desktop";
  data?: string | ArrayBuffer;
  path?: "p2p" | "relay";
  code?: string;
  message?: string;
  connectionId?: string | null;
  sessionId?: string;
  userId?: string;
  membershipId?: string;
  role?: "owner" | "admin" | "member";
  sessionExpiresAt?: number;
  iceServers?: RTCIceServer[];
}

interface PeerState {
  id: string;
  role: "host" | "client";
  signalUrl: string;
  token: string;
  resumeToken: string | null;
  socket: WebSocket | null;
  connectionId: string | null;
  peerConnection: RTCPeerConnection | null;
  iceServers: RTCIceServer[];
  channels: Partial<Record<"rpc" | "events" | "files" | "desktop", RTCDataChannel>>;
  reconnectAttempt: number;
  reconnectTimer: number | null;
  turnRefreshTimer: number | null;
  iceRestartPending: boolean;
  iceRestarting: boolean;
  signalChain: Promise<void>;
  closed: boolean;
}

declare global {
  interface Window {
    openbotTeamWebRtc: { receivePort(callback: (port: MessagePort) => void): void };
  }
}

const peers = new Map<string, PeerState>();
const dataChannelNames = ["rpc", "events", "files", "desktop"] as const;
let mainPort: MessagePort;

window.openbotTeamWebRtc.receivePort((port) => {
  mainPort = port;
  mainPort.onmessage = (event: MessageEvent<BridgeCommand>) => void handleCommand(event.data);
  mainPort.start();
  post({ type: "bridge-ready" });
});

async function handleCommand(command: BridgeCommand): Promise<void> {
  try {
    if (command.type === "connect") {
      if (!command.signalUrl || !command.token || !command.peer)
        throw new Error("The WebRTC connection command is invalid.");
      disconnect(command.peerId);
      const state: PeerState = {
        id: command.peerId,
        role: command.peer,
        signalUrl: command.signalUrl,
        token: command.token,
        resumeToken: null,
        socket: null,
        connectionId: null,
        peerConnection: null,
        iceServers: [],
        channels: {},
        reconnectAttempt: 0,
        reconnectTimer: null,
        turnRefreshTimer: null,
        iceRestartPending: false,
        iceRestarting: false,
        signalChain: Promise.resolve(),
        closed: false,
      };
      peers.set(state.id, state);
      connectSignal(state);
    } else if (command.type === "disconnect") {
      disconnect(command.peerId);
    } else if (command.type === "send") {
      const state = requirePeer(command.peerId);
      const channel = command.channel ? state.channels[command.channel] : null;
      if (channel?.readyState !== "open" || command.data === undefined)
        throw new Error("The WebRTC channel is not open.");
      await waitForWritableChannel(channel);
      const data = command.data;
      if (isString(data)) channel.send(data);
      else channel.send(data);
    } else if (command.type === "restart-ice") {
      await restartIce(requirePeer(command.peerId));
    } else if (command.type === "close") {
      for (const peerId of [...peers.keys()]) disconnect(peerId);
    }
    post({ type: "command-complete", commandId: command.commandId });
  } catch (error) {
    post({
      type: "command-error",
      commandId: command.commandId,
      message: error instanceof Error ? error.message : "The WebRTC command failed.",
    });
  }
}

function connectSignal(state: PeerState): void {
  if (state.closed || state.socket) return;
  const socket = new WebSocket(state.signalUrl);
  state.socket = socket;
  socket.addEventListener("open", () => {
    state.reconnectAttempt = 0;
    socket.send(
      JSON.stringify({ type: "hello", version: 1, peer: state.role, token: state.resumeToken ?? state.token }),
    );
  });
  socket.addEventListener("message", (event) => {
    if (!isString(event.data)) return;
    state.signalChain = state.signalChain
      .then(async () => {
        if (state.closed || state.socket !== socket) return;
        await handleSignal(state, signalMessageSchema.parse(JSON.parse(event.data)));
      })
      .catch((error) => failPeer(state, error));
  });
  socket.addEventListener("close", () => {
    if (state.socket === socket) state.socket = null;
    if (!state.closed) scheduleSignalReconnect(state);
  });
  socket.addEventListener("error", () => socket.close());
}

async function handleSignal(state: PeerState, message: SignalMessage): Promise<void> {
  if (message.type === "error") {
    post({
      type: "peer-error",
      peerId: state.id,
      code: message.code ?? "signal_error",
      message: message.message ?? "Signal failed.",
    });
    if (
      message.code === "session_revoked" ||
      message.code === "authentication_required" ||
      message.code === "permission_denied" ||
      message.code === "host_busy"
    ) {
      disconnect(state.id);
    }
    return;
  }
  if (message.type === "ready") {
    const shouldRestartWithRefreshedTurn = Boolean(
      message.iceServers && state.role === "client" && state.connectionId && state.peerConnection,
    );
    state.resumeToken = message.resumeToken ?? state.resumeToken;
    state.connectionId = message.connectionId ?? state.connectionId;
    state.iceServers = message.iceServers ?? state.iceServers;
    if (state.peerConnection)
      state.peerConnection.setConfiguration({ iceServers: state.iceServers, bundlePolicy: "max-bundle" });
    scheduleTurnRefresh(state);
    post({ type: "ice-servers", peerId: state.id, iceServers: state.iceServers });
    post({ type: "signal-ready", peerId: state.id });
    if (shouldRestartWithRefreshedTurn) state.iceRestartPending = true;
    if (state.iceRestartPending) await retryPendingIceRestart(state);
    if (state.role === "client" && state.connectionId && !state.peerConnection) {
      const connection = createPeerConnection(state, state.iceServers);
      createDataChannel(state, connection, "rpc");
      createDataChannel(state, connection, "events");
      createDataChannel(state, connection, "files");
      createDataChannel(state, connection, "desktop");
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      sendSignal(state, {
        type: "offer",
        version: 1,
        connectionId: state.connectionId,
        channel: "team",
        sdp: requiredDescriptionSdp(offer),
      });
    }
    return;
  }
  if (message.type === "peer-ready" && state.role === "host" && message.connectionId) {
    state.connectionId = message.connectionId;
    post({
      type: "incoming-peer",
      peerId: state.id,
      connectionId: message.connectionId,
      sessionId: message.sessionId,
      userId: message.userId,
      membershipId: message.membershipId,
      role: message.role,
      sessionExpiresAt: message.sessionExpiresAt,
    });
    if (!state.peerConnection) createPeerConnection(state, state.iceServers);
    return;
  }
  if (message.type === "disconnect" && message.connectionId === state.connectionId) {
    state.peerConnection?.close();
    state.peerConnection = null;
    state.connectionId = null;
    state.channels = {};
    post({ type: "peer-disconnected", peerId: state.id });
    return;
  }
  if (message.channel !== "team" || !message.connectionId || message.connectionId !== state.connectionId) return;
  if (message.type === "offer" && message.sdp) {
    const connection = state.peerConnection ?? createPeerConnection(state, state.iceServers);
    await connection.setRemoteDescription({ type: "offer", sdp: message.sdp });
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    sendSignal(state, {
      type: "answer",
      version: 1,
      connectionId: message.connectionId,
      channel: "team",
      sdp: requiredDescriptionSdp(answer),
    });
  } else if (message.type === "answer" && message.sdp) {
    await state.peerConnection?.setRemoteDescription({ type: "answer", sdp: message.sdp });
  } else if (message.type === "ice-candidate" && message.candidate) {
    await state.peerConnection?.addIceCandidate({
      candidate: message.candidate,
      sdpMid: message.sdpMid ?? null,
      sdpMLineIndex: message.sdpMLineIndex ?? null,
    });
  } else if (message.type === "ice-restart") {
    await restartIce(state);
  }
}

function createPeerConnection(state: PeerState, iceServers: RTCIceServer[]): RTCPeerConnection {
  const connection = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
  state.peerConnection = connection;
  connection.onicecandidate = (event) => {
    if (!event.candidate || !state.connectionId) return;
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
    const channel = channelKind(event.channel.label);
    if (channel) bindDataChannel(state, channel, event.channel);
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "connected") void reportSelectedPath(state, connection);
    if (connection.connectionState === "failed") {
      state.iceRestartPending = true;
      void retryPendingIceRestart(state);
    }
    if (connection.connectionState === "closed") post({ type: "peer-disconnected", peerId: state.id });
  };
  return connection;
}

function createDataChannel(
  state: PeerState,
  connection: RTCPeerConnection,
  channel: "rpc" | "events" | "files" | "desktop",
): void {
  const label = channel === "desktop" ? "openbot.remote-desktop.signal.v1" : TEAM_PROTOCOL_V2_CHANNELS[channel];
  bindDataChannel(state, channel, connection.createDataChannel(label, { ordered: true }));
}

function bindDataChannel(
  state: PeerState,
  kind: "rpc" | "events" | "files" | "desktop",
  channel: RTCDataChannel,
): void {
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 1024 * 1024;
  state.channels[kind] = channel;
  channel.onopen = () => {
    if (dataChannelNames.every((name) => state.channels[name]?.readyState === "open")) {
      post({ type: "peer-connected", peerId: state.id, connectionId: state.connectionId });
    }
  };
  channel.onmessage = (event) => post({ type: "data", peerId: state.id, channel: kind, data: event.data });
  channel.onerror = () =>
    post({ type: "peer-error", peerId: state.id, code: "data_channel_error", message: `${kind} channel failed.` });
}

function waitForWritableChannel(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= 4 * 1024 * 1024) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      channel.removeEventListener("bufferedamountlow", onLow);
      reject(new Error("The WebRTC channel stayed under backpressure."));
    }, 10_000);
    const onLow = () => {
      clearTimeout(timer);
      resolve();
    };
    channel.addEventListener("bufferedamountlow", onLow, { once: true });
  });
}

async function restartIce(state: PeerState): Promise<void> {
  const connection = state.peerConnection;
  if (!connection || !state.connectionId || state.role !== "client") return;
  connection.restartIce();
  const offer = await connection.createOffer({ iceRestart: true });
  await connection.setLocalDescription(offer);
  sendSignal(state, {
    type: "offer",
    version: 1,
    connectionId: state.connectionId,
    channel: "team",
    sdp: requiredDescriptionSdp(offer),
  });
}

async function retryPendingIceRestart(state: PeerState): Promise<void> {
  if (
    !state.iceRestartPending ||
    state.iceRestarting ||
    state.closed ||
    state.role !== "client" ||
    !state.peerConnection ||
    !state.connectionId ||
    state.socket?.readyState !== WebSocket.OPEN
  )
    return;
  state.iceRestarting = true;
  state.iceRestartPending = false;
  try {
    await restartIce(state);
  } catch {
    state.iceRestartPending = true;
  } finally {
    state.iceRestarting = false;
  }
}

function requiredDescriptionSdp(description: RTCSessionDescriptionInit): string {
  if (!isString(description.sdp)) throw new Error("WebRTC did not create a session description.");
  return description.sdp;
}

async function reportSelectedPath(state: PeerState, connection: RTCPeerConnection): Promise<void> {
  const stats = await connection.getStats();
  let path: "p2p" | "relay" = "p2p";
  for (const report of stats.values()) {
    if (report.type !== "candidate-pair" || report.state !== "succeeded" || !report.nominated) continue;
    const local = stats.get(report.localCandidateId);
    const remote = stats.get(report.remoteCandidateId);
    if (local?.candidateType === "relay" || remote?.candidateType === "relay") path = "relay";
    break;
  }
  post({ type: "ice-path", peerId: state.id, path });
}

function sendSignal(state: PeerState, message: SignalClientMessage): void {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) throw new Error("Signal is not connected.");
  state.socket.send(JSON.stringify(message));
}

function scheduleSignalReconnect(state: PeerState): void {
  if (state.reconnectTimer !== null) return;
  const delay = Math.min(30_000, 500 * 2 ** state.reconnectAttempt++);
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    connectSignal(state);
  }, delay);
}

function scheduleTurnRefresh(state: PeerState): void {
  if (state.turnRefreshTimer !== null) clearTimeout(state.turnRefreshTimer);
  state.turnRefreshTimer = window.setTimeout(() => {
    state.turnRefreshTimer = null;
    if (!state.connectionId || !state.socket || state.socket.readyState !== WebSocket.OPEN)
      return scheduleTurnRefresh(state);
    try {
      sendSignal(state, { type: "turn-refresh", version: 1, connectionId: state.connectionId });
    } catch {
      scheduleTurnRefresh(state);
    }
  }, 45 * 60_000);
}

function disconnect(peerId: string): void {
  const state = peers.get(peerId);
  if (!state) return;
  state.closed = true;
  if (state.reconnectTimer !== null) clearTimeout(state.reconnectTimer);
  if (state.turnRefreshTimer !== null) clearTimeout(state.turnRefreshTimer);
  if (state.connectionId && state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "disconnect", version: 1, connectionId: state.connectionId }));
  }
  state.socket?.close(1000, "Peer stopped");
  state.peerConnection?.close();
  peers.delete(peerId);
}

function failPeer(state: PeerState, error: unknown): void {
  post({
    type: "peer-error",
    peerId: state.id,
    code: "webrtc_error",
    message: error instanceof Error ? error.message : "WebRTC failed.",
  });
}

function requirePeer(peerId: string): PeerState {
  const state = peers.get(peerId);
  if (!state) throw new Error("The WebRTC peer does not exist.");
  return state;
}

function channelKind(label: string): "rpc" | "events" | "files" | "desktop" | null {
  if (label === TEAM_PROTOCOL_V2_CHANNELS.rpc) return "rpc";
  if (label === TEAM_PROTOCOL_V2_CHANNELS.events) return "events";
  if (label === TEAM_PROTOCOL_V2_CHANNELS.files) return "files";
  if (label === "openbot.remote-desktop.signal.v1") return "desktop";
  return null;
}

function post(message: MainBridgeMessage): void {
  mainPort.postMessage(message);
}
