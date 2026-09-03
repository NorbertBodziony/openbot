import { type HostStatus, IPC_CHANNELS, type ServerSummary } from "@openbot/contracts/ipc";
import type { HostService } from "../host-service";
import type { RemoteDesktopManager } from "../remote-desktop-manager";
import type { RemoteServerManager } from "../remote-server-manager";
import { handleTrusted } from "../trusted-ipc";
import { parseAgentRequest } from "./agent-inputs";
import {
  parseCreateTeamInvite,
  parseDirectTyping,
  parseHostConfig,
  parseHostIdentity,
  parseJoinServer,
  parseLoginServer,
  parseMarkDirectRead,
  parseReadDirectConversationPage,
  parseReorderServers,
  parseSendDirectMessage,
  parseSetTeamTyping,
  parseUpdateTeamMember,
} from "./server-inputs";
import { isObject, requireString } from "./validation";

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
  handleTrusted(IPC_CHANNELS.serversSelect, (serverId: unknown) =>
    remoteServers
      .select(requireString(serverId, "serverId"))
      .then((servers) => withLocalHostSummary(servers, host.getStatus())),
  );
  handleTrusted(IPC_CHANNELS.serversReorder, (input: unknown) =>
    remoteServers
      .reorder(parseReorderServers(input).serverIds)
      .then((servers) => withLocalHostSummary(servers, host.getStatus())),
  );
  handleTrusted(IPC_CHANNELS.serversJoin, (input: unknown) => remoteServers.join(parseJoinServer(input)));
  handleTrusted(IPC_CHANNELS.serversPreviewInvite, (input: unknown) =>
    remoteServers.previewInvite(parseJoinServer(input)),
  );
  handleTrusted(IPC_CHANNELS.serversTakePendingInvite, takePendingInvite);
  handleTrusted(IPC_CHANNELS.serversLogin, (input: unknown) => remoteServers.login(parseLoginServer(input)));
  handleTrusted(IPC_CHANNELS.serversRetryConnection, (serverId: unknown) =>
    remoteServers.retryConnection(requireString(serverId, "serverId")),
  );
  handleTrusted(IPC_CHANNELS.serversRemove, (serverId: unknown) =>
    remoteServers.remove(requireString(serverId, "serverId")),
  );
  handleTrusted(IPC_CHANNELS.serversGetPresence, () =>
    remoteServers.activeServerId === "local" ? host.getPresence() : remoteServers.getPresence(),
  );
  handleTrusted(IPC_CHANNELS.serversGetPresenceFor, (serverId: unknown) => {
    const target = requireString(serverId, "serverId");
    return target === "local" ? host.getPresence() : remoteServers.getPresenceFor(target);
  });
  handleTrusted(IPC_CHANNELS.serversRefreshIdentity, (serverId: unknown) =>
    remoteServers.refreshIdentity(requireString(serverId, "serverId")),
  );
  handleTrusted(IPC_CHANNELS.serversListMembers, (serverId: unknown) =>
    remoteServers.listMembers(requireString(serverId, "serverId")),
  );
  handleTrusted(IPC_CHANNELS.serversUpdateMember, (input: unknown) => {
    const request = parseAgentRequest(input);
    return remoteServers.updateMember(request.serverId, parseUpdateTeamMember(request.payload));
  });
  handleTrusted(IPC_CHANNELS.serversRemoveMember, (input: unknown) => {
    const request = parseAgentRequest(input);
    return remoteServers.removeMember(request.serverId, requireString(request.payload, "memberId"));
  });
  handleTrusted(IPC_CHANNELS.serversListInvites, (serverId: unknown) =>
    remoteServers.listInvites(requireString(serverId, "serverId")),
  );
  handleTrusted(IPC_CHANNELS.serversRevokeInvite, (input: unknown) => {
    const request = parseAgentRequest(input);
    return remoteServers.revokeInvite(request.serverId, requireString(request.payload, "inviteId"));
  });
  handleTrusted(IPC_CHANNELS.serversCreateInvite, (input: unknown) => {
    const request = parseAgentRequest(input);
    return remoteServers.createInvite(request.serverId, parseCreateTeamInvite(request.payload));
  });
  handleTrusted(IPC_CHANNELS.serversSetTyping, (input: unknown) => {
    const parsed = parseSetTeamTyping(input);
    if (remoteServers.activeServerId === "local") host.setTyping(parsed);
    else remoteServers.setTyping(parsed);
  });
  handleTrusted(IPC_CHANNELS.serversListDirectThreads, () =>
    remoteServers.activeServerId === "local" ? host.listDirectThreads() : remoteServers.listDirectThreads(),
  );
  handleTrusted(IPC_CHANNELS.serversReadDirectConversation, (memberId: unknown) => {
    const parsedMemberId = requireString(memberId, "memberId");
    return remoteServers.activeServerId === "local"
      ? host.readDirectConversation(parsedMemberId)
      : remoteServers.readDirectConversation(parsedMemberId);
  });
  handleTrusted(IPC_CHANNELS.serversReadDirectConversationPage, (input: unknown) => {
    const parsed = parseReadDirectConversationPage(input);
    return remoteServers.activeServerId === "local"
      ? host.readDirectConversationPage(parsed.memberId, parsed.anchor, parsed.limit)
      : remoteServers.readDirectConversationPage(parsed.memberId, parsed.anchor, parsed.limit);
  });
  handleTrusted(IPC_CHANNELS.serversSendDirectMessage, (input: unknown) => {
    const parsed = parseSendDirectMessage(input);
    return remoteServers.activeServerId === "local"
      ? host.sendDirectMessage(parsed)
      : remoteServers.sendDirectMessage(parsed);
  });
  handleTrusted(IPC_CHANNELS.serversMarkDirectRead, (input: unknown) => {
    const parsed = parseMarkDirectRead(input);
    return remoteServers.activeServerId === "local"
      ? host.markDirectRead(parsed)
      : remoteServers.markDirectRead(parsed);
  });
  handleTrusted(IPC_CHANNELS.serversSetDirectTyping, (input: unknown) => {
    const parsed = parseDirectTyping(input);
    if (remoteServers.activeServerId === "local") host.setDirectTyping(parsed);
    else remoteServers.setDirectTyping(parsed);
  });

  handleTrusted(IPC_CHANNELS.hostGetStatus, () => host.getStatus());
  handleTrusted(IPC_CHANNELS.hostConfigure, (input: unknown) => host.configure(parseHostConfig(input)));
  handleTrusted(IPC_CHANNELS.hostUpdateIdentity, (input: unknown) => host.updateIdentity(parseHostIdentity(input)));
  handleTrusted(IPC_CHANNELS.hostGetPresence, () => host.getPresence());
  handleTrusted(IPC_CHANNELS.hostStart, () => host.start());
  handleTrusted(IPC_CHANNELS.hostStop, () => host.stop());
  handleTrusted(IPC_CHANNELS.hostListMembers, () => host.listMembers());
  handleTrusted(IPC_CHANNELS.hostUpdateMember, (input: unknown) => host.updateMember(parseUpdateTeamMember(input)));
  handleTrusted(IPC_CHANNELS.hostRemoveMember, (memberId: unknown) =>
    host.removeMember(requireString(memberId, "memberId")),
  );
  handleTrusted(IPC_CHANNELS.hostListSessions, () => host.listSessions());
  handleTrusted(IPC_CHANNELS.hostRevokeSession, (sessionId: unknown) =>
    host.revokeSession(requireString(sessionId, "sessionId")),
  );
  handleTrusted(IPC_CHANNELS.hostListInvites, () => host.listInvites());
  handleTrusted(IPC_CHANNELS.hostRevokeInvite, (inviteId: unknown) =>
    host.revokeInvite(requireString(inviteId, "inviteId")),
  );
  handleTrusted(IPC_CHANNELS.hostCreateInvite, (input: unknown) => host.createInvite(parseCreateTeamInvite(input)));

  handleTrusted(IPC_CHANNELS.remoteDesktopList, () => remoteDesktop.list());
  handleTrusted(IPC_CHANNELS.remoteDesktopConnect, (input: unknown) => {
    if (!isObject(input)) throw new Error("Remote control details are required.");
    return remoteDesktop.connect({ serverId: requireString(input.serverId, "serverId") });
  });
  handleTrusted(IPC_CHANNELS.remoteDesktopSelectDisplay, (input: unknown) => {
    if (!isObject(input)) throw new Error("Remote display details are required.");
    return remoteDesktop.selectDisplay(
      requireString(input.serverId, "serverId"),
      requireString(input.displayId, "displayId"),
    );
  });
  handleTrusted(IPC_CHANNELS.remoteDesktopDisconnect, (sessionId: unknown) =>
    remoteDesktop.disconnect(requireString(sessionId, "sessionId")),
  );
}

export function withLocalHostSummary(servers: ServerSummary[], status: HostStatus): ServerSummary[] {
  return servers.map((server) =>
    server.id === "local"
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
