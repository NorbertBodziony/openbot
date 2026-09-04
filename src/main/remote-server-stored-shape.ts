// The shape of `servers.json` on the user's disk, and how a file written by an older build is read.
//
// This is persisted user state with no backup: nothing copies the file before an upgrade, and the
// first write after a read replaces it. So a read that cannot make sense of one part must give back
// everything else rather than nothing -- see `readStoredRemoteServers`. `src/backend/AGENTS.md` states
// the same rule for the database; the reasoning is identical and the file is smaller.
//
// Versions 1 and 2 differ from 3 only in fields this reader already treats as optional, so an upgrade
// is a re-tag. A version this build does not know is refused outright: it was written by a newer
// OpenBot, and guessing at it would replace a file that build can still read.

import type { TeamRole } from "@openbot/contracts/ipc";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";

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

export interface StoredRemoteServers {
  version: 3;
  activeServerId: string;
  servers: StoredRemoteServer[];
  hiddenHostIds: string[];
}

// A function, not a shared constant: the caller owns the result and writes through it.
export function emptyStoredRemoteServers(): StoredRemoteServers {
  return { version: 3, activeServerId: LOCAL_SERVER_ID, servers: [], hiddenHostIds: [] };
}

// One unreadable entry costs the user that entry, not the file. Returning null here -- which this did
// until 2026-09 -- left the manager on its empty default, and its next write replaced every server
// the user had joined with an empty list. A server that fails to parse cannot be connected to
// anyway, so dropping it loses nothing that keeping it would have saved.
export function readStoredRemoteServers(value: unknown): StoredRemoteServers | null {
  if (!isDynamicRecord(value) || !isString(value.activeServerId) || !Array.isArray(value.servers)) return null;
  if (value.version !== 1 && value.version !== 2 && value.version !== 3) return null;
  const servers: StoredRemoteServer[] = [];
  for (const serverValue of value.servers) {
    const server = readStoredRemoteServer(serverValue);
    if (server) servers.push(server);
  }
  const hiddenHostIds = Array.isArray(value.hiddenHostIds)
    ? value.hiddenHostIds.filter((hostId): hostId is string => isString(hostId))
    : [];
  // The active server may be one of the entries just dropped. The local server is always selectable,
  // so it is the one fallback that cannot itself be missing.
  const activeServerId =
    value.activeServerId === LOCAL_SERVER_ID || servers.some((server) => server.id === value.activeServerId)
      ? value.activeServerId
      : LOCAL_SERVER_ID;
  return { version: 3, activeServerId, servers, hiddenHostIds };
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
