import { EventEmitter } from "node:events";
import type { RemoteDesktopConnectInput, RemoteDesktopSession } from "@openbot/contracts/ipc";
import type { RemoteServerManager } from "./remote-server-manager";

interface RemoteDesktopEvents {
  changed: [sessions: RemoteDesktopSession[]];
}

export class RemoteDesktopManager extends EventEmitter<RemoteDesktopEvents> {
  readonly #servers: Pick<
    RemoteServerManager,
    "createRemoteDesktopSession" | "closeRemoteDesktopSession" | "selectRemoteDesktopDisplay"
  >;
  readonly #sessions = new Map<string, RemoteDesktopSession>();

  constructor(
    servers: Pick<
      RemoteServerManager,
      "createRemoteDesktopSession" | "closeRemoteDesktopSession" | "selectRemoteDesktopDisplay"
    >,
  ) {
    super();
    this.#servers = servers;
  }

  list(): RemoteDesktopSession[] {
    return [...this.#sessions.values()].map((session) => structuredClone(session));
  }

  async connect(input: RemoteDesktopConnectInput): Promise<RemoteDesktopSession> {
    const existing = [...this.#sessions.values()].find((session) => session.serverId === input.serverId);
    if (existing) return structuredClone(existing);
    const session = await this.#servers.createRemoteDesktopSession(input.serverId);
    this.#sessions.set(session.id, session);
    this.#emitChanged();
    return structuredClone(session);
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    this.#emitChanged();
    await this.#servers.closeRemoteDesktopSession(session.serverId, session.id).catch(() => undefined);
  }

  async selectDisplay(serverId: string, displayId: string): Promise<void> {
    await this.#servers.selectRemoteDesktopDisplay(serverId, displayId);
    for (const [id, session] of this.#sessions) {
      if (session.serverId !== serverId) continue;
      this.#sessions.set(id, { ...session, selectedDisplayId: displayId, phase: "connecting" });
    }
    this.#emitChanged();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((sessionId) => this.disconnect(sessionId)));
  }

  #emitChanged(): void {
    this.emit("changed", this.list());
  }
}
