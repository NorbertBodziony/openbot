import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { RemoteDesktopIceServer } from "@openbot/contracts/ipc";
import { BrowserWindow, MessageChannelMain, type MessagePortMain } from "electron";
import { z } from "zod";

export type TeamWebRtcChannel = "rpc" | "events" | "files" | "desktop";

interface TeamWebRtcBridgeEvents {
  signalReady: [peerId: string];
  incoming: [
    peerId: string,
    connection: {
      connectionId: string;
      sessionId: string;
      userId: string;
      membershipId: string;
      role: "owner" | "admin" | "member";
      sessionExpiresAt: number;
    },
  ];
  connected: [peerId: string];
  disconnected: [peerId: string];
  data: [peerId: string, channel: TeamWebRtcChannel, data: string | ArrayBuffer];
  path: [peerId: string, path: "p2p" | "relay"];
  error: [peerId: string, code: string, message: string];
  iceServers: [peerId: string, servers: RemoteDesktopIceServer[]];
}

interface TeamWebRtcBridgeOptions {
  developmentUrl?: string | null;
  preloadPath?: string;
}

const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
const bridgeMessageSchema = z
  .object({
    type: z.string().optional(),
    commandId: z.string().optional(),
    peerId: z.string().optional(),
    channel: z.enum(["rpc", "events", "files", "desktop"]).optional(),
    data: z.union([z.string(), z.instanceof(ArrayBuffer)]).optional(),
    path: z.enum(["p2p", "relay"]).optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    connectionId: z.string().optional(),
    sessionId: z.string().optional(),
    userId: z.string().optional(),
    membershipId: z.string().optional(),
    role: z.enum(["owner", "admin", "member"]).optional(),
    sessionExpiresAt: z.number().int().positive().optional(),
    iceServers: z.array(iceServerSchema).optional(),
  })
  .loose();
type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

type BridgeCommand =
  | { type: "connect"; peerId: string; signalUrl: string; token: string; peer: "host" | "client" }
  | { type: "disconnect" | "restart-ice" | "close"; peerId: string }
  | { type: "send"; peerId: string; channel: TeamWebRtcChannel; data: string | ArrayBuffer };

export class TeamWebRtcBridge extends EventEmitter<TeamWebRtcBridgeEvents> {
  readonly #options: TeamWebRtcBridgeOptions;
  readonly #pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  #window: BrowserWindow | null = null;
  #port: MessagePortMain | null = null;
  #ready: Promise<void> | null = null;
  readonly #iceServers = new Map<string, RemoteDesktopIceServer[]>();

  constructor(options: TeamWebRtcBridgeOptions = {}) {
    super();
    this.#options = options;
  }

  start(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = this.#start();
    return this.#ready;
  }

  async connect(input: { peerId: string; signalUrl: string; token: string; peer: "host" | "client" }): Promise<void> {
    await this.start();
    await this.#command({ type: "connect", ...input });
  }

  async disconnect(peerId: string): Promise<void> {
    if (!this.#port) return;
    await this.#command({ type: "disconnect", peerId });
  }

  async send(peerId: string, channel: TeamWebRtcChannel, data: string | ArrayBuffer): Promise<void> {
    await this.start();
    await this.#command({ type: "send", peerId, channel, data });
  }

  async restartIce(peerId: string): Promise<void> {
    await this.#command({ type: "restart-ice", peerId });
  }

  getIceServers(peerId: string): RemoteDesktopIceServer[] {
    return structuredClone(this.#iceServers.get(peerId) ?? []);
  }

  async stop(): Promise<void> {
    if (this.#port) await this.#command({ type: "close", peerId: "all" }).catch(() => undefined);
    this.#port?.close();
    this.#port = null;
    this.#window?.destroy();
    this.#window = null;
    this.#ready = null;
    this.#iceServers.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The Team WebRTC bridge stopped."));
    }
    this.#pending.clear();
  }

  async #start(): Promise<void> {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: this.#options.preloadPath ?? join(__dirname, "../preload/teamWebrtc.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.#window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await (this.#options.developmentUrl
      ? window.loadURL(new URL("team-webrtc.html", `${this.#options.developmentUrl}/`).toString())
      : window.loadURL("openbot-app://app/team-webrtc.html"));
    const { port1, port2 } = new MessageChannelMain();
    this.#port = port1;
    port1.on("message", (event) => this.#handleMessage(bridgeMessageSchema.parse(event.data)));
    port1.start();
    const rendererReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The Team WebRTC bridge did not start.")), 10_000);
      const ready = (message: BridgeMessage) => {
        if (message.type !== "bridge-ready") return;
        clearTimeout(timer);
        port1.off("message", listener);
        resolve();
      };
      const listener = (event: { data: unknown }) => ready(bridgeMessageSchema.parse(event.data));
      port1.on("message", listener);
    });
    window.webContents.postMessage("openbot-team-webrtc-port", null, [port2]);
    await rendererReady;
  }

  #command(command: BridgeCommand): Promise<void> {
    const port = this.#port;
    if (!port) return Promise.reject(new Error("The Team WebRTC bridge is not ready."));
    const commandId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(commandId);
        reject(new Error(`The Team WebRTC ${command.type} command timed out.`));
      }, 15_000);
      this.#pending.set(commandId, { resolve, reject, timer });
      port.postMessage({ ...command, commandId });
    });
  }

  #handleMessage(message: BridgeMessage): void {
    if ((message.type === "command-complete" || message.type === "command-error") && message.commandId) {
      const pending = this.#pending.get(message.commandId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.commandId);
      if (message.type === "command-complete") pending.resolve();
      else pending.reject(new Error(message.message ?? "The Team WebRTC command failed."));
      return;
    }
    if (!message.peerId) return;
    if (
      message.type === "incoming-peer" &&
      message.connectionId &&
      message.sessionId &&
      message.userId &&
      message.membershipId &&
      message.role &&
      message.sessionExpiresAt
    ) {
      this.emit("incoming", message.peerId, {
        connectionId: message.connectionId,
        sessionId: message.sessionId,
        userId: message.userId,
        membershipId: message.membershipId,
        role: message.role,
        sessionExpiresAt: message.sessionExpiresAt,
      });
    } else if (message.type === "signal-ready") this.emit("signalReady", message.peerId);
    else if (message.type === "peer-connected") this.emit("connected", message.peerId);
    else if (message.type === "peer-disconnected") this.emit("disconnected", message.peerId);
    else if (message.type === "ice-path" && message.path) this.emit("path", message.peerId, message.path);
    else if (message.type === "ice-servers" && message.iceServers) {
      this.#iceServers.set(message.peerId, message.iceServers);
      this.emit("iceServers", message.peerId, structuredClone(message.iceServers));
    } else if (message.type === "data" && message.channel && message.data !== undefined)
      this.emit("data", message.peerId, message.channel, message.data);
    else if (message.type === "peer-error")
      this.emit("error", message.peerId, message.code ?? "webrtc_error", message.message ?? "WebRTC failed.");
  }
}
