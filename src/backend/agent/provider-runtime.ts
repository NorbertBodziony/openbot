import { type ChildProcess, spawn } from "node:child_process";
import type {
  AccountUsage,
  AgentEvent,
  AgentModelOption,
  AgentProviderStatus,
  AgentStatus,
  AgentSummary,
} from "@openbot/contracts/ipc";
import { isReasoningEffort } from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import type { AgentClient, AgentProvider } from "./../agent-client";
import { CodexAppServerClient } from "./../app-server-client";
import {
  type AgentCliInfo,
  CodexCliError,
  type CodexCliInfo,
  resolveClaudeCli,
  resolveCodexCli,
  resolveGrokCli,
} from "./../cli";
import {
  type AccountLoginCompletedResult,
  type AccountReadResult,
  decodeAccountLoginStartResult,
  decodeAccountRateLimitsReadResult,
  decodeAccountReadResult,
  decodeModelListResponse,
  decodeRecordResponse,
  getArray,
  isRecord,
} from "./../protocol";
import { BUILT_IN_PROVIDER_DRIVERS, requireProviderDriver } from "./../provider-drivers";
import { normalizeAccountUsage } from "./account-usage";
import type { ConversationRuntime } from "./conversation-runtime";
import {
  providerFailureStatus,
  setProviderStatus,
  updateProviderStatus,
  waitForSuccessfulProcess,
} from "./provider-status";
import { cleanModelName, providerForAgent, providerLabel } from "./thread-items";

const CODEX_LOGIN_TIMEOUT_MS = 10 * 60_000;
const CLAUDE_LOGIN_TIMEOUT_MS = 10 * 60_000;
const GROK_LOGIN_TIMEOUT_MS = 10 * 60_000;

interface PendingCodexLogin {
  client: AgentClient;
  cli: CodexCliInfo;
  loginId: string;
  timer: NodeJS.Timeout;
  completing: boolean;
}

interface PendingClaudeLogin {
  child: ChildProcess;
  cli: AgentCliInfo;
  task: Promise<void> | null;
}

export type AgentClientFactory = (provider: AgentProvider, cli: AgentCliInfo) => AgentClient;

/** What the provider domain needs from the rest of the service. Four calls, no state. */
export interface ProviderHooks {
  /** Wires the notification and server-request routers, which stay in the core. */
  bindClient(client: AgentClient): void;
  /**
   * Runs after a connect or an activation leaves at least one client ready. Collapses the tail
   * that #connect and #activateProviderClient each carried a copy of.
   */
  onProvidersReady(): Promise<void>;
  /** The cleanup #handleExit used to inline: prompts, approvals, takeovers, compaction, browser. */
  onProviderLost(client: AgentClient): void;
  /** True once stop() has begun, so a client exiting during shutdown does not trigger a restart. */
  isStopping(): boolean;
}

/**
 * The read-only view other domains get. #status is read outside the provider domain in five
 * places and every one of them asks the same question, so they get a boolean rather than the
 * status object.
 */
export interface ProviderPort {
  isReady(): boolean;
  clientFor(provider: AgentProvider): AgentClient | null;
  clientForAgent(agent: AgentSummary): AgentClient | null;
  listModels(): AgentModelOption[];
}

const INITIAL_STATUS: AgentStatus = {
  phase: "idle",
  cliVersion: null,
  auth: { kind: "unknown" },
  providers: [
    { id: "codex", state: "not-started", version: null, message: null },
    { id: "claude", state: "not-started", version: null, message: null },
    { id: "grok", state: "not-started", version: null, message: null },
  ],
  capabilities: {
    chat: "unavailable",
    browser: "ready",
    computerUse: "unavailable",
  },
  message: null,
  fullAccess: true,
};

const FALLBACK_MODELS: AgentModelOption[] = [
  {
    provider: "codex",
    id: "gpt-5.6-luna",
    name: "Luna",
    description: "Fast and efficient for everyday agent work.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "codex",
    id: "gpt-5.6-terra",
    name: "Terra",
    description: "Balanced speed and capability for involved tasks.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "codex",
    id: "gpt-5.6-sol",
    name: "Sol",
    description: "Most capable for complex, long-running work.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "claude",
    id: "claude-fable-5",
    name: "Claude Fable 5",
    description: "Fast Claude model for everyday agent work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "claude",
    id: "claude-opus-5",
    name: "Claude Opus 5",
    description: "Most capable Claude model for complex work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    provider: "claude",
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    description: "Balanced Claude model for general agent work.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
];

const CURATED_CODEX_MODEL_IDS = new Set(
  FALLBACK_MODELS.filter((model) => model.provider === "codex").map((model) => model.id),
);

/**
 * Owns provider processes, their CLIs, accounts, login flows and the derived AgentStatus.
 *
 * Everything here is keyed by AgentProvider and nothing else is. The class exists because
 * #status was read in five places outside this domain and written in sixteen inside it; the
 * ProviderPort above is what those five places get now.
 */
export class ProviderRuntime implements ProviderPort {
  readonly #conversation: ConversationRuntime;
  readonly #hooks: ProviderHooks;
  readonly #emit: (event: AgentEvent) => void;
  readonly #emitError: (code: string, error: unknown, agentId?: string) => void;
  readonly #requestTimeoutMs: number;
  readonly #clientFactory: AgentClientFactory | null;
  readonly #bundledCodexExecutable: string | null | undefined;
  readonly #bundledClaudeExecutable: string | null | undefined;
  readonly #bundledGrokExecutable: string | null | undefined;
  readonly #clients = new Map<AgentProvider, AgentClient>();
  readonly #cli = new Map<AgentProvider, AgentCliInfo>();
  readonly #accounts = new Map<AgentProvider, AccountReadResult["account"]>();
  readonly #providerStarts = new Map<AgentProvider, Promise<void>>();
  readonly #providerConnectionCommands = new Map<AgentProvider, Promise<void>>();
  #status: AgentStatus = structuredClone(INITIAL_STATUS);
  #providerRefresh: Promise<AgentStatus> | null = null;
  #codexLogin: PendingCodexLogin | null = null;
  #claudeLogin: PendingClaudeLogin | null = null;
  #grokLogin: PendingClaudeLogin | null = null;
  #providerActivation = Promise.resolve();
  #preferredProvider: AgentProvider;
  #restartAttempts = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #models = structuredClone(FALLBACK_MODELS);

  constructor(options: {
    conversation: ConversationRuntime;
    hooks: ProviderHooks;
    emit: (event: AgentEvent) => void;
    emitError: (code: string, error: unknown, agentId?: string) => void;
    requestTimeoutMs: number;
    preferredProvider: AgentProvider;
    clientFactory: AgentClientFactory | null;
    bundledCodexExecutable: string | null | undefined;
    bundledClaudeExecutable: string | null | undefined;
    bundledGrokExecutable: string | null | undefined;
  }) {
    this.#conversation = options.conversation;
    this.#hooks = options.hooks;
    this.#emit = options.emit;
    this.#emitError = options.emitError;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#preferredProvider = options.preferredProvider;
    this.#clientFactory = options.clientFactory;
    this.#bundledCodexExecutable = options.bundledCodexExecutable;
    this.#bundledClaudeExecutable = options.bundledClaudeExecutable;
    this.#bundledGrokExecutable = options.bundledGrokExecutable;
  }

  status(): AgentStatus {
    return structuredClone(this.#status);
  }

  isReady(): boolean {
    return this.#status.phase === "ready";
  }

  clientFor(provider: AgentProvider): AgentClient | null {
    return this.#clients.get(provider) ?? null;
  }

  listModels(): AgentModelOption[] {
    return structuredClone(this.#models);
  }

  preferredProvider(): AgentProvider {
    return this.#preferredProvider;
  }

  /**
   * Without a scope this is the account-wide reading the dock polls, and it broadcasts.
   * Scoped to one agent it answers for that agent's own model and stays quiet: the reply goes to
   * the caller that asked, so it must not overwrite the account-wide figure every other view shows.
   */
  async usage(scope?: { provider: AgentProvider; model: string }): Promise<AccountUsage> {
    if (!scope) {
      const client = this.#clients.get("codex");
      return client ? this.#refreshUsage(client) : { limits: [] };
    }
    const client = this.#clients.get(scope.provider);
    return client ? this.#refreshUsage(client, scope.model, false) : { limits: [] };
  }

  async start(): Promise<void> {
    await this.#connect(
      "starting",
      BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.id),
    );
  }

  async setPreferredProvider(provider: AgentProvider, initialized: boolean): Promise<void> {
    this.#preferredProvider = provider;
    if (!initialized) return;
    await this.ensureProvider(provider).catch(() => undefined);
    const account = this.#accounts.get(provider);
    if (!this.#clients.has(provider) || !account) return;
    this.#setStatus({
      cliVersion: this.#cli.get(provider)?.version ?? null,
      auth: requireProviderDriver(provider).authState(account),
    });
  }

  async ensureProvider(provider: AgentProvider): Promise<void> {
    if (this.#clients.has(provider)) return;
    let start = this.#providerStarts.get(provider);
    if (!start) {
      start = this.#connect("starting", [provider]).finally(() => {
        this.#providerStarts.delete(provider);
      });
      this.#providerStarts.set(provider, start);
    }
    await start;
    if (this.#clients.has(provider)) return;
    const status = this.#status.providers?.find((candidate) => candidate.id === provider);
    throw new Error(status?.message ?? `${providerLabel(provider)} CLI is not ready or signed in.`);
  }

  refreshProviders(): Promise<AgentStatus> {
    if (this.#providerRefresh) return this.#providerRefresh;
    if (this.#status.phase === "starting" || this.#status.phase === "restarting") {
      return Promise.resolve(this.status());
    }

    const refresh = this.#refreshProviders().finally(() => {
      if (this.#providerRefresh === refresh) this.#providerRefresh = null;
    });
    this.#providerRefresh = refresh;
    return refresh;
  }

  async refreshProvider(provider: AgentProvider): Promise<AgentStatus> {
    if (this.#clients.has(provider)) return this.status();
    let start = this.#providerStarts.get(provider);
    if (!start) {
      start = this.#connect("starting", [provider], {
        preserveCheckErrors: true,
        refreshRuntimeInBackground: true,
      }).finally(() => {
        this.#providerStarts.delete(provider);
      });
      this.#providerStarts.set(provider, start);
    }
    await start;
    return this.status();
  }

  async connectChatGPT(openExternal: (url: string) => Promise<void>): Promise<AgentStatus> {
    const start = this.#providerStarts.get("codex");
    if (start) await start;
    if (start && this.#clients.has("codex") && this.#accounts.has("codex")) return this.status();
    if (this.#providerRefresh || (!start && ["starting", "restarting"].includes(this.#status.phase))) {
      return Promise.resolve(this.status());
    }
    return this.#runProviderConnectionCommand("codex", async () => {
      await this.#cancelCodexLogin(null);
      return this.#startCodexLogin(openExternal);
    });
  }

  async connectClaude(): Promise<AgentStatus> {
    const start = this.#providerStarts.get("claude");
    if (start) await start;
    if (start && this.#clients.has("claude") && this.#accounts.has("claude")) return this.status();
    if (this.#providerRefresh || (!start && ["starting", "restarting"].includes(this.#status.phase))) {
      return Promise.resolve(this.status());
    }
    return this.#runProviderConnectionCommand("claude", async () => {
      await this.#cancelClaudeLogin(null);
      return this.#startClaudeLogin();
    });
  }

  async connectGrok(): Promise<AgentStatus> {
    const start = this.#providerStarts.get("grok");
    if (start) await start;
    if (start && this.#clients.has("grok") && this.#accounts.has("grok")) return this.status();
    if (this.#providerRefresh || (!start && ["starting", "restarting"].includes(this.#status.phase))) {
      return Promise.resolve(this.status());
    }
    return this.#runProviderConnectionCommand("grok", async () => {
      await this.#cancelGrokLogin(null);
      return this.#startGrokLogin();
    });
  }

  clientForAgent(agent: AgentSummary): AgentClient | null {
    return this.#clients.get(providerForAgent(agent)) ?? null;
  }

  requireReadyClient(provider: AgentProvider): AgentClient {
    const client = this.#clients.get(provider);
    if (!client || this.#status.phase !== "ready") {
      throw new Error(this.#status.message ?? `${providerLabel(provider)} CLI is not ready or signed in.`);
    }
    return client;
  }

  /** Router arm: the CLI reports a finished ChatGPT browser login. */
  completeCodexLogin(
    params: unknown,
    source: AgentClient,
    decode: (params: unknown) => AccountLoginCompletedResult,
  ): void {
    try {
      const completion = decode(params);
      void this.#runProviderConnectionCommand("codex", async () => {
        await this.#completeCodexLogin(completion, source);
        return this.status();
      });
    } catch {
      const pending = this.#codexLogin;
      if (pending) void this.#failCodexLogin(pending, "OpenBot could not verify the ChatGPT connection. Try again.");
    }
  }

  /** Router arm: the bundled computer-use MCP server changed state. */
  setComputerUseCapability(computerUse: "ready" | "setup-required"): void {
    this.#setStatus({ capabilities: { ...this.#status.capabilities, computerUse } });
  }

  /** Router arm: the CLI pushed new rate limits. */
  refreshCodexUsage(): void {
    const client = this.#clients.get("codex");
    if (client) void this.#refreshUsage(client).catch(() => undefined);
  }

  /**
   * The provider half of stop(). Returns the clients the caller still has to await, because
   * stop() interleaves that wait with the mailbox and image-generation teardown.
   */
  dispose(): AgentClient[] {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const pendingLogin = this.#codexLogin;
    this.#codexLogin = null;
    const claudeLogin = this.#claudeLogin;
    this.#claudeLogin = null;
    const grokLogin = this.#grokLogin;
    this.#grokLogin = null;
    this.#providerConnectionCommands.clear();
    if (claudeLogin?.child.exitCode === null) claudeLogin.child.kill("SIGTERM");
    if (grokLogin?.child.exitCode === null) grokLogin.child.kill("SIGTERM");
    if (pendingLogin) clearTimeout(pendingLogin.timer);
    const clients = [...this.#clients.values(), ...(pendingLogin ? [pendingLogin.client] : [])];
    this.#clients.clear();
    return clients;
  }

  markStopped(): void {
    this.#setStatus({ phase: "stopped", message: null });
  }

  async #runProviderConnectionCommand(
    provider: AgentProvider,
    command: () => Promise<AgentStatus>,
  ): Promise<AgentStatus> {
    const previous = this.#providerConnectionCommands.get(provider) ?? Promise.resolve();
    let result = this.status();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        result = await command();
      });
    this.#providerConnectionCommands.set(provider, current);
    try {
      await current;
      return result;
    } finally {
      if (this.#providerConnectionCommands.get(provider) === current) {
        this.#providerConnectionCommands.delete(provider);
      }
    }
  }

  async #refreshProviders(): Promise<AgentStatus> {
    await Promise.all([
      this.#runProviderConnectionCommand("codex", () => this.#settleCodexLoginForRefresh()),
      this.#runProviderConnectionCommand("claude", async () => {
        await this.#cancelClaudeLogin(null);
        return this.status();
      }),
      this.#runProviderConnectionCommand("grok", async () => {
        await this.#cancelGrokLogin(null);
        return this.status();
      }),
    ]);

    const activeClients = [...this.#clients];
    if (activeClients.length > 0) {
      let providers = this.#status.providers;
      for (const [provider] of activeClients) {
        providers = updateProviderStatus(providers, provider, {
          state: "checking",
          version: this.#cli.get(provider)?.version ?? null,
          message: null,
          email: this.#accounts.get(provider)?.email ?? null,
          checkError: null,
        });
      }
      this.#setStatus({ providers });
    }

    await Promise.all(
      activeClients.map(async ([provider, client]) => {
        try {
          const account = await client.request("account/read", { refreshToken: true }, decodeAccountReadResult, 5_000);
          if (account.account) {
            requireProviderDriver(provider).validateAccount(account.account);
            this.#accounts.set(provider, account.account);
            this.#setStatus({
              providers: updateProviderStatus(this.#status.providers, provider, {
                state: "available",
                version: this.#cli.get(provider)?.version ?? null,
                message: null,
                email: account.account.email ?? null,
                checkError: null,
              }),
            });
            return;
          }
          this.#clients.delete(provider);
          this.#cli.delete(provider);
          this.#accounts.delete(provider);
          await client.stop().catch(() => undefined);
        } catch {
          // Keep a working client when an explicit account refresh is temporarily unavailable.
          const label = provider === "codex" ? "ChatGPT" : providerLabel(provider);
          this.#setStatus({
            providers: updateProviderStatus(this.#status.providers, provider, {
              state: "available",
              version: this.#cli.get(provider)?.version ?? null,
              message: null,
              email: this.#accounts.get(provider)?.email ?? null,
              checkError: `Could not verify ${label}. Keeping the existing connection.`,
            }),
          });
        }
      }),
    );

    await this.#connect(
      "starting",
      BUILT_IN_PROVIDER_DRIVERS.map((driver) => driver.id),
      { preserveCheckErrors: true, refreshRuntimeInBackground: true },
    );
    return this.status();
  }

  async #settleCodexLoginForRefresh(): Promise<AgentStatus> {
    const pending = this.#codexLogin;
    if (!pending) {
      this.#clearProviderConnectionState("codex");
      return this.status();
    }
    this.#codexLogin = null;
    clearTimeout(pending.timer);
    try {
      const account = await pending.client.request("account/read", { refreshToken: true }, decodeAccountReadResult);
      if (account.account?.type === "chatgpt") {
        await this.#activateProviderClient("codex", pending.client, pending.cli, account.account);
        return this.status();
      }
    } catch {
      // Fall through to cancellation and a fresh provider probe.
    }
    await pending.client
      .request("account/login/cancel", { loginId: pending.loginId }, decodeRecordResponse)
      .catch(() => undefined);
    await pending.client.stop().catch(() => undefined);
    this.#clearProviderConnectionState("codex");
    return this.status();
  }

  async #createAuthenticatedProviderClient(
    provider: AgentProvider,
    cli: AgentCliInfo,
  ): Promise<{ client: AgentClient; account: NonNullable<AccountReadResult["account"]> }> {
    const driver = requireProviderDriver(provider);
    const client = this.#clientFactory
      ? this.#clientFactory(provider, cli)
      : driver.createClient(cli, this.#requestTimeoutMs);
    this.#bindClient(client);
    client.start();
    try {
      await client.request(
        "initialize",
        {
          clientInfo: { name: "openbot", title: "OpenBot", version: "0.1.0" },
          capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
        },
        decodeRecordResponse,
      );
      client.notify("initialized");
      const account = await client.request("account/read", { refreshToken: true }, decodeAccountReadResult);
      if (!account.account) throw new Error(`${providerLabel(provider)} did not return an authenticated account.`);
      driver.validateAccount(account.account);
      return { client, account: account.account };
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw error;
    }
  }

  async #activateProviderClient(
    provider: AgentProvider,
    client: AgentClient,
    cli: AgentCliInfo,
    account: NonNullable<AccountReadResult["account"]>,
    isCurrent?: () => boolean,
  ): Promise<void> {
    const activation = this.#providerActivation
      .catch(() => undefined)
      .then(async () => {
        if (isCurrent && !isCurrent()) {
          await client.stop().catch(() => undefined);
          return;
        }
        const previousClient = this.#clients.get(provider);
        const previousCli = this.#cli.get(provider);
        const previousAccount = this.#accounts.get(provider);
        this.#clients.set(provider, client);
        this.#cli.set(provider, cli);
        this.#accounts.set(provider, account);
        try {
          await this.#refreshModelCatalog();
          if (isCurrent && !isCurrent()) {
            if (previousClient) this.#clients.set(provider, previousClient);
            else this.#clients.delete(provider);
            if (previousCli) this.#cli.set(provider, previousCli);
            else this.#cli.delete(provider);
            if (previousAccount) this.#accounts.set(provider, previousAccount);
            else this.#accounts.delete(provider);
            if (client !== previousClient) await client.stop().catch(() => undefined);
            return;
          }
          const primaryProvider = this.#clients.has(this.#preferredProvider)
            ? this.#preferredProvider
            : this.#clients.has("codex")
              ? "codex"
              : provider;
          const primaryAccount = this.#accounts.get(primaryProvider);
          const codexClient = this.#clients.get("codex");
          const computerUse = codexClient ? await this.#probeComputerUse(codexClient) : "unavailable";
          this.#conversation.clearLoadedThreads();
          this.#setStatus({
            phase: "ready",
            cliVersion: this.#cli.get(primaryProvider)?.version ?? null,
            auth: requireProviderDriver(primaryProvider).authState(primaryAccount ?? null),
            providers: updateProviderStatus(this.#status.providers, provider, {
              state: "available",
              version: cli.version,
              message: null,
              email: account.email ?? null,
            }),
            capabilities: { chat: "ready", browser: "ready", computerUse },
            message: null,
          });
        } catch (error) {
          if (previousClient) this.#clients.set(provider, previousClient);
          else this.#clients.delete(provider);
          if (previousCli) this.#cli.set(provider, previousCli);
          else this.#cli.delete(provider);
          if (previousAccount) this.#accounts.set(provider, previousAccount);
          else this.#accounts.delete(provider);
          if (client !== previousClient) await client.stop().catch(() => undefined);
          throw error;
        }

        if (previousClient && previousClient !== client) await previousClient.stop().catch(() => undefined);
        if (provider === "codex") void this.#refreshUsage(client).catch(() => undefined);
        await this.#hooks.onProvidersReady();
      });
    this.#providerActivation = activation.catch(() => undefined);
    await activation;
  }

  #setProviderConnectionState(provider: AgentProvider, connectionState: "connecting"): void {
    const current = this.#status.providers?.find((candidate) => candidate.id === provider);
    this.#setStatus({
      providers: updateProviderStatus(this.#status.providers, provider, {
        state: this.#clients.has(provider) ? "available" : (current?.state ?? "checking"),
        version: this.#cli.get(provider)?.version ?? current?.version ?? null,
        message: null,
        email: this.#accounts.get(provider)?.email ?? current?.email ?? null,
        connectionState,
      }),
    });
  }

  #clearProviderConnectionState(provider: AgentProvider): void {
    const current = this.#status.providers?.find((candidate) => candidate.id === provider);
    if (!current?.connectionState) return;
    this.#setStatus({
      providers: updateProviderStatus(this.#status.providers, provider, {
        state: this.#clients.has(provider) ? "available" : current.state,
        version: this.#cli.get(provider)?.version ?? current.version,
        message: null,
        email: this.#accounts.get(provider)?.email ?? current.email ?? null,
      }),
    });
  }

  #setProviderConnectionFailure(provider: AgentProvider, error: unknown, version?: string | null): void {
    const hasActiveClient = this.#clients.has(provider);
    const fallbackMessage = `OpenBot could not connect ${providerLabel(provider)}. Try again.`;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = /^(ChatGPT connection|OpenBot)/u.test(rawMessage) ? rawMessage : fallbackMessage;
    const status = hasActiveClient
      ? {
          state: "available" as const,
          version: this.#cli.get(provider)?.version ?? version ?? null,
          message,
          email: this.#accounts.get(provider)?.email ?? null,
        }
      : error instanceof CodexCliError
        ? providerFailureStatus(provider, error, version)
        : {
            state: "sign-in-required" as const,
            version: version ?? null,
            message,
            email: null,
          };
    const hasProvider = this.#clients.size > 0;
    this.#setStatus({
      phase: hasProvider ? "ready" : "blocked",
      providers: updateProviderStatus(this.#status.providers, provider, status),
      capabilities: { ...this.#status.capabilities, chat: hasProvider ? "ready" : "unavailable" },
      message: hasProvider ? null : message,
    });
  }

  async #startClaudeLogin(): Promise<AgentStatus> {
    let cli: AgentCliInfo | null = null;
    this.#setProviderConnectionState("claude", "connecting");

    try {
      cli = await resolveClaudeCli({ bundledExecutable: this.#bundledClaudeExecutable });
      const child = spawn(cli.executable, ["auth", "login", "--claudeai"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(cli.source === "managed" ? { DISABLE_AUTOUPDATER: "1" } : {}),
        },
        stdio: "ignore",
        shell: false,
        windowsHide: process.platform === "win32",
      });
      const pending: PendingClaudeLogin = { child, cli, task: null };
      this.#claudeLogin = pending;
      pending.task = waitForSuccessfulProcess(child, CLAUDE_LOGIN_TIMEOUT_MS)
        .then(() => this.#completeClaudeLogin(pending))
        .catch((error) => this.#failClaudeLogin(pending, error));
      return this.status();
    } catch (error) {
      this.#setProviderConnectionFailure("claude", error, cli?.version);
      throw error;
    }
  }

  async #completeClaudeLogin(pending: PendingClaudeLogin): Promise<void> {
    if (this.#claudeLogin !== pending) return;
    try {
      const candidate = await this.#createAuthenticatedProviderClient("claude", pending.cli);
      if (this.#claudeLogin !== pending) {
        await candidate.client.stop().catch(() => undefined);
        return;
      }
      await this.#activateProviderClient(
        "claude",
        candidate.client,
        pending.cli,
        candidate.account,
        () => this.#claudeLogin === pending,
      );
      if (this.#claudeLogin === pending) this.#claudeLogin = null;
    } catch (error) {
      await this.#failClaudeLogin(pending, error);
    }
  }

  async #failClaudeLogin(pending: PendingClaudeLogin, error: unknown): Promise<void> {
    if (this.#claudeLogin !== pending) return;
    this.#claudeLogin = null;
    if (pending.child.exitCode === null) pending.child.kill("SIGTERM");
    this.#setProviderConnectionFailure("claude", error, pending.cli.version);
  }

  async #cancelClaudeLogin(message: string | null): Promise<void> {
    const pending = this.#claudeLogin;
    if (!pending) return;
    this.#claudeLogin = null;
    if (pending.child.exitCode === null) pending.child.kill("SIGTERM");
    await pending.task?.catch(() => undefined);
    if (message) this.#setProviderConnectionFailure("claude", new Error(message), pending.cli.version);
    else this.#clearProviderConnectionState("claude");
  }

  async #startGrokLogin(): Promise<AgentStatus> {
    let cli: AgentCliInfo | null = null;
    this.#setProviderConnectionState("grok", "connecting");

    try {
      cli = await resolveGrokCli({ bundledExecutable: this.#bundledGrokExecutable });
      const child = spawn(cli.executable, ["--no-auto-update", "login"], {
        cwd: process.cwd(),
        env: { ...process.env, GROK_OAUTH2_REFERRER: "openbot" },
        stdio: "ignore",
        shell: false,
        windowsHide: process.platform === "win32",
      });
      const pending: PendingClaudeLogin = { child, cli, task: null };
      this.#grokLogin = pending;
      pending.task = waitForSuccessfulProcess(child, GROK_LOGIN_TIMEOUT_MS)
        .then(() => this.#completeGrokLogin(pending))
        .catch((error) => this.#failGrokLogin(pending, error));
      return this.status();
    } catch (error) {
      this.#setProviderConnectionFailure("grok", error, cli?.version);
      throw error;
    }
  }

  async #completeGrokLogin(pending: PendingClaudeLogin): Promise<void> {
    if (this.#grokLogin !== pending) return;
    try {
      const candidate = await this.#createAuthenticatedProviderClient("grok", pending.cli);
      if (this.#grokLogin !== pending) {
        await candidate.client.stop().catch(() => undefined);
        return;
      }
      await this.#activateProviderClient(
        "grok",
        candidate.client,
        pending.cli,
        candidate.account,
        () => this.#grokLogin === pending,
      );
      if (this.#grokLogin === pending) this.#grokLogin = null;
    } catch (error) {
      await this.#failGrokLogin(pending, error);
    }
  }

  async #failGrokLogin(pending: PendingClaudeLogin, error: unknown): Promise<void> {
    if (this.#grokLogin !== pending) return;
    this.#grokLogin = null;
    if (pending.child.exitCode === null) pending.child.kill("SIGTERM");
    this.#setProviderConnectionFailure("grok", error, pending.cli.version);
  }

  async #cancelGrokLogin(message: string | null): Promise<void> {
    const pending = this.#grokLogin;
    if (!pending) return;
    this.#grokLogin = null;
    if (pending.child.exitCode === null) pending.child.kill("SIGTERM");
    await pending.task?.catch(() => undefined);
    if (message) this.#setProviderConnectionFailure("grok", new Error(message), pending.cli.version);
    else this.#clearProviderConnectionState("grok");
  }

  async #startCodexLogin(openExternal: (url: string) => Promise<void>): Promise<AgentStatus> {
    let client: AgentClient | null = null;
    let cli: CodexCliInfo | null = null;
    this.#setProviderConnectionState("codex", "connecting");

    try {
      cli = await resolveCodexCli({ bundledExecutable: this.#bundledCodexExecutable });
      client = this.#clientFactory
        ? this.#clientFactory("codex", cli)
        : new CodexAppServerClient(cli.executable, this.#requestTimeoutMs);
      this.#bindClient(client);
      client.start();
      await client.request(
        "initialize",
        {
          clientInfo: { name: "openbot", title: "OpenBot", version: "0.1.0" },
          capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
        },
        decodeRecordResponse,
      );
      client.notify("initialized");

      if (!this.#clients.has("codex")) {
        const existingAccount = await client.request("account/read", { refreshToken: false }, decodeAccountReadResult);
        if (existingAccount.account?.type === "chatgpt") {
          await this.#activateProviderClient("codex", client, cli, existingAccount.account);
          return this.status();
        }
      }

      const login = await client.request(
        "account/login/start",
        {
          type: "chatgpt",
          appBrand: "chatgpt",
          codexStreamlinedLogin: true,
          useHostedLoginSuccessPage: true,
        },
        decodeAccountLoginStartResult,
      );
      let pending: PendingCodexLogin;
      const timer = setTimeout(() => {
        void this.#cancelCodexLogin("ChatGPT connection timed out. Try again.", pending);
      }, CODEX_LOGIN_TIMEOUT_MS);
      timer.unref?.();
      pending = { client, cli, loginId: login.loginId, timer, completing: false };
      this.#codexLogin = pending;
      client.once("exit", () => {
        if (this.#codexLogin?.client === client) {
          void this.#failCodexLogin(this.#codexLogin, "ChatGPT connection stopped. Try again.");
        }
      });
      try {
        await openExternal(login.authUrl);
      } catch {
        await this.#cancelCodexLogin("OpenBot could not open the ChatGPT connection page.");
        throw new Error("OpenBot could not open the ChatGPT connection page.");
      }
      return this.status();
    } catch (error) {
      if (client && this.#codexLogin?.client !== client && this.#clients.get("codex") !== client) {
        await client.stop().catch(() => undefined);
      }
      const status = this.#status.providers?.find((provider) => provider.id === "codex");
      if (!this.#codexLogin && status?.connectionState === "connecting") {
        this.#setProviderConnectionFailure("codex", error, cli?.version);
      }
      throw error;
    }
  }

  async #completeCodexLogin(completion: AccountLoginCompletedResult, source: AgentClient): Promise<void> {
    const pending = this.#codexLogin;
    if (!pending || pending.completing) return;
    if (pending.client !== source) return;
    if (completion.loginId !== null && completion.loginId !== pending.loginId) return;
    pending.completing = true;
    clearTimeout(pending.timer);

    if (!completion.success) {
      await this.#failCodexLogin(pending, "ChatGPT connection was not completed. Try again.");
      return;
    }

    try {
      const account = await pending.client.request("account/read", { refreshToken: true }, decodeAccountReadResult);
      if (account.account?.type !== "chatgpt") {
        throw new Error("ChatGPT did not return an authenticated account.");
      }
      if (this.#codexLogin !== pending) return;
      await this.#activateProviderClient(
        "codex",
        pending.client,
        pending.cli,
        account.account,
        () => this.#codexLogin === pending,
      );
      if (this.#codexLogin === pending) this.#codexLogin = null;
    } catch {
      await this.#failCodexLogin(pending, "OpenBot could not verify the ChatGPT connection. Try again.");
    }
  }

  async #cancelCodexLogin(message: string | null, expected?: PendingCodexLogin): Promise<void> {
    const pending = this.#codexLogin;
    if (!pending || (expected && pending !== expected)) return;
    this.#codexLogin = null;
    clearTimeout(pending.timer);
    await pending.client
      .request("account/login/cancel", { loginId: pending.loginId }, decodeRecordResponse)
      .catch(() => undefined);
    await pending.client.stop().catch(() => undefined);
    if (message) this.#setProviderConnectionFailure("codex", new Error(message), pending.cli.version);
    else this.#clearProviderConnectionState("codex");
  }

  async #failCodexLogin(pending: PendingCodexLogin, message: string): Promise<void> {
    if (this.#codexLogin !== pending) return;
    clearTimeout(pending.timer);
    this.#codexLogin = null;
    await pending.client.stop().catch(() => undefined);
    this.#setProviderConnectionFailure("codex", new Error(message), pending.cli.version);
  }

  async #connect(
    phase: "starting" | "restarting",
    requestedProviders: readonly AgentProvider[],
    options: { preserveCheckErrors?: boolean; refreshRuntimeInBackground?: boolean } = {},
  ): Promise<void> {
    const hadClients = this.#clients.size > 0;
    const providerStatuses: AgentProviderStatus[] = structuredClone(
      this.#status.providers ?? INITIAL_STATUS.providers ?? [],
    );
    for (const provider of requestedProviders) {
      const current = this.#status.providers?.find((candidate) => candidate.id === provider);
      setProviderStatus(providerStatuses, provider, {
        state: this.#clients.has(provider) ? "available" : "checking",
        version: this.#cli.get(provider)?.version ?? null,
        message: null,
        email: this.#accounts.get(provider)?.email ?? null,
        checkError: options.preserveCheckErrors ? (current?.checkError ?? null) : null,
      });
    }
    this.#setStatus(
      hadClients
        ? { providers: providerStatuses }
        : {
            phase,
            auth: { kind: "unknown" },
            providers: providerStatuses,
            capabilities: { ...this.#status.capabilities, chat: "unavailable" },
            message: phase === "starting" ? "Starting local agent CLI…" : "Restarting local agent CLI…",
          },
    );

    const results = await Promise.all(
      requestedProviders.map(async (provider): Promise<string | null> => {
        if (this.#clients.has(provider)) return null;
        const driver = requireProviderDriver(provider);
        let client: AgentClient | null = null;
        let cli: AgentCliInfo | null = null;
        try {
          cli =
            provider === "codex"
              ? await resolveCodexCli({ bundledExecutable: this.#bundledCodexExecutable })
              : provider === "claude"
                ? await resolveClaudeCli({ bundledExecutable: this.#bundledClaudeExecutable })
                : await resolveGrokCli({ bundledExecutable: this.#bundledGrokExecutable });
          client = this.#clientFactory
            ? this.#clientFactory(provider, cli)
            : driver.createClient(cli, this.#requestTimeoutMs);
          this.#bindClient(client);
          client.start();
          await client.request(
            "initialize",
            {
              clientInfo: { name: "openbot", title: "OpenBot", version: "0.1.0" },
              capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
            },
            decodeRecordResponse,
          );
          client.notify("initialized");
          const account = await client.request("account/read", { refreshToken: false }, decodeAccountReadResult, 5_000);
          if (!account.account) {
            const message = provider === "codex" ? "Connect ChatGPT to continue." : driver.signInMessage;
            await client.stop().catch(() => undefined);
            this.#setStatus({
              providers: updateProviderStatus(this.#status.providers, provider, {
                state: "sign-in-required",
                version: cli.version,
                message,
                email: null,
              }),
            });
            return message;
          }
          driver.validateAccount(account.account);
          this.#cli.set(provider, cli);
          this.#clients.set(provider, client);
          this.#accounts.set(provider, account.account);
          this.#setStatus({
            providers: updateProviderStatus(this.#status.providers, provider, {
              state: "available",
              version: cli.version,
              message: null,
              email: account.account.email ?? null,
            }),
          });
          return null;
        } catch (error) {
          if (client) await client.stop().catch(() => undefined);
          const message = error instanceof Error ? error.message : String(error);
          this.#setStatus({
            providers: updateProviderStatus(
              this.#status.providers,
              provider,
              providerFailureStatus(provider, error, cli?.version),
            ),
          });
          if (!(error instanceof CodexCliError)) this.#emitError(`${provider}_start_failed`, error);
          return message;
        }
      }),
    );
    const failures = results.filter((message): message is string => message !== null);
    const finalProviderStatuses = structuredClone(this.#status.providers ?? providerStatuses);

    if (this.#clients.size === 0) {
      this.#setStatus({
        phase: "blocked",
        cliVersion: null,
        auth: { kind: "unknown" },
        providers: finalProviderStatuses,
        capabilities: { ...this.#status.capabilities, chat: "unavailable" },
        message: failures.join(" "),
      });
      return;
    }

    const primaryProvider = this.#clients.has(this.#preferredProvider)
      ? this.#preferredProvider
      : this.#clients.has("codex")
        ? "codex"
        : this.#clients.keys().next().value;
    if (!primaryProvider) throw new Error("No agent provider is ready.");
    const primaryAccount = this.#accounts.get(primaryProvider);
    this.#restartAttempts = 0;
    this.#setStatus({
      phase: "ready",
      cliVersion: this.#cli.get(primaryProvider)?.version ?? null,
      auth: requireProviderDriver(primaryProvider).authState(primaryAccount ?? null),
      providers: finalProviderStatuses,
      capabilities: {
        chat: "ready",
        browser: "ready",
        computerUse: this.#clients.has("codex") ? this.#status.capabilities.computerUse : "unavailable",
      },
      message: null,
    });
    const refreshRuntime = async (): Promise<void> => {
      const codexClient = this.#clients.get("codex");
      const [, computerUse] = await Promise.all([
        this.#refreshModelCatalog(),
        codexClient ? this.#probeComputerUse(codexClient) : Promise.resolve("unavailable" as const),
      ]);
      if (codexClient === this.#clients.get("codex")) {
        this.#setStatus({
          capabilities: { ...this.#status.capabilities, computerUse },
        });
      }
      if (codexClient) void this.#refreshUsage(codexClient).catch(() => undefined);
      await this.#hooks.onProvidersReady();
    };
    if (options.refreshRuntimeInBackground) {
      void refreshRuntime().catch((error) => this.#emitError("provider_metadata_refresh_failed", error));
      return;
    }
    await refreshRuntime();
  }

  #bindClient(client: AgentClient): void {
    this.#hooks.bindClient(client);
    client.on("diagnostic", (message) => {
      if (/error|failed|warning/i.test(message)) {
        this.#emitError(`${client.provider}_diagnostic`, message);
      }
    });
    client.once("exit", (error) => this.#handleExit(client, error));
  }

  #handleExit(client: AgentClient, error: Error): void {
    if (this.#clients.get(client.provider) !== client || this.#hooks.isStopping()) return;
    this.#clients.delete(client.provider);
    void client.stop().catch(() => undefined);
    this.#conversation.clearLoadedThreads();
    this.#hooks.onProviderLost(client);
    this.#emitError(`${client.provider}_exited`, error);
    const providers = updateProviderStatus(this.#status.providers, client.provider, {
      state: "error",
      version: this.#cli.get(client.provider)?.version ?? null,
      message: error.message,
    });
    const anotherProviderIsReady = this.#clients.size > 0;

    if (this.#restartAttempts >= 3) {
      this.#setStatus(
        anotherProviderIsReady
          ? {
              phase: "ready",
              providers,
              capabilities: { ...this.#status.capabilities, chat: "ready" },
              message: null,
            }
          : {
              phase: "blocked",
              providers,
              capabilities: { ...this.#status.capabilities, chat: "unavailable" },
              message: `${providerLabel(client.provider)} stopped repeatedly. Restart OpenBot after checking the CLI.`,
            },
      );
      return;
    }

    const delayMs = 500 * 2 ** this.#restartAttempts;
    this.#restartAttempts += 1;
    this.#setStatus(
      anotherProviderIsReady
        ? {
            phase: "ready",
            providers,
            capabilities: { ...this.#status.capabilities, chat: "ready" },
            message: null,
          }
        : {
            phase: "restarting",
            providers,
            capabilities: { ...this.#status.capabilities, chat: "unavailable" },
            message: `${providerLabel(client.provider)} stopped. Retrying (${this.#restartAttempts}/3)…`,
          },
    );
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#connect("restarting", [client.provider]);
    }, delayMs);
  }

  async #refreshModelCatalog(): Promise<void> {
    const discovered = (
      await Promise.all(
        [...this.#clients.values()].map(async (client): Promise<AgentModelOption[]> => {
          try {
            const response = await client.request(
              "model/list",
              { limit: 100, includeHidden: false },
              decodeModelListResponse,
              5_000,
            );
            const serverModels = new Map(
              response.data
                .filter((item): item is typeof item & { model: string } => !item.hidden && isString(item.model))
                .map((item) => [item.model, item] as const),
            );
            const models: AgentModelOption[] = [];
            for (const server of serverModels.values()) {
              if (!server.model) continue;
              if (client.provider === "codex" && !CURATED_CODEX_MODEL_IDS.has(server.model)) continue;
              const fallback = FALLBACK_MODELS.find(
                (candidate) => candidate.provider === client.provider && candidate.id === server.model,
              );
              const efforts = (server?.supportedReasoningEfforts ?? [])
                .map((item) => item.reasoningEffort)
                .filter(isReasoningEffort);
              models.push({
                provider: client.provider,
                id: server.model,
                name: cleanModelName(server.displayName, fallback?.name ?? server.model),
                description:
                  fallback?.description ?? `${providerLabel(client.provider)} model discovered from the local CLI.`,
                defaultReasoningEffort: isReasoningEffort(server?.defaultReasoningEffort)
                  ? server.defaultReasoningEffort
                  : (fallback?.defaultReasoningEffort ?? "medium"),
                supportedReasoningEfforts: efforts.length
                  ? efforts
                  : (fallback?.supportedReasoningEfforts ?? ["medium"]),
              });
            }
            return models;
          } catch {
            return client.provider === "grok"
              ? []
              : FALLBACK_MODELS.filter((model) => model.provider === client.provider);
          }
        }),
      )
    ).flat();
    const discoveredById = new Map(discovered.map((model) => [`${model.provider}:${model.id}`, model]));
    const staticModels = FALLBACK_MODELS.map(
      (fallback) => discoveredById.get(`${fallback.provider}:${fallback.id}`) ?? fallback,
    );
    this.#models = [
      ...staticModels,
      ...discovered.filter(
        (model) =>
          !FALLBACK_MODELS.some((fallback) => fallback.provider === model.provider && fallback.id === model.id),
      ),
    ];
  }

  async #probeComputerUse(client: AgentClient): Promise<"ready" | "setup-required" | "unavailable"> {
    try {
      const result = await client.request("plugin/list", { cwds: [] }, decodeRecordResponse, 5_000);
      for (const marketplace of getArray(result, "marketplaces")) {
        for (const plugin of getArray(marketplace, "plugins")) {
          if (!isRecord(plugin)) continue;
          if (
            (plugin.id === "computer-use@openai-bundled" || plugin.name === "computer-use") &&
            plugin.installed === true &&
            plugin.enabled === true
          ) {
            return "ready";
          }
        }
      }
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  async #refreshUsage(client: AgentClient, model?: string, emit = true): Promise<AccountUsage> {
    const rateLimits = await client.request(
      "account/rateLimits/read",
      client.provider === "codex" ? undefined : { model },
      decodeAccountRateLimitsReadResult,
    );
    const usage = normalizeAccountUsage(rateLimits, client.provider === "codex" ? model : undefined);
    if (emit) this.#emit({ type: "usage-changed", usage: structuredClone(usage) });
    return structuredClone(usage);
  }

  #setStatus(patch: Partial<AgentStatus>): void {
    this.#status = {
      ...this.#status,
      ...patch,
      capabilities: patch.capabilities ?? this.#status.capabilities,
    };
    this.#emit({ type: "status", status: this.status() });
  }
}
