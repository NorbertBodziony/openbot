// The shape of `servers.json` on the user's disk, and how a file written by an older build is read.
//
// This is persisted user state with no backup: nothing copies the file before an upgrade, and the
// first write after a read replaces it. So a read that cannot make sense of one part must give back
// everything else rather than nothing -- see `readStoredRemoteServers`. `src/backend/AGENTS.md` states
// the same rule for the database; the reasoning is identical and the file is smaller.
//
// "Everything else" includes the part it could not read. An entry this build rejects is carried in
// `unreadableServers` and written back into `servers` untouched, so the file keeps every entry it
// arrived with. Dropping one would be the same data loss one step later: a server with an intact
// token and a single field this build does not recognise -- written by a newer build, or by a hand
// edit -- would vanish on the next write, and the build that understands it would never see it
// again. This build refuses to *use* such an entry. It does not get to delete it, and neither does
// anything downstream of a *reconciliation*: only the user removing the server, or joining one with
// the same id, retires a preserved entry. `RemoteServerStore` owns both of those and nothing else.
//
// The same applies to the selection. If the active server is a preserved entry, this build cannot
// select it, so it runs on the local server -- but the id stays in the file, so the build that can
// read the entry still finds the user on it.
//
// Versions 1 and 2 differ from 3 only in fields this reader already treats as optional, so an upgrade
// is a re-tag. A version this build does not know is refused outright: it was written by a newer
// OpenBot, and guessing at it would replace a file that build can still read.

import type { TeamRole } from "@openbot/contracts/ipc";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";

export interface StoredRemoteServer {
  id: string;
  name: string;
  apiUrl: string;
  fingerprint: string;
  publicKey?: string;
  username: string;
  encryptedToken: string;
  remoteDesktopAvailable: boolean;
  logoVersion?: string | null;
  role: TeamRole;
  transport?: "webrtc-v2";
}

// An entry this build cannot read, and where it sat in `servers`.
export interface PreservedRemoteServer {
  index: number;
  entry: DynamicRecord;
}

export interface StoredRemoteServers {
  version: 3;
  activeServerId: string;
  servers: StoredRemoteServer[];
  hiddenHostIds: string[];
  // Entries kept verbatim for whoever can read them, each with the slot it occupied. In memory only:
  // `serializeStoredRemoteServers` puts them back in `servers`, because a key of its own would be
  // invisible to the older build that is the whole reason for keeping them -- and puts them back
  // where they were, because `servers` order is the sidebar order the user arranged.
  unreadableServers: PreservedRemoteServer[];
  // The selection this build had to fall back from, for the same reason and by the same trick: it is
  // written as `activeServerId` while `activeServerId` above -- the one the app runs on -- stays
  // local. Null once the user picks a server themselves, which is the only thing that supersedes it.
  unreadableActiveServerId: string | null;
}

// A function, not a shared constant: the caller owns the result and writes through it.
export function emptyStoredRemoteServers(): StoredRemoteServers {
  return {
    version: 3,
    activeServerId: LOCAL_SERVER_ID,
    servers: [],
    hiddenHostIds: [],
    unreadableServers: [],
    unreadableActiveServerId: null,
  };
}

// One unreadable entry costs the user the use of that entry, not the file and not the entry. Returning
// null here -- which this did until 2026-09 -- left the manager on its empty default, and its next
// write replaced every server the user had joined with an empty list. Null is now reserved for a file
// whose top level makes no sense, which `RemoteServerStore.load` turns into a refusal to touch it.
export function readStoredRemoteServers(value: unknown): StoredRemoteServers | null {
  if (!isDynamicRecord(value) || !isString(value.activeServerId) || !Array.isArray(value.servers)) return null;
  if (value.version !== 1 && value.version !== 2 && value.version !== 3) return null;
  const servers: StoredRemoteServer[] = [];
  const unreadableServers: PreservedRemoteServer[] = [];
  for (const [index, serverValue] of value.servers.entries()) {
    const server = readStoredRemoteServer(serverValue);
    if (server) servers.push(server);
    // A non-record entry carries no token and no identity, so there is nothing in it to preserve.
    else if (isDynamicRecord(serverValue)) unreadableServers.push({ index, entry: serverValue });
  }
  const hiddenHostIds = Array.isArray(value.hiddenHostIds)
    ? value.hiddenHostIds.filter((hostId): hostId is string => isString(hostId))
    : [];
  // The active server may be one of the entries just dropped. The local server is always selectable,
  // so it is the one fallback that cannot itself be missing. A fallback that stepped off a preserved
  // entry is remembered rather than overwritten; one that stepped off a dangling id is not, because
  // there is nothing left in the file for it to name.
  const selectable =
    value.activeServerId === LOCAL_SERVER_ID || servers.some((server) => server.id === value.activeServerId);
  const preservedActive = unreadableServers.some((preserved) => preserved.entry.id === value.activeServerId);
  return {
    version: 3,
    activeServerId: selectable ? value.activeServerId : LOCAL_SERVER_ID,
    servers,
    hiddenHostIds,
    unreadableServers,
    unreadableActiveServerId: !selectable && preservedActive ? value.activeServerId : null,
  };
}

// The on-disk object. Every unreadable entry rejoins `servers`, in the slot it came from: this
// function cannot tell a user who rejoined the server from `replaceServers` recreating the id off a
// directory advertisement, and dropping the entry in the second case would destroy a pinned key and
// fingerprint that nothing else holds. `RemoteServerStore` retires them where the intent is known.
//
// The slot matters because `servers` order is the sidebar order the user dragged into place. Writing
// the preserved entries last would let any unrelated write reshuffle a list this build cannot even
// display, and the build that can display it would show the new order as the user's own.
export function serializeStoredRemoteServers(state: StoredRemoteServers): {
  version: 3;
  activeServerId: string;
  servers: (StoredRemoteServer | DynamicRecord)[];
  hiddenHostIds: string[];
} {
  const servers: (StoredRemoteServer | DynamicRecord)[] = [...state.servers];
  // Ascending, so each insertion lands before the next one is placed. An index past the end of a
  // list that has since shrunk clamps to the end -- the entry keeps its place relative to the
  // servers that outlived it, which is the most the original slot can still mean.
  for (const preserved of [...state.unreadableServers].sort((left, right) => left.index - right.index)) {
    servers.splice(Math.min(preserved.index, servers.length), 0, preserved.entry);
  }
  return {
    version: state.version,
    activeServerId: state.unreadableActiveServerId ?? state.activeServerId,
    servers,
    hiddenHostIds: state.hiddenHostIds,
  };
}

export function readStoredRemoteServer(value: unknown): StoredRemoteServer | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.name) ||
    !isString(value.apiUrl) ||
    !isString(value.fingerprint) ||
    !(value.publicKey === undefined || isString(value.publicKey)) ||
    !isString(value.username) ||
    !isString(value.encryptedToken) ||
    !(value.remoteDesktopAvailable === undefined || isBoolean(value.remoteDesktopAvailable)) ||
    !(value.logoVersion === undefined || value.logoVersion === null || isString(value.logoVersion)) ||
    !(value.transport === undefined || value.transport === "webrtc-v2") ||
    !isOneOf(["owner", "admin", "member"] as const, value.role)
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    apiUrl: value.apiUrl,
    fingerprint: value.fingerprint,
    ...(value.publicKey === undefined ? {} : { publicKey: value.publicKey }),
    username: value.username,
    encryptedToken: value.encryptedToken,
    remoteDesktopAvailable: value.remoteDesktopAvailable ?? false,
    ...(value.logoVersion === undefined ? {} : { logoVersion: value.logoVersion }),
    role: value.role,
    ...(value.transport === undefined ? {} : { transport: value.transport }),
  };
}
