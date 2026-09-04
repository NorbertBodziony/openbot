// The user's list of remote servers: what is on disk, which one is active, and every write that
// changes either. Nothing outside this file may change persisted server state.
//
// That is a type, not a convention. `StoredRemoteServerView` is `Readonly`, so a caller that reaches
// for `server.name = ...` gets a compile error. Until 2026-09 there was no such view: the manager's
// `#requireServer` handed back a live element of the array this file writes, and six call sites
// mutated through it. They worked only because whichever `#persist()` happened to run next
// snapshotted the whole state -- so a mutation with no persist after it changed how the app behaved
// until some later, unrelated write, and nothing except reading both call sites could see that.
//
// Every method here that changes state also writes the file, with one named exception:
// `setActiveServerId` leaves the write to its caller, because selecting a server has to be able to
// roll the selection back when the write fails. That is why `persist` is public. Do not add a second
// exception -- a mutation whose write is somebody else's job is the hazard this module exists to end.

import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { TeamRole } from "@openbot/contracts/ipc";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import {
  emptyStoredRemoteServers,
  readStoredRemoteServers,
  type StoredRemoteServer,
  type StoredRemoteServers,
  serializeStoredRemoteServers,
} from "./remote-server-stored-shape";

export interface TokenCipher {
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
}

export type StoredRemoteServerView = Readonly<StoredRemoteServer>;

// The fields a running app is allowed to change on a server it already has. `id`, `apiUrl`,
// `fingerprint`, `publicKey` and `transport` are deliberately absent: those identify the host, and
// changing one silently would repoint a pinned identity at a different machine.
export interface RemoteServerPatch {
  name?: string;
  username?: string;
  role?: TeamRole;
  encryptedToken?: string;
  logoVersion?: string | null;
  remoteDesktopAvailable?: boolean;
}

// What a reader needs. Consumers that only look things up take this, not the class, so their tests
// do not need a disk.
export interface RemoteServerDirectory {
  readonly activeServerId: string;
  readonly servers: readonly StoredRemoteServerView[];
  require(serverId: string): StoredRemoteServerView;
  find(serverId: string): StoredRemoteServerView | null;
  has(serverId: string): boolean;
  token(server: StoredRemoteServerView): string;
}

export class RemoteServerStore implements RemoteServerDirectory {
  readonly #path: string;
  readonly #cipher: TokenCipher;
  #state: StoredRemoteServers = emptyStoredRemoteServers();
  #writeChain = Promise.resolve();
  #activeServerRevision = 0;

  constructor(options: { path: string; cipher: TokenCipher }) {
    this.#path = options.path;
    this.#cipher = options.cipher;
  }

  // A missing file is a first run. Anything else -- a permission error, a truncated read, a file that
  // is not JSON, a file this build cannot decode -- reaches the caller, because continuing would leave
  // an empty list that the next write replaces the user's servers with.
  async load(): Promise<void> {
    let contents: string | null = null;
    try {
      contents = await readFile(this.#path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (contents === null) return;
    const stored = readStoredRemoteServers(JSON.parse(contents));
    // Null means the *file* made no sense -- a `version` from a newer build, or no `servers` array at
    // all. An unreadable entry is not this: the reader drops it and returns the rest. Keeping the
    // empty default here would hand a file the newer build still reads to the next `persist()` to
    // overwrite, which is how a downgrade loses every joined server. The message quotes nothing from
    // the file; `encryptedToken` is in there.
    if (!stored) throw new Error("The remote server list is not in a format this version can read.");
    this.#state = stored;
  }

  get activeServerId(): string {
    return this.#state.activeServerId;
  }

  // Bumped by every selection. A selection that fails to persist only rolls back if no later
  // selection has happened in the meantime, and this is how the caller tells.
  get activeServerRevision(): number {
    return this.#activeServerRevision;
  }

  get servers(): readonly StoredRemoteServerView[] {
    return this.#state.servers;
  }

  require(serverId: string): StoredRemoteServerView {
    const server = this.find(serverId);
    if (!server) throw new Error("Remote server not found.");
    return server;
  }

  find(serverId: string): StoredRemoteServerView | null {
    return this.#state.servers.find((candidate) => candidate.id === serverId) ?? null;
  }

  has(serverId: string): boolean {
    return this.#state.servers.some((candidate) => candidate.id === serverId);
  }

  // A host the user removed while owning it. The account service keeps listing it, so without this
  // the next directory sync would put it straight back.
  isHiddenHost(hostId: string): boolean {
    return this.#state.hiddenHostIds.includes(hostId);
  }

  token(server: StoredRemoteServerView): string {
    return this.#cipher.decrypt(Buffer.from(server.encryptedToken, "base64"));
  }

  sealToken(sessionToken: string): string {
    return this.#cipher.encrypt(sessionToken).toString("base64");
  }

  // The one mutation that does not write. See the file header.
  setActiveServerId(serverId: string): number {
    // The user picking a server is the only thing that supersedes a selection this build could not
    // read. Until then the file keeps naming it, so a build that can read it finds them still there.
    this.#state.unreadableActiveServerId = null;
    this.#state.activeServerId = serverId;
    this.#activeServerRevision += 1;
    return this.#activeServerRevision;
  }

  // Adds a server the user just joined or signed in to, replacing any earlier entry with the same
  // id, and selects it -- the two halves of "the user is now on this server", written once.
  //
  // This is also the one path allowed to retire an entry the reader could not decode. Joining or
  // signing in verified the host's identity, so the new entry supersedes the old; a reconciliation
  // that happens to mint the same id did not, and `replaceServers` deliberately leaves it alone.
  async adopt(server: StoredRemoteServer): Promise<void> {
    this.#forgetUnreadable(server.id);
    this.#state.servers = [...this.#state.servers.filter((candidate) => candidate.id !== server.id), server];
    this.setActiveServerId(server.id);
    await this.persist();
  }

  // Returns the updated server so a caller that needs the new credentials for its next request does
  // not have to look them up again -- and null when the server is gone, which a live event can race.
  async update(serverId: string, patch: RemoteServerPatch): Promise<StoredRemoteServerView | null> {
    const current = this.find(serverId);
    if (!current) return null;
    const updated: StoredRemoteServer = { ...current, ...patch };
    this.#state.servers = this.#state.servers.map((candidate) => (candidate.id === serverId ? updated : candidate));
    await this.persist();
    return updated;
  }

  async remove(serverId: string, options: { hideHost?: boolean } = {}): Promise<void> {
    if (options.hideHost && !this.#state.hiddenHostIds.includes(serverId)) this.#state.hiddenHostIds.push(serverId);
    // The user asked for this server to be gone. That reaches an entry this build could not read as
    // well -- leaving it would put the server back the next time a build that understands it runs.
    this.#forgetUnreadable(serverId);
    this.#state.servers = this.#state.servers.filter((server) => server.id !== serverId);
    if (this.#state.activeServerId === serverId) this.setActiveServerId(LOCAL_SERVER_ID);
    await this.persist();
  }

  #forgetUnreadable(serverId: string): void {
    this.#state.unreadableServers = this.#state.unreadableServers.filter((entry) => entry.id !== serverId);
    if (this.#state.unreadableActiveServerId === serverId) this.#state.unreadableActiveServerId = null;
  }

  async unhideHost(hostId: string): Promise<void> {
    if (!this.isHiddenHost(hostId)) return;
    this.#state.hiddenHostIds = this.#state.hiddenHostIds.filter((candidate) => candidate !== hostId);
    await this.persist();
  }

  // Throws rather than repairing: an order that does not name every server exactly once came from a
  // renderer working off a stale list, and silently guessing at the rest would reorder the sidebar
  // under the user. Returns false when the order already matches, so the caller can skip its event.
  async reorder(serverIds: readonly string[]): Promise<boolean> {
    if (serverIds.length !== this.#state.servers.length) throw new Error("The server order is incomplete.");
    const serversById = new Map(this.#state.servers.map((server) => [server.id, server]));
    if (new Set(serverIds).size !== serverIds.length) throw new Error("The server order contains an unknown server.");
    const reordered: StoredRemoteServer[] = [];
    for (const serverId of serverIds) {
      const server = serversById.get(serverId);
      if (!server) throw new Error("The server order contains an unknown server.");
      reordered.push(server);
    }
    if (serverIds.every((serverId, index) => this.#state.servers[index]?.id === serverId)) return false;
    this.#state.servers = reordered;
    await this.persist();
    return true;
  }

  // The host directory owns the whole WebRTC half of the list, so it replaces it wholesale. If the
  // active server is not in the new list, selection falls back to the local server -- the same rule
  // `readStoredRemoteServers` applies to a file that lost an entry.
  async replaceServers(servers: readonly StoredRemoteServerView[]): Promise<void> {
    this.#state.servers = [...servers];
    if (this.#state.activeServerId !== LOCAL_SERVER_ID && !this.has(this.#state.activeServerId)) {
      this.setActiveServerId(LOCAL_SERVER_ID);
    }
    await this.persist();
  }

  // Snapshots before queueing, so a write that is still waiting behind an earlier one records the
  // state as it was when its caller asked, not as it is when the disk gets around to it. The
  // temporary file plus rename is what keeps a half-written `servers.json` from ever existing.
  async persist(): Promise<void> {
    const snapshot = structuredClone(this.#state);
    const operation = this.#writeChain.then(async () => {
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(serializeStoredRemoteServers(snapshot))}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, this.#path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.#writeChain = operation.catch(() => undefined);
    await operation;
  }
}
