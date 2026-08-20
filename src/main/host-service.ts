import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInviteUrl } from "@openbot/contracts/invite-links";
import type {
  CentralAuthUser,
  ConfigureHostInput,
  ConfigureRemoteDesktopInput,
  ConversationReadState,
  ConversationWithReadState,
  CreateTeamInviteInput,
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
  SendDirectMessageInput,
  SetTeamTypingInput,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamSessionSummary,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import type { MailboxStore } from "../backend/mailbox-store";
import type { TeamChatStore } from "../backend/team-chat-store";
import type { ProvisionedTeamTunnel } from "./central-auth-manager";
import { appendDiagnosticLog, probeRfbHandshake, resolveCloudflaredExecutable, stopOwnedProcess } from "./remote-mac";
import { TeamApiServer } from "./team-api-server";
import type { TeamStore } from "./team-store";

interface HostEvents {
  changed: [status: HostStatus];
  presence: [snapshot: TeamPresenceSnapshot];
  directMessage: [event: DirectMessageRealtimeEvent];
  directTyping: [event: DirectTypingRealtimeEvent];
}

interface HostServiceOptions {
  store: TeamStore;
  agents: AgentService;
  mailbox: MailboxStore;
  browser: BrowserHost;
  chat?: TeamChatStore;
  resolveCloudflared?: () => Promise<string | null>;
  spawnProcess?: typeof spawn;
  tunnelTimeoutMs?: number;
  publicReadyTimeoutMs?: number;
  logDirectory?: string;
  getSignedInUser: () => CentralAuthUser;
  redeemCentralTicket: (ticket: string, serverId: string) => Promise<CentralAuthUser | null>;
  sendTeamInviteEmail: (input: {
    email: string;
    serverName: string;
    inviteUrl: string;
    role: "admin" | "member";
  }) => Promise<void>;
  getRemoteDesktopPassword: () => string | null;
  setRemoteDesktopPassword: (password: string) => Promise<void>;
  provisionTeamTunnel: (input: {
    serverId: string;
    serverName: string;
    apiPort?: number | null;
    vncEnabled?: boolean;
  }) => Promise<ProvisionedTeamTunnel>;
}

export function buildNamedTunnelArgs(): string[] {
  return ["tunnel", "--protocol", "quic", "run"];
}

export function buildNamedTunnelEnvironment(token: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, TUNNEL_TOKEN: token };
}

export class HostService extends EventEmitter<HostEvents> {
  readonly #options: Required<Pick<HostServiceOptions, "spawnProcess" | "tunnelTimeoutMs" | "publicReadyTimeoutMs">> &
    Omit<HostServiceOptions, "spawnProcess" | "tunnelTimeoutMs" | "publicReadyTimeoutMs">;
  readonly #api: TeamApiServer;
  #tunnel: ChildProcess | null = null;
  #status: HostStatus;

  constructor(options: HostServiceOptions) {
    super();
    this.#options = {
      ...options,
      spawnProcess: options.spawnProcess ?? spawn,
      tunnelTimeoutMs: options.tunnelTimeoutMs ?? 30_000,
      publicReadyTimeoutMs: options.publicReadyTimeoutMs ?? 30_000,
    };
    const identity = options.store.getIdentity();
    this.#status = {
      phase: identity ? "idle" : "unconfigured",
      configured: Boolean(identity),
      enabledOnLaunch: identity?.enabledOnLaunch ?? false,
      serverId: identity?.serverId ?? null,
      serverName: identity?.serverName ?? null,
      apiUrl: null,
      vncHostname: null,
      apiOnline: false,
      vncOnline: false,
      remoteDesktopCredentialConfigured: options.getRemoteDesktopPassword() !== null,
      message: null,
    };
    this.#api = new TeamApiServer({
      store: options.store,
      agents: options.agents,
      mailbox: options.mailbox,
      browser: options.browser,
      getRemoteMac: () => ({
        hostname: this.#status.vncHostname,
        online: this.#status.vncOnline,
      }),
      getRemoteDesktopPassword: options.getRemoteDesktopPassword,
      redeemCentralTicket: options.redeemCentralTicket,
      chat: options.chat,
      onPresence: (snapshot) => this.emit("presence", snapshot),
      onDirectMessage: (event) => this.emit("directMessage", event),
      onDirectTyping: (event) => this.emit("directTyping", event),
    });
  }

  getStatus(): HostStatus {
    return { ...this.#status };
  }

  async syncSignedInAccount(user: CentralAuthUser): Promise<void> {
    if (!this.#options.store.configured) return;
    if (await this.#options.store.syncAccount(user)) this.#api.refreshPresence();
  }

  async configure(input: ConfigureHostInput): Promise<HostStatus> {
    const identity = await this.#options.store.configureWithAccount(input.serverName, this.#options.getSignedInUser());
    this.#setStatus({
      phase: "idle",
      configured: true,
      serverId: identity.serverId,
      serverName: identity.serverName,
      enabledOnLaunch: false,
      message: null,
    });
    this.#api.refreshPresence();
    try {
      const tunnel = await this.#options.provisionTeamTunnel({
        serverId: identity.serverId,
        serverName: identity.serverName,
      });
      this.#setStatus({
        apiUrl: tunnel.apiUrl,
        vncHostname: null,
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

  async configureRemoteDesktop(input: ConfigureRemoteDesktopInput): Promise<HostStatus> {
    const signedInUser = this.#options.getSignedInUser();
    this.#options.store.assertOwnerAccount(signedInUser);
    await this.syncSignedInAccount(signedInUser);
    await this.#options.setRemoteDesktopPassword(input.password);
    const vncOnline = this.#status.apiOnline ? await probeRfbHandshake(5900, 2_000) : false;
    this.#setStatus({
      remoteDesktopCredentialConfigured: true,
      vncOnline,
      message: vncOnline
        ? "Remote Desktop access is ready for all team members."
        : "Password saved. Enable macOS Screen Sharing and use the same VNC password.",
    });
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
        message: "Install cloudflared with: brew install cloudflared",
      });
      return this.getStatus();
    }

    try {
      const apiPort = await this.#api.start();
      const screenSharingReady = await probeRfbHandshake(5900, 2_000);
      const vncReady = screenSharingReady && this.#options.getRemoteDesktopPassword() !== null;
      this.#setStatus({ message: "Provisioning a stable openbot.run address…" });
      const identity = this.#options.store.getIdentity();
      if (!identity) throw new Error("Name this OpenBot before publishing it.");
      const provisioned = await this.#options.provisionTeamTunnel({
        serverId: identity.serverId,
        serverName: identity.serverName,
        apiPort,
        vncEnabled: false,
      });
      const tunnel = this.#spawnTunnel(executable, provisioned.token);
      this.#tunnel = tunnel;
      if (!(await waitForNamedTunnelConnection(tunnel, this.#options.tunnelTimeoutMs))) {
        throw new Error("The named Cloudflare Tunnel did not connect.");
      }
      this.#setStatus({
        apiUrl: provisioned.apiUrl,
        vncHostname: provisioned.vncHostname,
        message: "Publishing this OpenBot through its secure address…",
      });
      if (!(await waitForPublicApi(provisioned.apiUrl, this.#options.publicReadyTimeoutMs))) {
        throw new Error("Cloudflare did not publish the named tunnel address. Try again.");
      }
      this.#setStatus({
        apiOnline: true,
        vncOnline: vncReady,
        message: vncReady
          ? "This OpenBot and Remote Desktop are publicly reachable."
          : !screenSharingReady
            ? "This OpenBot is public. Only invited people can sign in."
            : "This OpenBot is public. Add the dedicated VNC password to enable Remote Desktop.",
      });
      await this.#options.store.setEnabledOnLaunch(true);
      this.#setStatus({ phase: "online", enabledOnLaunch: true });
    } catch (error) {
      await this.#stopRuntime();
      this.#setStatus({
        phase: "error",
        apiOnline: false,
        vncOnline: false,
        apiUrl: null,
        vncHostname: null,
        message: error instanceof Error ? error.message : "This OpenBot could not be published.",
      });
    }
    return this.getStatus();
  }

  async stop(persistPreference = true): Promise<HostStatus> {
    if (this.#status.phase === "unconfigured") return this.getStatus();
    this.#setStatus({ phase: "stopping", message: "Making this OpenBot private…" });
    await this.#stopRuntime();
    if (persistPreference) await this.#options.store.setEnabledOnLaunch(false);
    this.#setStatus({
      phase: "idle",
      enabledOnLaunch: persistPreference ? false : this.#status.enabledOnLaunch,
      apiUrl: null,
      vncHostname: null,
      apiOnline: false,
      vncOnline: false,
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
    this.#api.refreshPresence();
    return member;
  }

  async removeMember(memberId: string): Promise<void> {
    await this.#options.store.removeMember(memberId);
    this.#api.refreshPresence();
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.#options.store.revokeSession(sessionId);
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
    const inviteUrl = createInviteUrl({
      apiUrl: this.#status.apiUrl,
      serverId: identity.serverId,
      fingerprint: identity.fingerprint,
      token: invite.token,
    });
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
        vncOnline: false,
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

export async function waitForPublicApi(apiUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/v1/identity", apiUrl), {
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
