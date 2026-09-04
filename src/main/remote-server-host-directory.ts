// How the host list held by the account service reconciles with the servers stored on this
// computer. The account service is the authority on *which* hosts exist for this user; the stored
// entry is the authority on *which key* we already pinned for one. Merging them is the whole job
// of this file, and it is a pure function so the merge can be read without a socket or a disk.
//
// Two rules are load-bearing and neither is obvious from the call site:
//
//   - **A pinned key survives a changed advertisement.** If a stored host already carries a
//     `publicKey`, that key wins over whatever the directory advertises now. Otherwise the
//     advertised key is accepted only when it agrees with the stored fingerprint, or when there is
//     no stored fingerprint to disagree with. This is what makes an account-service compromise
//     insufficient to silently re-key a host the user already trusts.
//   - **The directory owns the list.** A stored WebRTC host missing from the directory is dropped,
//     and so is every non-WebRTC server unless `keepOtherTransports` is set. That flag is on only
//     in development builds, which is why a released build treats the account directory as the
//     complete answer rather than a set of additions.
//
// Order is preserved deliberately: surviving stored servers keep their positions, and hosts the
// user has not seen before are appended in directory order. The user drags this list.

import type { RemoteHostSummary } from "./central-auth-manager";
import type { StoredRemoteServerView } from "./remote-server-store";
import type { StoredRemoteServer } from "./remote-server-stored-shape";
import { fingerprint } from "./team-store";

export interface HostKeyPin {
  readonly hostId: string;
  readonly publicKey: string;
}

export interface WebRtcHostReconciliation {
  /** The complete replacement server list, in the order the user should see it. */
  readonly servers: StoredRemoteServer[];
  /** Stored WebRTC hosts the directory no longer lists. The caller disconnects and forgets these. */
  readonly removedHostIds: readonly string[];
  /** Keys the caller should pin on the transport, in directory order. */
  readonly pinnedKeys: readonly HostKeyPin[];
}

export interface WebRtcHostReconciliationInput {
  /** What the account service says this user's hosts are. */
  readonly hosts: readonly RemoteHostSummary[];
  /** What is on disk today. */
  readonly servers: readonly StoredRemoteServerView[];
  /** This computer's own host id, when it is also hosting. Never listed as a remote server. */
  readonly localHostId: string | null;
  /** Hosts the user removed by hand. They stay out until an explicit rejoin unhides them. */
  readonly isHiddenHost: (hostId: string) => boolean;
  /** The account email recorded on every host entry. */
  readonly username: string;
  /** Development only: keep HTTPS servers that the account directory does not know about. */
  readonly keepOtherTransports: boolean;
}

export function reconcileWebRtcHosts(input: WebRtcHostReconciliationInput): WebRtcHostReconciliation {
  const pinnedKeys: HostKeyPin[] = [];
  const listed = input.hosts
    .filter((host) => host.hostId !== input.localHostId && !input.isHiddenHost(host.hostId))
    .map<StoredRemoteServer>((host) => {
      const existing = input.servers.find((server) => server.id === host.hostId);
      const publicKey = resolveHostKey(existing, host.devicePublicKey);
      if (publicKey) pinnedKeys.push({ hostId: host.hostId, publicKey });
      return {
        id: host.hostId,
        name: host.name,
        apiUrl: `webrtc://${host.hostId}`,
        fingerprint: pinnedFingerprint(existing) || advertisedFingerprint(host.devicePublicKey),
        ...(publicKey ? { publicKey } : {}),
        username: input.username,
        encryptedToken: "",
        remoteDesktopAvailable: false,
        logoVersion: host.logoKey,
        role: host.role,
        transport: "webrtc-v2",
      };
    });

  const listedById = new Map(listed.map((server) => [server.id, server]));
  const seen = new Set<string>();
  const servers = input.servers.flatMap((server) => {
    if (server.transport !== "webrtc-v2") return input.keepOtherTransports ? [{ ...server }] : [];
    const refreshed = listedById.get(server.id);
    if (!refreshed) return [];
    seen.add(server.id);
    return [refreshed];
  });
  for (const server of listed) {
    if (seen.has(server.id)) continue;
    seen.add(server.id);
    servers.push(server);
  }

  return {
    servers,
    removedHostIds: input.servers
      .filter((server) => server.transport === "webrtc-v2" && !seen.has(server.id))
      .map((server) => server.id),
    pinnedKeys,
  };
}

/**
 * A key we already pinned is never replaced by an advertised one. An unpinned host accepts the
 * advertisement only when nothing on disk contradicts it.
 */
function resolveHostKey(existing: StoredRemoteServerView | undefined, advertised: string | null): string | null {
  if (existing?.transport === "webrtc-v2" && existing.publicKey) return existing.publicKey;
  const pinned = pinnedFingerprint(existing);
  if (pinned && pinned !== advertisedFingerprint(advertised)) return null;
  return advertised;
}

function pinnedFingerprint(existing: StoredRemoteServerView | undefined): string {
  return existing?.transport === "webrtc-v2" ? existing.fingerprint : "";
}

function advertisedFingerprint(devicePublicKey: string | null): string {
  return devicePublicKey ? fingerprint(devicePublicKey) : "";
}
