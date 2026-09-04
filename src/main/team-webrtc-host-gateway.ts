import type { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { type IncomingConnection, TeamWebRtcHostPeer, type TeamWebRtcHostPeerOptions } from "./team-webrtc-host-peer";

interface TeamWebRtcHostGatewayOptions extends TeamWebRtcHostPeerOptions {
  renewSignal?: (hostId: string) => Promise<{ signalUrl: string; ticket: string }>;
  onSignalRecoveryFailure?: (error: Error) => void;
}

/** One Signal registration, with independently authenticated device connections. */
export class TeamWebRtcHostGateway {
  readonly #options: TeamWebRtcHostGatewayOptions;
  readonly #bridge: TeamWebRtcBridge;
  readonly #peers = new Map<string, TeamWebRtcHostPeer>();
  #hostId: string | null = null;
  #localApiPort: number | null = null;
  #signalRecovery: Promise<void> | null = null;

  constructor(options: TeamWebRtcHostGatewayOptions) {
    this.#options = options;
    this.#bridge = options.bridge;
    this.#bridge.on("incoming", this.#onIncoming);
    this.#bridge.on("disconnected", this.#onDisconnected);
    this.#bridge.on("error", this.#onError);
  }

  async start(input: { hostId: string; signalUrl: string; ticket: string; localApiPort: number }): Promise<void> {
    this.#hostId = input.hostId;
    this.#localApiPort = input.localApiPort;
    try {
      await this.#connectSignal(input.hostId, input.signalUrl, input.ticket);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const hostId = this.#hostId;
    this.#hostId = null;
    this.#localApiPort = null;
    this.#clearPeers();
    await this.#signalRecovery?.catch(() => undefined);
    if (hostId) await this.#bridge.disconnect(hostId);
  }

  async revokeSession(sessionId: string): Promise<void> {
    await Promise.all([...this.#peers.values()].map((peer) => peer.revokeSession(sessionId)));
  }

  dispose(): void {
    this.#hostId = null;
    this.#clearPeers();
    this.#bridge.off("incoming", this.#onIncoming);
    this.#bridge.off("disconnected", this.#onDisconnected);
    this.#bridge.off("error", this.#onError);
  }

  #clearPeers(): void {
    for (const peer of this.#peers.values()) peer.dispose();
    this.#peers.clear();
  }

  readonly #onIncoming = (peerId: string, connection: IncomingConnection): void => {
    if (connection.hostId !== this.#hostId || this.#localApiPort === null || peerId === this.#hostId) return;
    let peer = this.#peers.get(peerId);
    if (!peer) {
      peer = new TeamWebRtcHostPeer(this.#options, {
        peerId,
        hostId: connection.hostId,
        localApiPort: this.#localApiPort,
      });
      this.#peers.set(peerId, peer);
    }
    peer.incoming(connection);
  };

  readonly #onDisconnected = (peerId: string): void => {
    if (peerId === this.#hostId) this.#clearPeers();
    else {
      this.#peers.get(peerId)?.dispose();
      this.#peers.delete(peerId);
    }
  };

  readonly #onError = (peerId: string, code: string): void => {
    if (
      peerId !== this.#hostId ||
      !this.#options.renewSignal ||
      this.#signalRecovery ||
      (code !== "authentication_required" && code !== "session_revoked")
    )
      return;
    this.#signalRecovery = this.#recoverSignal(peerId)
      .catch((error) => {
        if (this.#hostId === peerId)
          this.#options.onSignalRecoveryFailure?.(
            error instanceof Error ? error : new Error("Remote Signal recovery failed."),
          );
      })
      .finally(() => {
        this.#signalRecovery = null;
      });
  };

  async #recoverSignal(hostId: string): Promise<void> {
    const bootstrap = await this.#options.renewSignal?.(hostId);
    if (!bootstrap || this.#hostId !== hostId) return;
    this.#clearPeers();
    await this.#bridge.disconnect(hostId).catch(() => undefined);
    if (this.#hostId !== hostId) return;
    await this.#connectSignal(hostId, bootstrap.signalUrl, bootstrap.ticket);
    if (this.#hostId !== hostId) await this.#bridge.disconnect(hostId).catch(() => undefined);
  }

  #connectSignal(peerId: string, signalUrl: string, token: string): Promise<void> {
    // Subscribe before connect: a fast local Signal can be ready before the
    // bridge command acknowledgement reaches main.
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#bridge.off("signalReady", onReady);
        this.#bridge.off("error", onError);
      };
      const onReady = (id: string) => {
        if (id !== peerId) return;
        cleanup();
        resolve();
      };
      const onError = (id: string, _code: string, message: string) => {
        if (id !== peerId) return;
        cleanup();
        reject(new Error(message));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("The Remote Signal connection timed out."));
      }, 30_000);
      this.#bridge.on("signalReady", onReady);
      this.#bridge.on("error", onError);
      void this.#bridge.connect({ peerId, signalUrl, token, peer: "host" }).catch((error) => {
        cleanup();
        reject(error);
      });
    });
  }
}
