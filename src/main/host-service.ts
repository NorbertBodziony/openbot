import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import type { MailboxStore } from "../backend/mailbox-store";
import type {
  ConfigureHostInput,
  HostStatus,
  InviteSummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamRole,
  TeamSessionSummary,
  UpdateTeamMemberInput,
} from "../shared/ipc";
import {
  appendDiagnosticLog,
  probeRfbHandshake,
  resolveCloudflaredExecutable,
  stopOwnedProcess,
} from "./remote-mac";
import { TeamApiServer } from "./team-api-server";
import type { TeamStore } from "./team-store";

interface HostEvents {
  changed: [status: HostStatus];
}

interface HostServiceOptions {
  store: TeamStore;
  agents: AgentService;
  mailbox: MailboxStore;
  browser: BrowserHost;
  resolveCloudflared?: () => Promise<string | null>;
  spawnProcess?: typeof spawn;
  tunnelTimeoutMs?: number;
  logDirectory?: string;
}

export function buildApiTunnelArgs(port: number): string[] {
  return ["tunnel", "--protocol", "quic", "--url", `http://127.0.0.1:${port}`];
}

export function buildVncTunnelArgs(): string[] {
  return ["tunnel", "--protocol", "quic", "--url", "tcp://localhost:5900"];
}

export function parseQuickTunnelHostname(value: string): string | null {
  const match = value.match(/https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export class HostService extends EventEmitter<HostEvents> {
  readonly #options: Required<Pick<HostServiceOptions, "spawnProcess" | "tunnelTimeoutMs">> &
    Omit<HostServiceOptions, "spawnProcess" | "tunnelTimeoutMs">;
  readonly #api: TeamApiServer;
  #apiTunnel: ChildProcess | null = null;
  #vncTunnel: ChildProcess | null = null;
  #status: HostStatus;

  constructor(options: HostServiceOptions) {
    super();
    this.#options = {
      ...options,
      spawnProcess: options.spawnProcess ?? spawn,
      tunnelTimeoutMs: options.tunnelTimeoutMs ?? 15_000,
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
    });
  }

  getStatus(): HostStatus {
    return { ...this.#status };
  }

  async configure(input: ConfigureHostInput): Promise<HostStatus> {
    const identity = await this.#options.store.configure(
      input.serverName,
      input.username,
      input.password,
    );
    this.#setStatus({
      phase: "idle",
      configured: true,
      serverId: identity.serverId,
      serverName: identity.serverName,
      enabledOnLaunch: false,
      message: null,
    });
    return this.getStatus();
  }

  async start(): Promise<HostStatus> {
    if (!this.#options.store.configured) throw new Error("Configure the team server first.");
    if (this.#status.phase === "online" || this.#status.phase === "starting") {
      return this.getStatus();
    }
    this.#setStatus({ phase: "starting", message: "Starting the team API…" });
    const executable = await (this.#options.resolveCloudflared?.() ??
      resolveCloudflaredExecutable());
    if (!executable) {
      this.#setStatus({
        phase: "error",
        message: "Install cloudflared with: brew install cloudflared",
      });
      return this.getStatus();
    }

    try {
      const apiPort = await this.#api.start();
      const apiTunnel = this.#spawnTunnel(executable, buildApiTunnelArgs(apiPort), "api");
      this.#apiTunnel = apiTunnel;
      const apiHostname = await waitForTunnelHostname(apiTunnel, this.#options.tunnelTimeoutMs);
      if (!apiHostname) throw new Error("The API Quick Tunnel did not return a hostname.");
      this.#setStatus({
        apiUrl: `https://${apiHostname}`,
        apiOnline: true,
        message: "Checking macOS Screen Sharing…",
      });

      const vncReady = await probeRfbHandshake(5900, 2_000);
      if (vncReady) {
        const vncTunnel = this.#spawnTunnel(executable, buildVncTunnelArgs(), "vnc");
        this.#vncTunnel = vncTunnel;
        const vncHostname = await waitForTunnelHostname(vncTunnel, this.#options.tunnelTimeoutMs);
        this.#setStatus({
          vncHostname,
          vncOnline: Boolean(vncHostname),
          message: vncHostname
            ? "The team server and Remote Mac are online."
            : "The team server is online, but the VNC tunnel did not start.",
        });
      } else {
        this.#setStatus({
          vncHostname: null,
          vncOnline: false,
          message: "The team server is online. Enable macOS Screen Sharing to use Remote Mac.",
        });
      }
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
        message: error instanceof Error ? error.message : "Could not start the team server.",
      });
    }
    return this.getStatus();
  }

  async stop(persistPreference = true): Promise<HostStatus> {
    if (this.#status.phase === "unconfigured") return this.getStatus();
    this.#setStatus({ phase: "stopping", message: "Stopping the team server…" });
    await this.#stopRuntime();
    if (persistPreference) await this.#options.store.setEnabledOnLaunch(false);
    this.#setStatus({
      phase: "idle",
      enabledOnLaunch: persistPreference ? false : this.#status.enabledOnLaunch,
      apiUrl: null,
      vncHostname: null,
      apiOnline: false,
      vncOnline: false,
      message: "The team server is stopped.",
    });
    return this.getStatus();
  }

  listMembers(): TeamMemberSummary[] {
    return this.#options.store.listMembers();
  }

  listInvites(): TeamInviteSummary[] {
    return this.#options.store.listInvites();
  }

  listSessions(): TeamSessionSummary[] {
    return this.#options.store.listSessions();
  }

  updateMember(input: UpdateTeamMemberInput): Promise<TeamMemberSummary> {
    return this.#options.store.updateMember(input.memberId, {
      ...(input.role ? { role: input.role } : {}),
      ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
    });
  }

  revokeSession(sessionId: string): Promise<void> {
    return this.#options.store.revokeSession(sessionId);
  }

  revokeInvite(inviteId: string): Promise<void> {
    return this.#options.store.revokeInvite(inviteId);
  }

  createAddressUpdate(): string {
    if (!this.#status.apiUrl) throw new Error("Start the team server first.");
    const proof = this.#options.store.createAddressUpdateProof(
      this.#status.apiUrl,
      this.#status.vncHostname,
    );
    const url = new URL("openbot://update");
    url.searchParams.set("api", proof.apiUrl);
    url.searchParams.set("server", proof.serverId);
    if (proof.vncHostname) url.searchParams.set("vnc", proof.vncHostname);
    url.searchParams.set("key", Buffer.from(proof.publicKey).toString("base64url"));
    url.searchParams.set("signature", proof.signature);
    return url.toString();
  }

  async createInvite(role: Exclude<TeamRole, "owner">): Promise<InviteSummary> {
    if (!this.#status.apiUrl) throw new Error("Start the team server before creating an invite.");
    const identity = this.#options.store.getIdentity();
    if (!identity) throw new Error("Configure the team server first.");
    const invite = await this.#options.store.createInvite(role);
    const url = new URL("openbot://join");
    url.searchParams.set("api", this.#status.apiUrl);
    url.searchParams.set("server", identity.serverId);
    url.searchParams.set("fingerprint", identity.fingerprint);
    url.searchParams.set("invite", invite.token);
    return {
      id: invite.id,
      role,
      expiresAt: invite.expiresAt,
      usedAt: null,
      inviteUrl: url.toString(),
    };
  }

  async shutdown(): Promise<void> {
    await this.stop(false);
  }

  #spawnTunnel(executable: string, args: string[], kind: "api" | "vnc"): ChildProcess {
    const child = this.#options.spawnProcess(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.once("exit", () => {
      if (this.#status.phase === "stopping" || this.#status.phase === "idle") return;
      this.#setStatus(
        kind === "api"
          ? {
              phase: "error",
              apiOnline: false,
              message: "The API tunnel stopped unexpectedly.",
            }
          : { vncOnline: false, message: "The VNC tunnel stopped unexpectedly." },
      );
    });
    if (this.#options.logDirectory) {
      child.stdout?.on(
        "data",
        (chunk) =>
          void appendDiagnosticLog(this.#options.logDirectory as string, `host-${kind}`, chunk),
      );
      child.stderr?.on(
        "data",
        (chunk) =>
          void appendDiagnosticLog(this.#options.logDirectory as string, `host-${kind}`, chunk),
      );
    }
    return child;
  }

  async #stopRuntime(): Promise<void> {
    const children = [this.#apiTunnel, this.#vncTunnel].filter(
      (child): child is ChildProcess => child !== null,
    );
    this.#apiTunnel = null;
    this.#vncTunnel = null;
    await Promise.all(children.map((child) => stopOwnedProcess(child)));
    await this.#api.stop();
  }

  #setStatus(patch: Partial<HostStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.emit("changed", this.getStatus());
  }
}

function waitForTunnelHostname(child: ChildProcess, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (hostname: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(hostname);
    };
    const onData = (chunk: Buffer) => {
      buffer = `${buffer}${chunk.toString("utf8")}`.slice(-16_000);
      const hostname = parseQuickTunnelHostname(buffer);
      if (hostname) finish(hostname);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}
