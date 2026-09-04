import { type HostStatus, IPC_CHANNELS, LOCAL_SERVER_ID, type ServerSummary } from "@openbot/contracts/ipc";
import type { HostService } from "../host-service";
import type { RemoteDesktopManager } from "../remote-desktop-manager";
import type { RemoteServerManager } from "../remote-server-manager";
import { handleTrusted } from "../trusted-ipc";
import { parseAgentRequest } from "./agent-inputs";
import { routeToServer } from "./route-to-server";
import {
  parseCreateTeamInvite,
  parseDirectTyping,
  parseHostConfig,
  parseHostIdentity,
  parseJoinServer,
  parseLoginServer,
  parseMarkDirectRead,
  parseReadDirectConversationPage,
  parseRemoteDesktopConnect,
  parseRemoteDesktopDisplay,
  parseReorderServers,
  parseSendDirectMessage,
  parseSetTeamTyping,
  parseUpdateTeamMember,
} from "./server-inputs";
import { requireString, stringPayload } from "./validation";

interface TeamIpcDependencies {
  host: HostService;
  remoteDesktop: RemoteDesktopManager;
  remoteServers: RemoteServerManager;
  takePendingInvite: () => string | null;
}

export function registerTeamIpcHandlers({
  host,
  remoteDesktop,
  remoteServers,
  takePendingInvite,
}: TeamIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.serversList, () => withLocalHostSummary(remoteServers.list(), host.getStatus()));
  handleTrusted(IPC_CHANNELS.serversSelect, stringPayload("serverId"), (serverId) =>
    remoteServers.select(serverId).then((servers) => withLocalHostSummary(servers, host.getStatus())),
  );
  handleTrusted(IPC_CHANNELS.serversReorder, parseReorderServers, (request) =>
    remoteServers.reorder(request.serverIds).then((servers) => withLocalHostSummary(servers, host.getStatus())),
  );
  handleTrusted(IPC_CHANNELS.serversJoin, parseJoinServer, (request) => remoteServers.join(request));
  handleTrusted(IPC_CHANNELS.serversPreviewInvite, parseJoinServer, (request) => remoteServers.previewInvite(request));
  handleTrusted(IPC_CHANNELS.serversTakePendingInvite, takePendingInvite);
  handleTrusted(IPC_CHANNELS.serversLogin, parseLoginServer, (request) => remoteServers.login(request));
  handleTrusted(IPC_CHANNELS.serversRetryConnection, stringPayload("serverId"), (serverId) =>
    remoteServers.retryConnection(serverId),
  );
  handleTrusted(IPC_CHANNELS.serversRemove, stringPayload("serverId"), (serverId) => remoteServers.remove(serverId));
  handleTrusted(IPC_CHANNELS.serversGetPresence, () =>
    routeToServer(remoteServers.activeServerId, {
      local: () => host.getPresence(),
      remote: () => remoteServers.getPresence(),
    }),
  );
  handleTrusted(IPC_CHANNELS.serversGetPresenceFor, stringPayload("serverId"), (serverId) =>
    routeToServer(serverId, {
      local: () => host.getPresence(),
      remote: (target) => remoteServers.getPresenceFor(target),
    }),
  );
  handleTrusted(IPC_CHANNELS.serversRefreshIdentity, stringPayload("serverId"), (serverId) =>
    remoteServers.refreshIdentity(serverId),
  );
  handleTrusted(IPC_CHANNELS.serversListMembers, stringPayload("serverId"), (serverId) =>
    remoteServers.listMembers(serverId),
  );
  handleTrusted(IPC_CHANNELS.serversUpdateMember, parseAgentRequest, (request) =>
    remoteServers.updateMember(request.serverId, parseUpdateTeamMember(request.payload)),
  );
  handleTrusted(IPC_CHANNELS.serversRemoveMember, parseAgentRequest, (request) =>
    remoteServers.removeMember(request.serverId, requireString(request.payload, "memberId")),
  );
  handleTrusted(IPC_CHANNELS.serversListInvites, stringPayload("serverId"), (serverId) =>
    remoteServers.listInvites(serverId),
  );
  handleTrusted(IPC_CHANNELS.serversRevokeInvite, parseAgentRequest, (request) =>
    remoteServers.revokeInvite(request.serverId, requireString(request.payload, "inviteId")),
  );
  handleTrusted(IPC_CHANNELS.serversCreateInvite, parseAgentRequest, (request) =>
    remoteServers.createInvite(request.serverId, parseCreateTeamInvite(request.payload)),
  );
  handleTrusted(IPC_CHANNELS.serversSetTyping, parseSetTeamTyping, (parsed) =>
    routeToServer<void>(remoteServers.activeServerId, {
      local: () => host.setTyping(parsed),
      remote: () => remoteServers.setTyping(parsed),
    }),
  );
  handleTrusted(IPC_CHANNELS.serversListDirectThreads, () =>
    routeToServer(remoteServers.activeServerId, {
      local: () => host.listDirectThreads(),
      remote: () => remoteServers.listDirectThreads(),
    }),
  );
  handleTrusted(IPC_CHANNELS.serversReadDirectConversation, stringPayload("memberId"), (memberId) =>
    routeToServer(remoteServers.activeServerId, {
      local: () => host.readDirectConversation(memberId),
      remote: () => remoteServers.readDirectConversation(memberId),
    }),
  );
  handleTrusted(IPC_CHANNELS.serversReadDirectConversationPage, parseReadDirectConversationPage, (parsed) =>
    routeToServer(remoteServers.activeServerId, {
      local: () => host.readDirectConversationPage(parsed.memberId, parsed.anchor, parsed.limit),
      remote: () => remoteServers.readDirectConversationPage(parsed.memberId, parsed.anchor, parsed.limit),
    }),
  );
  handleTrusted(IPC_CHANNELS.serversSendDirectMessage, parseSendDirectMessage, (parsed) =>
    routeToServer(remoteServers.activeServerId, {
      local: () => host.sendDirectMessage(parsed),
      remote: () => remoteServers.sendDirectMessage(parsed),
    }),
  );
  handleTrusted(IPC_CHANNELS.serversMarkDirectRead, parseMarkDirectRead, (parsed) =>
    routeToServer(remoteServers.activeServerId, {
      local: () => host.markDirectRead(parsed),
      remote: () => remoteServers.markDirectRead(parsed),
    }),
  );
  handleTrusted(IPC_CHANNELS.serversSetDirectTyping, parseDirectTyping, (parsed) =>
    routeToServer<void>(remoteServers.activeServerId, {
      local: () => host.setDirectTyping(parsed),
      remote: () => remoteServers.setDirectTyping(parsed),
    }),
  );

  handleTrusted(IPC_CHANNELS.hostGetStatus, () => host.getStatus());
  handleTrusted(IPC_CHANNELS.hostConfigure, parseHostConfig, (config) => host.configure(config));
  handleTrusted(IPC_CHANNELS.hostUpdateIdentity, parseHostIdentity, (identity) => host.updateIdentity(identity));
  handleTrusted(IPC_CHANNELS.hostGetPresence, () => host.getPresence());
  handleTrusted(IPC_CHANNELS.hostStart, () => host.start());
  handleTrusted(IPC_CHANNELS.hostStop, () => host.stop());
  handleTrusted(IPC_CHANNELS.hostListMembers, () => host.listMembers());
  handleTrusted(IPC_CHANNELS.hostUpdateMember, parseUpdateTeamMember, (update) => host.updateMember(update));
  handleTrusted(IPC_CHANNELS.hostRemoveMember, stringPayload("memberId"), (memberId) => host.removeMember(memberId));
  handleTrusted(IPC_CHANNELS.hostListSessions, () => host.listSessions());
  handleTrusted(IPC_CHANNELS.hostRevokeSession, stringPayload("sessionId"), (sessionId) =>
    host.revokeSession(sessionId),
  );
  handleTrusted(IPC_CHANNELS.hostListInvites, () => host.listInvites());
  handleTrusted(IPC_CHANNELS.hostRevokeInvite, stringPayload("inviteId"), (inviteId) => host.revokeInvite(inviteId));
  handleTrusted(IPC_CHANNELS.hostCreateInvite, parseCreateTeamInvite, (invite) => host.createInvite(invite));

  handleTrusted(IPC_CHANNELS.remoteDesktopList, () => remoteDesktop.list());
  handleTrusted(IPC_CHANNELS.remoteDesktopConnect, parseRemoteDesktopConnect, (request) =>
    remoteDesktop.connect(request),
  );
  handleTrusted(IPC_CHANNELS.remoteDesktopSelectDisplay, parseRemoteDesktopDisplay, (request) =>
    remoteDesktop.selectDisplay(request.serverId, request.displayId),
  );
  handleTrusted(IPC_CHANNELS.remoteDesktopDisconnect, stringPayload("sessionId"), (sessionId) =>
    remoteDesktop.disconnect(sessionId),
  );
}

export function withLocalHostSummary(servers: ServerSummary[], status: HostStatus): ServerSummary[] {
  return servers.map((server) =>
    server.id === LOCAL_SERVER_ID
      ? {
          ...server,
          name: status.serverName ?? "Local",
          logoUrl: status.logoUrl,
          apiUrl: status.apiUrl,
          remoteDesktopAvailable: status.remoteDesktopReady,
          state: status.phase === "error" ? "error" : "online",
          role: status.configured ? "owner" : null,
        }
      : server,
  );
}
