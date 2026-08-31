import { EventEmitter } from "node:events";
import { join } from "node:path";
import { createInviteUrl } from "@openbot/contracts/invite-links";
import type {
  AvatarImageInput,
  CentralAuthUser,
  ConfigureHostInput,
  ConversationPage,
  ConversationPageAnchor,
  ConversationReadState,
  ConversationSearchPage,
  ConversationWithReadState,
  CreateTeamInviteInput,
  DirectConversationPage,
  DirectConversationPageAnchor,
  DirectConversationReadState,
  DirectConversationSnapshot,
  DirectMessage,
  DirectMessageRealtimeEvent,
  DirectThreadSummary,
  DirectTypingInput,
  DirectTypingRealtimeEvent,
  HostStatus,
  InviteSummary,
  MarkConversationReadInput,
  MarkDirectReadInput,
  RemoteDesktopDisplay,
  RemoteDesktopIceServer,
  SendDirectMessageInput,
  SetTeamTypingInput,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamSessionSummary,
  UpdateHostIdentityInput,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import type { MailboxStore } from "../backend/mailbox-store";
import type { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import type { TeamChatStore } from "../backend/team-chat-store";
import type { RemoteDesktopRuntimePaths } from "./remote-desktop-runtime-artifact";
import { appendRemoteDiagnosticLog } from "./remote-diagnostics";
import { RemoteScreenGateway } from "./remote-screen-gateway";
import { TeamApiServer } from "./team-api-server";
import type { AuthenticatedMember, RemoteDirectoryMember, TeamStore } from "./team-store";
import type { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcHostGateway } from "./team-webrtc-host-gateway";

export const DEVELOPMENT_REMOTE_CLIENT_USERNAME = "openbot-dev-client";

interface HostEvents {
  changed: [status: HostStatus];
  presence: [snapshot: TeamPresenceSnapshot];
  directMessage: [event: DirectMessageRealtimeEvent];
  directTyping: [event: DirectTypingRealtimeEvent];
}

interface HostServiceOptions {
  appVersion: string;
  store: TeamStore;
  agents: AgentService;
  sidebarLayout: SidebarLayoutStore;
  mailbox: MailboxStore;
  browser: BrowserHost;
  chat?: TeamChatStore;
  allowLocalDevelopmentInvites?: boolean;
  logDirectory?: string;
  removeLegacyRemoteDesktopCredential?: () => Promise<void>;
  getSignedInUser: () => CentralAuthUser;
  redeemCentralTicket: (ticket: string, serverId: string) => Promise<CentralAuthUser | null>;
  sendTeamInviteEmail: (input: {
    email: string;
    serverName: string;
    inviteUrl: string;
    role: "admin" | "member";
  }) => Promise<void>;
  remoteDesktopRuntimePaths?: RemoteDesktopRuntimePaths | null;
  remoteDesktopStateDirectory?: string;
  getRemoteDesktopRuntimeCredentials?: () => Promise<{ username: string; password: string }>;
  getRemoteDesktopDisplays?: () => RemoteDesktopDisplay[];
  getRemoteDesktopIceServers?: () => Promise<RemoteDesktopIceServer[]>;
  platform?: "darwin" | "win32" | "linux";
  unattended?: boolean;
  teamWebRtcBridge?: TeamWebRtcBridge;
  registerRemoteHost?: (input: {
    hostId: string;
    name: string;
    ownerMembershipId: string;
    devicePublicKey?: string | null;
  }) => Promise<unknown>;
  issueRemoteHostTicket?: (hostId: string) => Promise<{ ticket: string; signalUrl: string; expiresAt: number }>;
  remoteControlPlaneUrl?: string;
  createRemoteInvite?: (
    hostId: string,
    input: { role: "admin" | "member"; email?: string },
  ) => Promise<{ inviteId: string; token: string; expiresAt: number }>;
  listRemoteInvites?: (hostId: string) => Promise<
    Array<{
      inviteId: string;
      role: "admin" | "member";
      email: string | null;
      expiresAt: number;
      usedAt: number | null;
    }>
  >;
  revokeRemoteInvite?: (inviteId: string) => Promise<void>;
  listRemoteMembers?: (hostId: string) => Promise<RemoteDirectoryMember[]>;
  updateRemoteMember?: (
    hostId: string,
    membershipId: string,
    role: "admin" | "member",
    reactivate?: boolean,
  ) => Promise<void>;
  removeRemoteMember?: (hostId: string, membershipId: string) => Promise<void>;
  updateRemoteHostLogo?: (
    hostId: string,
    image: AvatarImageInput | null,
    version?: string | null,
  ) => Promise<string | null>;
}

export class HostService extends EventEmitter<HostEvents> {
  readonly #options: Required<Pick<HostServiceOptions, "allowLocalDevelopmentInvites">> &
    Omit<HostServiceOptions, "allowLocalDevelopmentInvites">;
  readonly #api: TeamApiServer;
  readonly #remoteScreen: RemoteScreenGateway;
  readonly #webrtcGateway: TeamWebRtcHostGateway | null;
  #status: HostStatus;
  #legacyCredentialRemoved = false;

  constructor(options: HostServiceOptions) {
    super();
    this.#options = {
      ...options,
      allowLocalDevelopmentInvites: options.allowLocalDevelopmentInvites ?? false,
    };
    const identity = options.store.getIdentity();
    this.#status = {
      phase: identity ? "idle" : "unconfigured",
      configured: Boolean(identity),
      enabledOnLaunch: identity?.enabledOnLaunch ?? false,
      serverId: identity?.serverId ?? null,
      serverName: identity?.serverName ?? null,
      logoUrl: identity?.logoVersion ? serverLogoUrl(identity.logoVersion) : null,
      apiUrl: null,
      apiOnline: false,
      remoteDesktopReady: false,
      remoteDesktopUnattended: options.unattended ?? false,
      remoteDesktopActiveSessions: 0,
      remoteDesktopMaxSessions: 4,
      message: null,
    };
    const logDirectory = options.logDirectory;
    this.#remoteScreen = new RemoteScreenGateway({
      platform: options.platform ?? normalizeRemoteDesktopPlatform(process.platform),
      unattended: options.unattended ?? false,
      runtimePaths: options.remoteDesktopRuntimePaths ?? null,
      runtimeStateDirectory: options.remoteDesktopStateDirectory ?? ".openbot-remote-desktop",
      getRuntimeCredentials:
        options.getRemoteDesktopRuntimeCredentials ??
        (async () => ({ username: "openbot", password: "development-runtime-not-for-release" })),
      getDisplays: options.getRemoteDesktopDisplays,
      getIceServers:
        options.getRemoteDesktopIceServers ??
        (async () => {
          throw new Error("Remote Signal has not supplied ICE servers.");
        }),
      ...(logDirectory
        ? {
            onDiagnostic: (source: "sunshine" | "moonlight", message: string) => {
              void appendRemoteDiagnosticLog(logDirectory, `remote-screen-${source}`, message);
            },
          }
        : {}),
      audit: (event) => {
        if (options.logDirectory) {
          void appendRemoteDiagnosticLog(options.logDirectory, "remote-screen", `${JSON.stringify(event)}\n`);
        }
        if (
          event.event === "started" &&
          !this.#legacyCredentialRemoved &&
          options.removeLegacyRemoteDesktopCredential
        ) {
          this.#legacyCredentialRemoved = true;
          void options.removeLegacyRemoteDesktopCredential().catch(() => {
            this.#legacyCredentialRemoved = false;
          });
        }
      },
    });
    this.#api = new TeamApiServer({
      appVersion: options.appVersion,
      store: options.store,
      agents: options.agents,
      sidebarLayout: options.sidebarLayout,
      mailbox: options.mailbox,
      browser: options.browser,
      remoteScreen: this.#remoteScreen,
      redeemCentralTicket: options.redeemCentralTicket,
      chat: options.chat,
      onPresence: (snapshot) => this.emit("presence", snapshot),
      onDirectMessage: (event) => this.emit("directMessage", event),
      onDirectTyping: (event) => this.emit("directTyping", event),
      createInvite: (input) => this.createInvite(input),
    });
    this.#webrtcGateway = options.teamWebRtcBridge
      ? new TeamWebRtcHostGateway({
          bridge: options.teamWebRtcBridge,
          store: options.store,
          appVersion: options.appVersion,
          transferDirectory: join(options.logDirectory ?? ".openbot-remote", "transfers"),
          renewSignal: async (hostId) => {
            if (!options.issueRemoteHostTicket) throw new Error("The WebRTC host service is not configured.");
            return options.issueRemoteHostTicket(hostId);
          },
          onSignalRecoveryFailure: (error) => {
            this.#setStatus({
              phase: "error",
              apiOnline: false,
              message: error.message,
            });
          },
        })
      : null;
  }

  getStatus(): HostStatus {
    const capabilities = this.#remoteScreen.capabilities();
    return {
      ...this.#status,
      remoteDesktopReady: capabilities.ready,
      remoteDesktopUnattended: capabilities.unattended,
      remoteDesktopActiveSessions: capabilities.activeSessions,
      remoteDesktopMaxSessions: capabilities.maxSessions,
    };
  }

  async syncSignedInAccount(user: CentralAuthUser): Promise<void> {
    if (!this.#options.store.configured) return;
    if (await this.#options.store.syncAccount(user)) this.#api.refreshPresence();
  }

  async configure(input: ConfigureHostInput): Promise<HostStatus> {
    const identity = await this.#options.store.configureWithAccount(
      input.serverName,
      this.#options.getSignedInUser(),
      input.logo,
    );
    this.#setStatus({
      phase: "idle",
      configured: true,
      serverId: identity.serverId,
      serverName: identity.serverName,
      logoUrl: identity.logoVersion ? serverLogoUrl(identity.logoVersion) : null,
      enabledOnLaunch: false,
      message: null,
    });
    this.#api.refreshPresence();
    this.#api.refreshIdentity();
    try {
      await this.#options.registerRemoteHost?.({
        hostId: identity.serverId,
        name: identity.serverName,
        ownerMembershipId: this.#requiredOwnerMemberId(),
        devicePublicKey: identity.publicKey,
      });
      if (input.logo !== undefined) {
        await this.#options.updateRemoteHostLogo?.(identity.serverId, input.logo ?? null, identity.logoVersion);
      }
      this.#setStatus({
        apiUrl: null,
        message: "Registered this OpenBot for WebRTC access.",
      });
    } catch (error) {
      this.#setStatus({
        phase: "error",
        message: error instanceof Error ? error.message : "Could not reserve the public address.",
      });
    }
    return this.getStatus();
  }

  async updateIdentity(input: UpdateHostIdentityInput): Promise<HostStatus> {
    this.#options.store.assertOwnerAccount(this.#options.getSignedInUser());
    const identity = await this.#options.store.updateIdentity(input);
    this.#setStatus({
      serverName: identity.serverName,
      logoUrl: identity.logoVersion ? serverLogoUrl(identity.logoVersion) : null,
      message: "Server identity updated.",
    });
    this.#api.refreshIdentity();
    await this.#options.registerRemoteHost?.({
      hostId: identity.serverId,
      name: identity.serverName,
      ownerMembershipId: this.#requiredOwnerMemberId(),
      devicePublicKey: identity.publicKey,
    });
    if (input.logo !== undefined) {
      await this.#options.updateRemoteHostLogo?.(identity.serverId, input.logo ?? null, identity.logoVersion);
    }
    return this.getStatus();
  }

  async start(): Promise<HostStatus> {
    if (!this.#options.store.configured) throw new Error("Name this OpenBot before publishing it.");
    if (this.#status.phase === "online" || this.#status.phase === "starting") {
      return this.getStatus();
    }
    const signedInUser = this.#options.getSignedInUser();
    this.#options.store.assertOwnerAccount(signedInUser);
    await this.syncSignedInAccount(signedInUser);
    this.#setStatus({ phase: "starting", message: "Starting the WebRTC host…" });

    try {
      const apiPort = await this.#api.start();
      const identity = this.#options.store.getIdentity();
      if (!identity) throw new Error("Name this OpenBot before publishing it.");
      if (!this.#webrtcGateway || !this.#options.registerRemoteHost || !this.#options.issueRemoteHostTicket) {
        throw new Error("The WebRTC host service is not configured.");
      }
      await this.#options.registerRemoteHost({
        hostId: identity.serverId,
        name: identity.serverName,
        ownerMembershipId: this.#requiredOwnerMemberId(),
        devicePublicKey: identity.publicKey,
      });
      if (this.#options.listRemoteMembers) {
        await this.#options.store.syncRemoteDirectory(await this.#options.listRemoteMembers(identity.serverId));
      }
      const bootstrap = await this.#options.issueRemoteHostTicket(identity.serverId);
      await this.#webrtcGateway.start({
        hostId: identity.serverId,
        signalUrl: bootstrap.signalUrl,
        ticket: bootstrap.ticket,
        localApiPort: apiPort,
      });
      this.#setStatus({
        apiUrl: bootstrap.signalUrl,
        apiOnline: true,
        message: "This OpenBot is ready for WebRTC connections.",
      });
      await this.#options.store.setEnabledOnLaunch(true);
      this.#setStatus({ phase: "online", enabledOnLaunch: true });
    } catch (error) {
      await this.#stopRuntime();
      this.#setStatus({
        phase: "error",
        apiOnline: false,
        apiUrl: null,
        message: error instanceof Error ? error.message : "This OpenBot could not be published.",
      });
    }
    return this.getStatus();
  }

  async startDevelopmentLocal(): Promise<HostStatus> {
    if (!this.#options.store.configured) throw new Error("Name this OpenBot before starting local development.");
    if (this.#status.phase === "online") return this.getStatus();
    const apiPort = await this.#api.start();
    this.#setStatus({
      phase: "online",
      apiUrl: `http://localhost:${apiPort}`,
      apiOnline: true,
      message: "Local development host is ready.",
    });
    return this.getStatus();
  }

  async createDevelopmentConnection(): Promise<{
    serverId: string;
    serverName: string;
    apiUrl: string;
    fingerprint: string;
    publicKey: string;
    username: string;
    sessionToken: string;
  }> {
    const identity = this.#options.store.getIdentity();
    if (!identity || !this.#status.apiUrl) throw new Error("The local development host is not ready.");
    const username = DEVELOPMENT_REMOTE_CLIENT_USERNAME;
    const password = "openbot-local-development-client";
    let authenticated: AuthenticatedMember;
    try {
      authenticated = await this.#options.store.login(username, password);
    } catch {
      const invite = await this.#options.store.createInvite("member");
      authenticated = await this.#options.store.acceptInvite(invite.token, username, password);
    }
    this.#api.refreshPresence();
    return {
      serverId: identity.serverId,
      serverName: identity.serverName,
      apiUrl: this.#status.apiUrl,
      fingerprint: identity.fingerprint,
      publicKey: identity.publicKey,
      username,
      sessionToken: authenticated.sessionToken,
    };
  }

  async stop(persistPreference = true): Promise<HostStatus> {
    if (this.#status.phase === "unconfigured") return this.getStatus();
    if (persistPreference) this.#options.store.assertOwnerAccount(this.#options.getSignedInUser());
    this.#setStatus({ phase: "stopping", message: "Making this OpenBot private…" });
    await this.#stopRuntime();
    if (persistPreference) await this.#options.store.setEnabledOnLaunch(false);
    this.#setStatus({
      phase: "idle",
      enabledOnLaunch: persistPreference ? false : this.#status.enabledOnLaunch,
      apiUrl: null,
      apiOnline: false,
      message: "This OpenBot is private.",
    });
    return this.getStatus();
  }

  listMembers(): TeamMemberSummary[] | Promise<TeamMemberSummary[]> {
    const hostId = this.#options.store.getIdentity()?.serverId;
    if (hostId && this.#options.listRemoteMembers) {
      return this.#options.listRemoteMembers(hostId).then(async (members) => {
        await this.#options.store.syncRemoteDirectory(members);
        return members.map((member) => ({
          id: member.membershipId,
          username: member.email,
          email: member.email,
          name: member.name,
          avatarUrl: member.avatarUrl,
          role: member.role,
          createdAt: new Date(member.createdAt).toISOString(),
          disabled: member.status !== "active",
        }));
      });
    }
    return this.#options.store.listMembers();
  }

  getPresence(): TeamPresenceSnapshot {
    return this.#api.getPresence();
  }

  setTyping(input: SetTeamTypingInput): void {
    this.#api.setLocalTyping(input.botId, input.typing);
  }

  readAgentConversation(botId: string): Promise<ConversationWithReadState> {
    return this.#options.agents.readConversationFor(botId, this.#currentAgentReaderId());
  }

  readAgentConversationPage(
    botId: string,
    anchor: ConversationPageAnchor = { type: "latest" },
    limit = 50,
  ): Promise<ConversationPage> {
    return this.#options.agents.readConversationPageFor(botId, this.#currentAgentReaderId(), anchor, limit);
  }

  searchAgentConversationMessages(query: string, botId?: string, cursor?: string, limit = 100): ConversationSearchPage {
    return this.#options.agents.searchConversationMessages(query, botId, cursor, limit);
  }

  listAgentConversationReads(): Record<string, ConversationReadState> {
    return this.#options.agents.listConversationReads(this.#currentAgentReaderId());
  }

  markAgentConversationRead(input: MarkConversationReadInput): Promise<ConversationReadState> {
    return this.#options.agents.markConversationRead(input.botId, this.#currentAgentReaderId(), input.throughMessageId);
  }

  listDirectThreads(): DirectThreadSummary[] {
    if (!this.#options.store.configured) return [];
    const memberId = this.#findCurrentMemberId();
    return memberId ? this.#api.listDirectThreads(memberId) : [];
  }

  readDirectConversation(memberId: string): DirectConversationSnapshot {
    return this.#api.readDirectConversation(this.#currentMemberId(), memberId);
  }

  readDirectConversationPage(
    memberId: string,
    anchor: DirectConversationPageAnchor = { type: "latest" },
    limit = 50,
  ): DirectConversationPage {
    return this.#api.readDirectConversationPage(this.#currentMemberId(), memberId, anchor, limit);
  }

  sendDirectMessage(input: SendDirectMessageInput): DirectMessage {
    return this.#api.sendDirectMessage(this.#currentMemberId(), input);
  }

  markDirectRead(input: MarkDirectReadInput): DirectConversationReadState {
    return this.#api.markDirectRead(this.#currentMemberId(), input.memberId, input.throughSequence);
  }

  setDirectTyping(input: DirectTypingInput): void {
    this.#api.setLocalDirectTyping(this.#currentMemberId(), input.memberId, input.typing);
  }

  listInvites(): TeamInviteSummary[] | Promise<TeamInviteSummary[]> {
    const hostId = this.#options.store.getIdentity()?.serverId;
    if (hostId && this.#options.listRemoteInvites) {
      return this.#options.listRemoteInvites(hostId).then((invites) =>
        invites.map((invite) => ({
          id: invite.inviteId,
          role: invite.role,
          email: invite.email,
          expiresAt: new Date(invite.expiresAt).toISOString(),
          usedAt: invite.usedAt === null ? null : new Date(invite.usedAt).toISOString(),
        })),
      );
    }
    return this.#options.store.listInvites();
  }

  listSessions(): TeamSessionSummary[] {
    return this.#options.store.listSessions();
  }

  async updateMember(input: UpdateTeamMemberInput): Promise<TeamMemberSummary> {
    const hostId = this.#options.store.getIdentity()?.serverId;
    if (
      hostId &&
      this.#options.updateRemoteMember &&
      this.#options.removeRemoteMember &&
      this.#options.listRemoteMembers
    ) {
      const current = (await this.#options.listRemoteMembers(hostId)).find(
        (member) => member.membershipId === input.memberId,
      );
      if (!current || current.role === "owner") throw new Error("The remote member does not exist.");
      if (input.disabled) await this.#options.removeRemoteMember(hostId, input.memberId);
      else
        await this.#options.updateRemoteMember(
          hostId,
          input.memberId,
          input.role ?? current.role,
          input.disabled === false,
        );
      const members = await this.#options.listRemoteMembers(hostId);
      const updated = members.find((member) => member.membershipId === input.memberId);
      if (!updated) throw new Error("The remote member does not exist.");
      await this.#options.store.syncRemoteDirectory(members);
      return {
        id: updated.membershipId,
        username: updated.email,
        email: updated.email,
        name: updated.name,
        avatarUrl: updated.avatarUrl,
        role: updated.role,
        createdAt: new Date(updated.createdAt).toISOString(),
        disabled: updated.status !== "active",
      };
    }
    const member = await this.#options.store.updateMember(input.memberId, {
      ...(input.role ? { role: input.role } : {}),
      ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
    });
    if (member.disabled) await this.#remoteScreen.revokeMember(member.id);
    this.#api.refreshPresence();
    return member;
  }

  async removeMember(memberId: string): Promise<void> {
    const hostId = this.#options.store.getIdentity()?.serverId;
    if (hostId && this.#options.removeRemoteMember) {
      await this.#options.removeRemoteMember(hostId, memberId);
      if (this.#options.listRemoteMembers) {
        await this.#options.store.syncRemoteDirectory(await this.#options.listRemoteMembers(hostId));
      }
      return;
    }
    await this.#options.store.removeMember(memberId);
    await this.#remoteScreen.revokeMember(memberId);
    this.#api.refreshPresence();
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.#options.store.revokeSession(sessionId);
    await this.#remoteScreen.revokeTeamSession(sessionId);
    this.#api.refreshPresence();
  }

  revokeInvite(inviteId: string): Promise<void> {
    if (this.#options.revokeRemoteInvite) return this.#options.revokeRemoteInvite(inviteId);
    return this.#options.store.revokeInvite(inviteId);
  }

  async createInvite(input: CreateTeamInviteInput): Promise<InviteSummary> {
    const identity = this.#options.store.getIdentity();
    if (!identity) throw new Error("Name this OpenBot before publishing it.");
    if (this.#options.createRemoteInvite && this.#options.remoteControlPlaneUrl) {
      const invite = await this.#options.createRemoteInvite(identity.serverId, input);
      const inviteUrl = createInviteUrl({
        apiUrl: this.#options.remoteControlPlaneUrl,
        serverId: identity.serverId,
        fingerprint: identity.fingerprint,
        token: invite.token,
      });
      const result: InviteSummary = {
        id: invite.inviteId,
        role: input.role,
        expiresAt: new Date(invite.expiresAt).toISOString(),
        usedAt: null,
        inviteUrl,
        email: input.email ?? null,
      };
      if (input.email) {
        try {
          await this.#options.sendTeamInviteEmail({
            email: input.email,
            serverName: identity.serverName,
            inviteUrl,
            role: input.role,
          });
        } catch (error) {
          await this.#options.revokeRemoteInvite?.(invite.inviteId);
          throw error;
        }
      }
      return result;
    }
    if (!this.#status.apiUrl) throw new Error("Make this OpenBot public before creating an invite.");
    const invite = await this.#options.store.createInvite(input.role, input.email);
    const inviteUrl = createInviteUrl(
      {
        apiUrl: this.#status.apiUrl,
        serverId: identity.serverId,
        fingerprint: identity.fingerprint,
        token: invite.token,
      },
      { allowLocalDevelopmentApiUrl: this.#options.allowLocalDevelopmentInvites },
    );
    const result: InviteSummary = {
      id: invite.id,
      role: input.role,
      expiresAt: invite.expiresAt,
      usedAt: null,
      inviteUrl,
      email: invite.email,
    };
    if (invite.email) {
      try {
        await this.#options.sendTeamInviteEmail({
          email: invite.email,
          serverName: identity.serverName,
          inviteUrl: result.inviteUrl,
          role: input.role,
        });
      } catch (error) {
        await this.#options.store.revokeInvite(invite.id);
        throw error;
      }
    }
    return result;
  }

  async shutdown(): Promise<void> {
    await this.stop(false);
  }

  async #stopRuntime(): Promise<void> {
    await this.#webrtcGateway?.stop();
    await this.#api.stop();
  }

  #setStatus(patch: Partial<HostStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.emit("changed", this.getStatus());
  }

  #currentMemberId(): string {
    const memberId = this.#findCurrentMemberId();
    if (!memberId) throw new Error("Your team access is unavailable.");
    return memberId;
  }

  #currentAgentReaderId(): string {
    const accountReaderId = `local-user:${this.#options.getSignedInUser().id}`;
    const memberId = this.#findCurrentMemberId();
    if (!memberId) return accountReaderId;
    this.#options.agents.adoptConversationReads(accountReaderId, memberId);
    return memberId;
  }

  #findCurrentMemberId(): string | null {
    try {
      const email = this.#options.getSignedInUser().email.trim().toLowerCase();
      const member = this.#options.store
        .listMembers()
        .find(
          (candidate) =>
            candidate.email?.trim().toLowerCase() === email || candidate.username.trim().toLowerCase() === email,
        );
      return member && !member.disabled ? member.id : null;
    } catch {
      return null;
    }
  }

  #requiredOwnerMemberId(): string {
    const memberId = this.#options.store.getOwnerMemberId();
    if (!memberId) throw new Error("The host owner identity is unavailable.");
    return memberId;
  }
}

export function serverLogoUrl(version: string): string {
  return `openbot-server-logo://local/logo?v=${encodeURIComponent(version)}`;
}

function normalizeRemoteDesktopPlatform(platform: NodeJS.Platform): "darwin" | "win32" | "linux" {
  if (platform === "darwin" || platform === "win32") return platform;
  return "linux";
}
