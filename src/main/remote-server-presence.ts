// Who is online on a remote server, and what the app shows when it cannot ask.
//
// Presence arrives two ways -- pushed on the live channel, or pulled once when a view opens -- and
// the difference matters. A pushed snapshot is news, so it is cached *and* announced. A pulled one
// is an answer to a question somebody already asked, so it is cached and returned, never announced:
// announcing it would re-render every listener for a fetch one of them requested.
//
// The cache is also what makes a lost connection legible. `markOffline` does not clear it, because
// an empty roster and a roster of people who went offline look nothing alike to a user.

import type { TeamPresenceSnapshot } from "@openbot/contracts/ipc";

export interface RemotePresenceCacheOptions {
  // How to ask a server for its current roster. Injected so this file never names a route.
  fetchSnapshot: (serverId: string) => Promise<TeamPresenceSnapshot>;
  // Called only for snapshots the server volunteered.
  onSnapshot: (serverId: string, snapshot: TeamPresenceSnapshot) => void;
}

export class RemotePresenceCache {
  readonly #fetchSnapshot: RemotePresenceCacheOptions["fetchSnapshot"];
  readonly #onSnapshot: RemotePresenceCacheOptions["onSnapshot"];
  readonly #snapshots = new Map<string, TeamPresenceSnapshot>();

  constructor(options: RemotePresenceCacheOptions) {
    this.#fetchSnapshot = options.fetchSnapshot;
    this.#onSnapshot = options.onSnapshot;
  }

  get(serverId: string): TeamPresenceSnapshot {
    const cached = this.#snapshots.get(serverId);
    if (cached) return structuredClone(cached);
    return { serverId, members: [], updatedAt: new Date().toISOString() };
  }

  // A stale roster beats an error for a view that already had one, so a failed refresh falls back to
  // the cache and only throws when there is nothing to fall back to.
  async refresh(serverId: string): Promise<TeamPresenceSnapshot> {
    try {
      const snapshot = await this.#fetchSnapshot(serverId);
      this.#snapshots.set(serverId, snapshot);
      return structuredClone(snapshot);
    } catch (error) {
      const cached = this.#snapshots.get(serverId);
      if (cached) return structuredClone(cached);
      throw error;
    }
  }

  accept(serverId: string, snapshot: TeamPresenceSnapshot): void {
    this.#snapshots.set(serverId, snapshot);
    this.#onSnapshot(serverId, structuredClone(snapshot));
  }

  // Nothing tells us the roster changed when the connection drops, so the last one is rewritten as
  // everyone offline and nobody typing. A server we never heard from stays silent.
  markOffline(serverId: string): void {
    const current = this.#snapshots.get(serverId);
    if (!current) return;
    this.accept(serverId, {
      ...current,
      members: current.members.map((member) => ({
        ...member,
        online: false,
        typingBotId: null,
      })),
      updatedAt: new Date().toISOString(),
    });
  }

  forget(serverId: string): void {
    this.#snapshots.delete(serverId);
  }
}
