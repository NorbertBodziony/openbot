import type {
  AvatarImageInput,
  InviteSummary,
  TeamInviteSummary,
  TeamPresenceMember,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { createMemo, createSignal } from "solid-js";
import { desktopAnalytics } from "../../analytics";
import { createSimpleContext } from "../../simple-context";
import { useServers } from "./servers-context";

/**
 * The settings dialog for one server: its identity, whether it is published,
 * and who can reach it.
 *
 * Global rather than scoped to the active server, and deliberately so - the
 * server rail opens this for *any* server in the list, so `openServerSettings`
 * takes an id. Scoping it to the active server would break opening the settings
 * of a server the user has not switched to.
 *
 * Ungated - the dialog is closed until someone opens it, and `refreshServerSettings`
 * carries its own loading and error signals for what happens after that.
 *
 * Every mutation ends in `refreshServerSettings(server.id)` rather than patching
 * the lists it just changed: main is the authority on membership, and a failed
 * write must not leave a row the server never accepted. The `operationSucceeded`
 * latch in each is what keeps a failure *after* the write from being reported as
 * a failed write.
 */
const ServerSettings = createSimpleContext({
  name: "Server settings",
  init: () => {
    const { servers, setServers, hostStatus, setHostStatus } = useServers();
    const [serverSettingsTargetId, setServerSettingsTargetId] = createSignal<string | null>(null);
    const [serverSettingsOpen, setServerSettingsOpen] = createSignal(false);
    const [serverSettingsMembers, setServerSettingsMembers] = createSignal<TeamPresenceMember[]>([]);
    const [serverSettingsInvites, setServerSettingsInvites] = createSignal<TeamInviteSummary[]>([]);
    const [serverSettingsLoading, setServerSettingsLoading] = createSignal(false);
    const [serverSettingsError, setServerSettingsError] = createSignal<string | null>(null);
    /** Bumped by every open and refresh, so a slower earlier load cannot paint over a newer one. */
    let serverSettingsRequest = 0;
    let serverSettingsRestoreTarget: HTMLElement | null = null;

    const serverSettingsTarget = createMemo(() => servers().find((server) => server.id === serverSettingsTargetId()));

    async function refreshServerSettings(serverId = serverSettingsTargetId()): Promise<void> {
      if (!serverId) return;
      const request = ++serverSettingsRequest;
      setServerSettingsLoading(true);
      setServerSettingsError(null);
      try {
        let server = servers().find((item) => item.id === serverId);
        if (!server) throw new Error("This server is not available.");
        let identityError: string | null = null;
        if (server.kind === "remote") {
          try {
            const refreshed = await window.openbot.servers.refreshIdentity(serverId);
            setServers((current) => current.map((item) => (item.id === serverId ? refreshed : item)));
            server = refreshed;
          } catch (error) {
            identityError = error instanceof Error ? error.message : "The server identity could not refresh.";
          }
        }
        const canManage =
          server.kind === "local" ? hostStatus().configured : server.role === "admin" || server.role === "owner";
        const canUseNetwork = server.kind === "local" || server.state === "online";
        const [presence, members, invites] = await Promise.all([
          server.kind === "local" ? window.openbot.host.getPresence() : window.openbot.servers.getPresenceFor(serverId),
          canManage && canUseNetwork
            ? server.kind === "local"
              ? window.openbot.host.listMembers()
              : window.openbot.servers.listMembers(serverId)
            : Promise.resolve(null),
          canManage && canUseNetwork
            ? server.kind === "local"
              ? window.openbot.host.listInvites()
              : window.openbot.servers.listInvites(serverId)
            : Promise.resolve([]),
        ]);
        if (request !== serverSettingsRequest || serverSettingsTargetId() !== serverId) return;
        const presenceById = new Map(presence.members.map((member) => [member.id, member]));
        setServerSettingsMembers(
          (members ?? presence.members).map((member) => ({
            ...member,
            online: presenceById.get(member.id)?.online ?? false,
            typingAgentId: presenceById.get(member.id)?.typingAgentId ?? null,
          })),
        );
        setServerSettingsInvites(invites);
        if (identityError) setServerSettingsError(identityError);
      } catch (error) {
        if (request === serverSettingsRequest && serverSettingsTargetId() === serverId) {
          setServerSettingsError(error instanceof Error ? error.message : "The server settings could not load.");
        }
      } finally {
        if (request === serverSettingsRequest) setServerSettingsLoading(false);
      }
    }

    function openServerSettings(serverId: string, trigger: HTMLElement | null): void {
      serverSettingsRequest += 1;
      serverSettingsRestoreTarget = trigger;
      setServerSettingsTargetId(serverId);
      setServerSettingsOpen(true);
      setServerSettingsMembers([]);
      setServerSettingsInvites([]);
      setServerSettingsError(null);
      void refreshServerSettings(serverId);
    }

    async function saveServerIdentity(input: { serverName: string; logo?: AvatarImageInput | null }): Promise<void> {
      const server = serverSettingsTarget();
      if (server?.kind !== "local") throw new Error("Only the local server identity can change here.");
      const analytics = desktopAnalytics.scope();
      let operationSucceeded = false;
      try {
        const status = hostStatus().configured
          ? await window.openbot.host.updateIdentity(input)
          : await window.openbot.host.configure(input);
        analytics.track("team_action", {
          action: "identity_saved",
          result: "succeeded",
          server_kind: "local",
        });
        operationSucceeded = true;
        setHostStatus(status);
        setServers(await window.openbot.servers.list());
        await refreshServerSettings(server.id);
      } catch (error) {
        if (!operationSucceeded) {
          analytics.track("team_action", {
            action: "identity_saved",
            result: "failed",
            server_kind: "local",
            failure_code: "identity_save_failed",
          });
        }
        throw error;
      }
    }

    async function setServerPublished(published: boolean): Promise<void> {
      const server = serverSettingsTarget();
      if (server?.kind !== "local") throw new Error("Only the local server can change publication.");
      const analytics = desktopAnalytics.scope();
      const action = published ? ("published" as const) : ("unpublished" as const);
      let operationSucceeded = false;
      try {
        const status = published ? await window.openbot.host.start() : await window.openbot.host.stop();
        if (published && status.phase !== "online") throw new Error("publish_failed");
        analytics.track("team_action", { action, result: "succeeded", server_kind: "local" });
        operationSucceeded = true;
        setHostStatus(status);
        setServers(await window.openbot.servers.list());
        await refreshServerSettings(server.id);
      } catch (error) {
        if (!operationSucceeded) {
          analytics.track("team_action", {
            action,
            result: "failed",
            server_kind: "local",
            failure_code: published ? "publish_failed" : "unpublish_failed",
          });
        }
        throw error;
      }
    }

    async function createServerInvite(input: { role: "admin" | "member"; email?: string }): Promise<InviteSummary> {
      const server = serverSettingsTarget();
      if (!server) throw new Error("This server is not available.");
      const analytics = desktopAnalytics.scope();
      let operationSucceeded = false;
      try {
        const invite =
          server.kind === "local"
            ? await window.openbot.host.createInvite(input)
            : await window.openbot.servers.createInvite(server.id, input);
        analytics.track("team_action", {
          action: "invite_created",
          result: "succeeded",
          server_kind: server.kind,
          role: input.role,
          email_bound: Boolean(input.email),
        });
        operationSucceeded = true;
        await refreshServerSettings(server.id);
        return invite;
      } catch (error) {
        if (!operationSucceeded) {
          analytics.track("team_action", {
            action: "invite_created",
            result: "failed",
            server_kind: server.kind,
            role: input.role,
            email_bound: Boolean(input.email),
            failure_code: "invite_create_failed",
          });
        }
        throw error;
      }
    }

    async function updateServerMember(input: UpdateTeamMemberInput): Promise<void> {
      const server = serverSettingsTarget();
      if (!server) throw new Error("This server is not available.");
      const analytics = desktopAnalytics.scope();
      let operationSucceeded = false;
      try {
        if (server.kind === "local") await window.openbot.host.updateMember(input);
        else await window.openbot.servers.updateMember(server.id, input);
        analytics.track("team_action", { action: "member_updated", result: "succeeded", server_kind: server.kind });
        operationSucceeded = true;
        await refreshServerSettings(server.id);
      } catch (error) {
        if (!operationSucceeded) {
          analytics.track("team_action", {
            action: "member_updated",
            result: "failed",
            server_kind: server.kind,
            failure_code: "member_update_failed",
          });
        }
        throw error;
      }
    }

    async function removeServerMember(memberId: string): Promise<void> {
      const server = serverSettingsTarget();
      if (!server) throw new Error("This server is not available.");
      const analytics = desktopAnalytics.scope();
      let operationSucceeded = false;
      try {
        if (server.kind === "local") await window.openbot.host.removeMember(memberId);
        else await window.openbot.servers.removeMember(server.id, memberId);
        analytics.track("team_action", { action: "member_removed", result: "succeeded", server_kind: server.kind });
        operationSucceeded = true;
        await refreshServerSettings(server.id);
      } catch (error) {
        if (!operationSucceeded) {
          analytics.track("team_action", {
            action: "member_removed",
            result: "failed",
            server_kind: server.kind,
            failure_code: "member_remove_failed",
          });
        }
        throw error;
      }
    }

    async function revokeServerInvite(inviteId: string): Promise<void> {
      const server = serverSettingsTarget();
      if (!server) throw new Error("This server is not available.");
      const analytics = desktopAnalytics.scope();
      let operationSucceeded = false;
      try {
        if (server.kind === "local") await window.openbot.host.revokeInvite(inviteId);
        else await window.openbot.servers.revokeInvite(server.id, inviteId);
        analytics.track("team_action", { action: "invite_revoked", result: "succeeded", server_kind: server.kind });
        operationSucceeded = true;
        await refreshServerSettings(server.id);
      } catch (error) {
        if (!operationSucceeded) {
          analytics.track("team_action", {
            action: "invite_revoked",
            result: "failed",
            server_kind: server.kind,
            failure_code: "invite_revoke_failed",
          });
        }
        throw error;
      }
    }
    return {
      serverSettingsTarget,
      serverSettingsOpen,
      setServerSettingsOpen,
      serverSettingsRestoreTarget: () => serverSettingsRestoreTarget,
      serverSettingsMembers,
      serverSettingsInvites,
      serverSettingsLoading,
      serverSettingsError,
      openServerSettings,
      refreshServerSettings,
      saveServerIdentity,
      setServerPublished,
      createServerInvite,
      updateServerMember,
      removeServerMember,
      revokeServerInvite,
    };
  },
});

export const ServerSettingsProvider = ServerSettings.provider;
export const useServerSettings = ServerSettings.use;
