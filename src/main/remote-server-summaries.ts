// The `ServerSummary` list the renderer sees: stored servers joined to their connection status, with
// the local server in front.
//
// A pure function of two values, so a change to what the renderer is told can be checked against two
// arrays rather than a manager holding a disk, a socket and a WebRTC transport.

import type { ServerSummary } from "@openbot/contracts/ipc";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import type { RemoteServerConnectionStatus } from "./remote-server-connection-status";
import type { StoredRemoteServerView } from "./remote-server-store";
import { remoteServerLogoUrl } from "./remote-server-urls";

export function remoteServerSummaries(
  servers: readonly StoredRemoteServerView[],
  activeServerId: string,
  statusFor: (serverId: string) => RemoteServerConnectionStatus,
): ServerSummary[] {
  return [
    // Always present and always reachable: it is this computer. It has no host to be incompatible
    // with and no connection to fail, which is why its status fields are literals rather than looked
    // up.
    {
      id: LOCAL_SERVER_ID,
      name: "Local",
      kind: "local",
      state: "online",
      apiUrl: null,
      remoteDesktopAvailable: false,
      logoUrl: null,
      role: null,
      active: activeServerId === LOCAL_SERVER_ID,
      compatibility: null,
      issue: null,
    },
    ...servers.map((server) => {
      const status = statusFor(server.id);
      return {
        id: server.id,
        name: server.name,
        kind: "remote" as const,
        state: status.state,
        // A WebRTC host has no HTTP origin to give out. Reporting its `webrtc://` placeholder as an
        // apiUrl would let a caller try to fetch it.
        apiUrl: server.transport === "webrtc-v2" ? null : server.apiUrl,
        remoteDesktopAvailable: server.remoteDesktopAvailable ?? false,
        logoUrl: server.logoVersion ? remoteServerLogoUrl(server.id, server.logoVersion) : null,
        role: server.role,
        active: activeServerId === server.id,
        compatibility: status.compatibility,
        issue: status.issue,
        connectionSequence: status.connectionSequence,
      };
    }),
  ];
}
