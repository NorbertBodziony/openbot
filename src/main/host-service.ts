import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInviteUrl } from "@openbot/contracts/invite-links";
import type {
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
import type { ProvisionedTeamTunnel } from "./central-auth-manager";
import { appendDiagnosticLog, resolveCloudflaredExecutable, stopOwnedProcess } from "./host-tunnel-runtime";
import type { RemoteDesktopRuntimePaths } from "./remote-desktop-runtime-artifact";
import { RemoteScreenGateway } from "./remote-screen-gateway";
import { TeamApiServer } from "./team-api-server";
import type { AuthenticatedMember, TeamStore } from "./team-store";

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
  resolveCloudflared?: () => Promise<string | null>;
  spawnProcess?: typeof spawn;
  tunnelTimeoutMs?: number;
  publicReadyTimeoutMs?: number;
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
  provisionTeamTunnel: (input: {
    serverId: string;
    serverName: string;
    apiPort?: number | null;
  }) => Promise<ProvisionedTeamTunnel>;
}

export function buildNamedTunnelArgs(): string[] {
  return ["tunnel", "--protocol", "quic", "run"];
}

export function buildNamedTunnelEnvironment(token: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, TUNNEL_TOKEN: token };
}

export class HostService extends EventEmitter<HostEvents> {
  readonly #options: Required<
    Pick<
      HostServiceOptions,
      "spawnProcess" | "tunnelTimeoutMs" | "publicReadyTimeoutMs" | "allowLocalDevelopmentInvites"
    >
  > &
    Omit<
      HostServiceOptions,
      "spawnProcess" | "tunnelTimeoutMs" | "publicReadyTimeoutMs" | "allowLocalDevelopmentInvites"
    >;
  readonly #api: TeamApiServer;
  readonly #remoteScreen: RemoteScreenGateway;
  #tunnel: ChildProcess | null = null;
  #status: HostStatus;
  #legacyCredentialRemoved = false;

  constructor(options: HostServiceOptions) {
    super();
    this.#options = {
      ...options,
      spawnProcess: options.spawnProcess ?? spawn,
      tunnelTimeoutMs: options.tunnelTimeoutMs ?? 30_000,
      publicReadyTimeoutMs: options.publicReadyTimeoutMs ?? 30_000,
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
      getIceServers: options.getRemoteDesktopIceServers ?? (async () => [{ urls: "stun:stun.cloudflare.com:3478" }]),
      ...(logDirectory
        ? {
            onDiagnostic: (source: "sunshine" | "moonlight", message: string) => {
              void appendDiagnosticLog(logDirectory, `remote-screen-${source}`, message);
            },
          }
        : {}),
      audit: (event) => {
        if (options.logDirectory) {
          void appendDiagnosticLog(options.logDirectory, "remote-screen", `${JSON.stringify(event)}\n`);
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
      const tunnel = await this.#options.provisionTeamTunnel({
        serverId: identity.serverId,
        serverName: identity.serverName,
      });
      this.#setStatus({
        apiUrl: tunnel.apiUrl,
        message: `Reserved ${new URL(tunnel.apiUrl).hostname}.`,
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
    this.#setStatus({ phase: "starting", message: "Starting the secure public API…" });
    const executable = await (this.#options.resolveCloudflared?.() ?? resolveCloudflaredExecutable());
    if (!executable) {
      this.#setStatus({
        phase: "error",
        message: "The bundled cloudflared executable is unavailable. Reinstall or update OpenBot.",
      });
      return this.getStatus();
    }

    try {
      const apiPort = await this.#api.start();
      this.#setStatus({ message: "Provisioning a stable openbot.run address…" });
      const identity = this.#options.store.getIdentity();
      if (!identity) throw new Error("Name this OpenBot before publishing it.");
      const provisioned = await this.#options.provisionTeamTunnel({
        serverId: identity.serverId,
        serverName: identity.serverName,
        apiPort,
      });
      const tunnel = this.#spawnTunnel(executable, provisioned.token);
      this.#tunnel = tunnel;
      if (!(await waitForNamedTunnelConnection(tunnel, this.#options.tunnelTimeoutMs))) {
        throw new Error("The named Cloudflare Tunnel did not connect.");
      }
      this.#setStatus({
        apiUrl: provisioned.apiUrl,
        message: "Publishing this OpenBot through its secure address…",
      });
      if (!(await waitForPublicApi(provisioned.apiUrl, this.#options.publicReadyTimeoutMs))) {
        throw new Error("Cloudflare did not publish the named tunnel address. Try again.");
      }
      this.#setStatus({
        apiOnline: true,
        message: "This OpenBot and WebRTC remote control are publicly reachable.",
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

  listMembers(): TeamMemberSummary[] {
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

  listInvites(): TeamInviteSummary[] {
    return this.#options.store.listInvites();
  }

  listSessions(): TeamSessionSummary[] {
    return this.#options.store.listSessions();
  }

  async updateMember(input: UpdateTeamMemberInput): Promise<TeamMemberSummary> {
    const member = await this.#options.store.updateMember(input.memberId, {
      ...(input.role ? { role: input.role } : {}),
      ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
    });
    if (member.disabled) await this.#remoteScreen.revokeMember(member.id);
    this.#api.refreshPresence();
    return member;
  }

  async removeMember(memberId: string): Promise<void> {
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
    return this.#options.store.revokeInvite(inviteId);
  }

  async createInvite(input: CreateTeamInviteInput): Promise<InviteSummary> {
    if (!this.#status.apiUrl) throw new Error("Make this OpenBot public before creating an invite.");
    const identity = this.#options.store.getIdentity();
    if (!identity) throw new Error("Name this OpenBot before publishing it.");
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

  #spawnTunnel(executable: string, token: string): ChildProcess {
    const child = this.#options.spawnProcess(executable, buildNamedTunnelArgs(), {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildNamedTunnelEnvironment(token),
    });
    child.once("exit", () => {
      if (this.#status.phase === "stopping" || this.#status.phase === "idle") return;
      this.#setStatus({
        phase: "error",
        apiOnline: false,
        message: "The named Cloudflare Tunnel stopped unexpectedly.",
      });
    });
    const logDirectory = this.#options.logDirectory;
    if (logDirectory) {
      child.stdout?.on("data", (chunk) => void appendDiagnosticLog(logDirectory, "host-tunnel", chunk));
      child.stderr?.on("data", (chunk) => void appendDiagnosticLog(logDirectory, "host-tunnel", chunk));
    }
    return child;
  }

  async #stopRuntime(): Promise<void> {
    const tunnel = this.#tunnel;
    this.#tunnel = null;
    if (tunnel) await stopOwnedProcess(tunnel);
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
}

export function serverLogoUrl(version: string): string {
  return `openbot-server-logo://local/logo?v=${encodeURIComponent(version)}`;
}

function normalizeRemoteDesktopPlatform(platform: NodeJS.Platform): "darwin" | "win32" | "linux" {
  if (platform === "darwin" || platform === "win32") return platform;
  return "linux";
}

export async function waitForPublicApi(apiUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/v1/compatibility", apiUrl), {
        signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, timeoutMs))),
      });
      if (response.ok) return true;
    } catch {
      // A named tunnel can need a short configuration propagation delay.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export function waitForNamedTunnelConnection(
  child: {
    stdout: { on: (event: string, listener: (chunk: Buffer) => void) => unknown } | null;
    stderr: { on: (event: string, listener: (chunk: Buffer) => void) => unknown } | null;
    once(event: string, listener: (...args: unknown[]) => unknown): unknown;
  },
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(connected);
    };
    const onData = (chunk: Buffer) => {
      buffer = `${buffer}${chunk.toString("utf8")}`.slice(-16_000);
      if (/Registered tunnel connection|Connection .* registered/iu.test(buffer)) finish(true);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", () => finish(false));
    child.once("exit", () => finish(false));
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
