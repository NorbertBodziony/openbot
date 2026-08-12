import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  AgentEvent,
  AgentPromptQuestion,
  AgentStatus,
  BotSummary,
  ConversationMessage,
  ConversationSnapshot,
  RespondToPromptInput,
  SendMessageInput,
  TurnHandle,
} from "../shared/ipc";
import { CodexAppServerClient } from "./app-server-client";
import type { BotStore } from "./bot-store";
import { BROWSER_DYNAMIC_TOOLS, type BrowserHost } from "./browser-host";
import { CodexCliError, type CodexCliInfo, resolveCodexCli } from "./cli";
import {
  type AccountReadResult,
  type AppServerNotification,
  type AppServerRequest,
  type DynamicToolCallParams,
  getArray,
  getRecord,
  getString,
  isRecord,
  type RequestId,
  type ThreadItem,
  type ThreadResponse,
  type TurnResponse,
} from "./protocol";

interface AgentServiceEvents {
  event: [event: AgentEvent];
}

interface PendingPrompt {
  client: CodexAppServerClient;
  id: RequestId;
}

interface ComputerUsePrerequisites {
  screenRecording: boolean;
  accessibility: boolean;
}

const INITIAL_STATUS: AgentStatus = {
  phase: "idle",
  cliVersion: null,
  auth: { kind: "unknown" },
  capabilities: {
    chat: "unavailable",
    browser: "ready",
    computerUse: "unavailable",
  },
  message: null,
  fullAccess: true,
};

export class AgentService extends EventEmitter<AgentServiceEvents> {
  readonly #store: BotStore;
  readonly #browser: BrowserHost;
  readonly #computerUsePrerequisites: (() => ComputerUsePrerequisites) | null;
  readonly #snapshots = new Map<string, ConversationSnapshot>();
  readonly #threadToBot = new Map<string, string>();
  readonly #loadedThreads = new Set<string>();
  readonly #pendingPrompts = new Map<RequestId, PendingPrompt>();
  readonly #itemTurns = new Map<string, string>();
  #status: AgentStatus = structuredClone(INITIAL_STATUS);
  #client: CodexAppServerClient | null = null;
  #cli: CodexCliInfo | null = null;
  #stopping = false;
  #restartAttempts = 0;
  #restartTimer: NodeJS.Timeout | null = null;

  constructor(
    store: BotStore,
    browser: BrowserHost,
    computerUsePrerequisites: (() => ComputerUsePrerequisites) | null = null,
  ) {
    super();
    this.#store = store;
    this.#browser = browser;
    this.#computerUsePrerequisites = computerUsePrerequisites;
    this.#browser.onChanged((tabs, activeTabId) => {
      this.#emit({ type: "browser-changed", tabs, activeTabId });
    });
  }

  getStatus(): AgentStatus {
    return structuredClone(this.#status);
  }

  listBots(): BotSummary[] {
    return this.#store.list();
  }

  createBot(): Promise<BotSummary> {
    return this.#store.createBot();
  }

  async initialize(): Promise<void> {
    this.#stopping = false;
    await this.#store.initialize();
    await this.#connect("starting");
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#pendingPrompts.clear();
    const client = this.#client;
    this.#client = null;
    if (client) await client.stop();
    this.#setStatus({ phase: "stopped", message: null });
  }

  async readConversation(botId: string): Promise<ConversationSnapshot> {
    const bot = await this.#store.getOrCreate(botId);
    const cached = this.#snapshots.get(botId);
    if (cached?.activeTurnId) return structuredClone(cached);

    if (!bot.threadId || !this.#client || this.#status.phase !== "ready") {
      return this.#ensureSnapshot(botId, bot.threadId);
    }

    try {
      const response = await this.#client.request<ThreadResponse>("thread/read", {
        threadId: bot.threadId,
        includeTurns: true,
      });
      const snapshot = snapshotFromThread(botId, response.thread);
      this.#snapshots.set(botId, snapshot);
      this.#threadToBot.set(bot.threadId, botId);
      return structuredClone(snapshot);
    } catch (error) {
      this.#emitError("thread_read_failed", error, botId);
      return this.#ensureSnapshot(botId, bot.threadId);
    }
  }

  async sendMessage(input: SendMessageInput): Promise<TurnHandle> {
    const text = input.text.trim();
    if (!text) throw new Error("Message cannot be empty.");
    if (text.length > 100_000) throw new Error("Message is too long.");

    const client = this.#requireReadyClient();
    const bot = await this.#store.getOrCreate(input.botId);
    const threadId = await this.#ensureThread(bot);
    const snapshot = this.#ensureSnapshot(bot.id, threadId);
    const localMessageId = randomUUID();
    snapshot.messages.push({
      id: localMessageId,
      author: "user",
      text,
      createdAt: new Date().toISOString(),
      status: "completed",
    });
    await this.#store.updatePreview(bot.id, text);
    this.#emitConversation(snapshot);

    if (snapshot.activeTurnId) {
      const response = await client.request<{ turnId: string }>("turn/steer", {
        threadId,
        input: [{ type: "text", text }],
        expectedTurnId: snapshot.activeTurnId,
      });
      return {
        botId: bot.id,
        threadId,
        turnId: response.turnId,
        mode: "steer",
      };
    }

    const response = await client.request<TurnResponse>("turn/start", {
      threadId,
      clientUserMessageId: localMessageId,
      input: [{ type: "text", text }],
      cwd: bot.workspacePath,
      runtimeWorkspaceRoots: [bot.workspacePath, this.#store.sharedRoot],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    snapshot.activeTurnId = response.turn.id;
    this.#emitConversation(snapshot);
    return {
      botId: bot.id,
      threadId,
      turnId: response.turn.id,
      mode: "start",
    };
  }

  async interrupt(botId: string, turnId: string): Promise<void> {
    const client = this.#requireReadyClient();
    const bot = await this.#store.getOrCreate(botId);
    if (!bot.threadId) return;
    await client.request("turn/interrupt", { threadId: bot.threadId, turnId });
  }

  async interruptAll(): Promise<void> {
    if (!this.#client || this.#status.phase !== "ready") return;
    const requests: Promise<unknown>[] = [];
    for (const [botId, snapshot] of this.#snapshots) {
      if (!snapshot.threadId || !snapshot.activeTurnId) continue;
      requests.push(
        this.#client
          .request("turn/interrupt", {
            threadId: snapshot.threadId,
            turnId: snapshot.activeTurnId,
          })
          .catch((error) => this.#emitError("interrupt_failed", error, botId)),
      );
    }
    await Promise.all(requests);
  }

  async respondToPrompt(input: RespondToPromptInput): Promise<void> {
    const pending = this.#pendingPrompts.get(input.requestId);
    if (!pending) throw new Error("This prompt is no longer active.");

    const answers = Object.fromEntries(
      Object.entries(input.answers).map(([id, values]) => [id, { answers: values }]),
    );
    pending.client.respond(pending.id, { answers });
    this.#pendingPrompts.delete(input.requestId);
  }

  async #connect(phase: "starting" | "restarting"): Promise<void> {
    this.#setStatus({
      phase,
      auth: { kind: "unknown" },
      capabilities: { ...this.#status.capabilities, chat: "unavailable" },
      message: phase === "starting" ? "Starting local Codex…" : "Restarting local Codex…",
    });

    try {
      this.#cli = await resolveCodexCli();
      const client = new CodexAppServerClient(this.#cli.executable);
      this.#bindClient(client);
      client.start();
      this.#client = client;

      await client.request("initialize", {
        clientInfo: {
          name: "infeld_bot",
          title: "Infeld Bot",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: true,
        },
      });
      client.notify("initialized");

      const account = await client.request<AccountReadResult>("account/read", {
        refreshToken: false,
      });
      if (!account.account) {
        this.#setStatus({
          phase: "blocked",
          cliVersion: this.#cli.version,
          auth: { kind: "signed-out" },
          capabilities: { ...this.#status.capabilities, chat: "unavailable" },
          message: "Run `codex login`, then restart Infeld Bot.",
        });
        return;
      }
      if (account.account.type !== "chatgpt") {
        this.#setStatus({
          phase: "blocked",
          cliVersion: this.#cli.version,
          auth: { kind: "unsupported", accountType: account.account.type },
          capabilities: { ...this.#status.capabilities, chat: "unavailable" },
          message: "Infeld requires a ChatGPT subscription login. Run `codex login`.",
        });
        return;
      }

      const computerUse = await this.#probeComputerUse(client);
      this.#restartAttempts = 0;
      this.#setStatus({
        phase: "ready",
        cliVersion: this.#cli.version,
        auth: { kind: "chatgpt", planType: account.account.planType ?? null },
        capabilities: { chat: "ready", browser: "ready", computerUse },
        message: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#setStatus({
        phase: "blocked",
        cliVersion: this.#cli?.version ?? null,
        auth: { kind: "unknown" },
        capabilities: { ...this.#status.capabilities, chat: "unavailable" },
        message,
      });
      if (!(error instanceof CodexCliError)) this.#emitError("codex_start_failed", error);
    }
  }

  #bindClient(client: CodexAppServerClient): void {
    client.on("notification", (notification) => this.#handleNotification(notification));
    client.on("request", (request) => void this.#handleServerRequest(client, request));
    client.on("diagnostic", (message) => {
      if (/error|failed|warning/i.test(message)) this.#emitError("codex_diagnostic", message);
    });
    client.once("exit", (error) => this.#handleExit(client, error));
  }

  #handleExit(client: CodexAppServerClient, error: Error): void {
    if (this.#client !== client || this.#stopping) return;
    this.#client = null;
    this.#loadedThreads.clear();
    this.#pendingPrompts.clear();
    this.#emitError("codex_exited", error);

    if (this.#restartAttempts >= 3) {
      this.#setStatus({
        phase: "blocked",
        capabilities: { ...this.#status.capabilities, chat: "unavailable" },
        message: "Codex stopped repeatedly. Restart Infeld Bot after checking `codex:doctor`.",
      });
      return;
    }

    const delayMs = 500 * 2 ** this.#restartAttempts;
    this.#restartAttempts += 1;
    this.#setStatus({
      phase: "restarting",
      capabilities: { ...this.#status.capabilities, chat: "unavailable" },
      message: `Codex stopped. Retrying (${this.#restartAttempts}/3)…`,
    });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#connect("restarting");
    }, delayMs);
  }

  async #ensureThread(bot: BotSummary): Promise<string> {
    const client = this.#requireReadyClient();
    if (bot.threadId) {
      this.#threadToBot.set(bot.threadId, bot.id);
      if (!this.#loadedThreads.has(bot.threadId)) {
        await client.request("thread/resume", {
          threadId: bot.threadId,
          cwd: bot.workspacePath,
          runtimeWorkspaceRoots: [bot.workspacePath, this.#store.sharedRoot],
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          developerInstructions: developerInstructions(bot, this.#store.sharedRoot),
        });
        this.#loadedThreads.add(bot.threadId);
      }
      return bot.threadId;
    }

    const response = await client.request<ThreadResponse>("thread/start", {
      cwd: bot.workspacePath,
      runtimeWorkspaceRoots: [bot.workspacePath, this.#store.sharedRoot],
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: developerInstructions(bot, this.#store.sharedRoot),
      ephemeral: false,
      serviceName: "infeld_bot",
      dynamicTools: BROWSER_DYNAMIC_TOOLS,
    });
    const threadId = response.thread.id;
    await this.#store.setThreadId(bot.id, threadId);
    this.#threadToBot.set(threadId, bot.id);
    this.#loadedThreads.add(threadId);
    this.#ensureSnapshot(bot.id, threadId);
    return threadId;
  }

  async #handleServerRequest(
    client: CodexAppServerClient,
    request: AppServerRequest,
  ): Promise<void> {
    try {
      switch (request.method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
          client.respond(request.id, { decision: "acceptForSession" });
          return;
        case "applyPatchApproval":
        case "execCommandApproval":
          client.respond(request.id, { decision: "approved_for_session" });
          return;
        case "item/permissions/requestApproval": {
          const permissions = getRecord(request.params, "permissions") ?? {};
          client.respond(request.id, {
            permissions: Object.fromEntries(
              Object.entries(permissions).filter(([, value]) => value !== null),
            ),
            scope: "session",
          });
          return;
        }
        case "item/tool/call": {
          if (!isDynamicToolCall(request.params)) throw new Error("Invalid dynamic tool request.");
          if (request.params.namespace !== "browser") {
            throw new Error(`Unsupported dynamic tool namespace: ${request.params.namespace}`);
          }
          client.respond(request.id, await this.#browser.handleDynamicTool(request.params));
          return;
        }
        case "item/tool/requestUserInput":
          this.#surfacePrompt(client, request);
          return;
        case "mcpServer/elicitation/request":
          client.respond(request.id, { action: "decline", content: null, _meta: null });
          this.#emitError(
            "mcp_safety_handoff",
            "A local plugin requested a security hand-off that Infeld cannot auto-approve.",
          );
          return;
        case "currentTime/read":
          client.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
          return;
        default:
          client.respondError(request.id, {
            code: -32601,
            message: `Infeld does not implement server request ${request.method}.`,
          });
      }
    } catch (error) {
      if (client.running) {
        try {
          client.respondError(request.id, { code: -32603, message: String(error) });
        } catch {
          // The process can exit between the running check and the write.
        }
      }
      this.#emitError("server_request_failed", error);
    }
  }

  #handleNotification(notification: AppServerNotification): void {
    const params = notification.params;
    const threadId = getString(params, "threadId");
    const botId = threadId ? this.#threadToBot.get(threadId) : undefined;

    switch (notification.method) {
      case "turn/started": {
        if (!threadId || !botId) return;
        const turn = getRecord(params, "turn");
        const turnId = getString(turn, "id");
        if (!turnId) return;
        const snapshot = this.#ensureSnapshot(botId, threadId);
        snapshot.activeTurnId = turnId;
        this.#emit({ type: "turn-started", botId, threadId, turnId });
        this.#emitConversation(snapshot);
        return;
      }
      case "item/started":
      case "item/completed": {
        if (!threadId || !botId) return;
        const turnId = getString(params, "turnId");
        const item = getRecord(params, "item");
        if (!turnId || !item) return;
        const itemId = getString(item, "id");
        if (itemId) this.#itemTurns.set(itemId, turnId);
        this.#applyItem(
          botId,
          threadId,
          turnId,
          item as ThreadItem,
          notification.method === "item/completed",
        );
        this.#emit({
          type: "item",
          botId,
          threadId,
          turnId,
          phase: notification.method === "item/completed" ? "completed" : "started",
          item,
        });
        return;
      }
      case "item/agentMessage/delta": {
        if (!threadId || !botId) return;
        const turnId = getString(params, "turnId");
        const itemId = getString(params, "itemId");
        const delta = getString(params, "delta");
        if (!turnId || !itemId || delta === null) return;
        this.#itemTurns.set(itemId, turnId);
        const snapshot = this.#ensureSnapshot(botId, threadId);
        let message = snapshot.messages.find((candidate) => candidate.id === itemId);
        if (!message) {
          message = newAssistantMessage(itemId);
          snapshot.messages.push(message);
        }
        message.text += delta;
        message.status = "streaming";
        this.#emit({ type: "assistant-delta", botId, threadId, turnId, itemId, delta });
        this.#emitConversation(snapshot);
        return;
      }
      case "turn/completed": {
        if (!threadId || !botId) return;
        const turn = getRecord(params, "turn");
        const turnId = getString(turn, "id");
        if (!turnId) return;
        const status = getString(turn, "status") ?? "completed";
        const snapshot = this.#ensureSnapshot(botId, threadId);
        snapshot.activeTurnId = null;
        for (const message of snapshot.messages) {
          if (this.#itemTurns.get(message.id) !== turnId || message.status !== "streaming")
            continue;
          message.status = normalizeCompletionStatus(status);
        }
        this.#emit({ type: "turn-completed", botId, threadId, turnId, status });
        this.#emitConversation(snapshot);
        return;
      }
      case "mcpServer/startupStatus/updated": {
        if (getString(params, "name") !== "computer-use") return;
        const status = getString(params, "status");
        this.#setStatus({
          capabilities: {
            ...this.#status.capabilities,
            computerUse: status === "ready" ? this.#computerUsePermissionState() : "setup-required",
          },
        });
        return;
      }
      case "error":
      case "warning": {
        const message = getString(params, "message") ?? notification.method;
        this.#emitError(`codex_${notification.method}`, message, botId);
      }
    }
  }

  #applyItem(
    botId: string,
    threadId: string,
    turnId: string,
    item: ThreadItem,
    completed: boolean,
  ): void {
    if (item.type !== "agentMessage" || typeof item.id !== "string") return;
    const snapshot = this.#ensureSnapshot(botId, threadId);
    let message = snapshot.messages.find((candidate) => candidate.id === item.id);
    if (!message) {
      message = newAssistantMessage(item.id);
      snapshot.messages.push(message);
    }
    if (typeof item.text === "string") message.text = item.text;
    message.status = completed ? "completed" : "streaming";
    this.#itemTurns.set(item.id, turnId);
    this.#emitConversation(snapshot);
  }

  #surfacePrompt(client: CodexAppServerClient, request: AppServerRequest): void {
    const threadId = getString(request.params, "threadId");
    const turnId = getString(request.params, "turnId");
    const botId = threadId ? this.#threadToBot.get(threadId) : undefined;
    if (!threadId || !turnId || !botId) {
      client.respond(request.id, { answers: {} });
      return;
    }

    const questions: AgentPromptQuestion[] = getArray(request.params, "questions")
      .filter(isRecord)
      .map((question) => ({
        id: getString(question, "id") ?? randomUUID(),
        header: getString(question, "header") ?? "Question",
        question: getString(question, "question") ?? "Codex needs more information.",
        isSecret: question.isSecret === true,
        options: Array.isArray(question.options)
          ? question.options.filter(isRecord).map((option) => ({
              label: getString(option, "label") ?? "Option",
              description: getString(option, "description") ?? "",
            }))
          : null,
      }));
    this.#pendingPrompts.set(request.id, { client, id: request.id });
    this.#emit({ type: "prompt", requestId: request.id, botId, threadId, turnId, questions });
  }

  async #probeComputerUse(
    client: CodexAppServerClient,
  ): Promise<"ready" | "setup-required" | "unavailable"> {
    try {
      const result = await client.request<unknown>("plugin/list", { cwds: [] });
      for (const marketplace of getArray(result, "marketplaces")) {
        for (const plugin of getArray(marketplace, "plugins")) {
          if (!isRecord(plugin)) continue;
          if (
            (plugin.id === "computer-use@openai-bundled" || plugin.name === "computer-use") &&
            plugin.installed === true &&
            plugin.enabled === true
          ) {
            return this.#computerUsePermissionState();
          }
        }
      }
      return "unavailable";
    } catch {
      return "unavailable";
    }
  }

  #computerUsePermissionState(): "ready" | "setup-required" {
    if (!this.#computerUsePrerequisites) return "setup-required";
    const prerequisites = this.#computerUsePrerequisites();
    return prerequisites.screenRecording && prerequisites.accessibility
      ? "ready"
      : "setup-required";
  }

  #ensureSnapshot(botId: string, threadId: string | null): ConversationSnapshot {
    let snapshot = this.#snapshots.get(botId);
    if (!snapshot) {
      snapshot = { botId, threadId, activeTurnId: null, messages: [] };
      this.#snapshots.set(botId, snapshot);
    } else if (threadId && !snapshot.threadId) {
      snapshot.threadId = threadId;
    }
    return snapshot;
  }

  #requireReadyClient(): CodexAppServerClient {
    if (!this.#client || this.#status.phase !== "ready") {
      throw new Error(this.#status.message ?? "Local Codex is not ready.");
    }
    return this.#client;
  }

  #setStatus(patch: Partial<AgentStatus>): void {
    this.#status = {
      ...this.#status,
      ...patch,
      capabilities: patch.capabilities ?? this.#status.capabilities,
    };
    this.#emit({ type: "status", status: this.getStatus() });
  }

  #emitConversation(snapshot: ConversationSnapshot): void {
    this.#emit({ type: "conversation", snapshot: structuredClone(snapshot) });
  }

  #emitError(code: string, error: unknown, botId?: string): void {
    this.#emit({
      type: "error",
      botId,
      code,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  #emit(event: AgentEvent): void {
    this.emit("event", event);
  }
}

function developerInstructions(bot: BotSummary, sharedRoot: string): string {
  return [
    `You are ${bot.name}, a local Infeld Bot teammate.`,
    `Your own working directory is ${bot.workspacePath}.`,
    `The shared directory available to every Infeld bot is ${sharedRoot}.`,
    "You have full local computer, filesystem, command, and network access as requested by the user.",
    "Use the browser namespace for the private Infeld browser and the installed Computer Use plugin for macOS GUI tasks.",
  ].join("\n");
}

function snapshotFromThread(botId: string, thread: ThreadResponse["thread"]): ConversationSnapshot {
  const messages: ConversationMessage[] = [];
  for (const turn of thread.turns ?? []) {
    const createdAt = new Date().toISOString();
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage" && typeof item.id === "string") {
        const text = (item.content ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
        if (text) {
          messages.push({
            id: item.id,
            author: "user",
            text,
            createdAt,
            status: "completed",
          });
        }
      }
      if (item.type === "agentMessage" && typeof item.id === "string" && item.text) {
        messages.push({
          id: item.id,
          author: "assistant",
          text: item.text,
          createdAt,
          status: normalizeCompletionStatus(turn.status ?? "completed"),
        });
      }
    }
  }
  return { botId, threadId: thread.id, activeTurnId: null, messages };
}

function newAssistantMessage(id: string): ConversationMessage {
  return {
    id,
    author: "assistant",
    text: "",
    createdAt: new Date().toISOString(),
    status: "streaming",
  };
}

function normalizeCompletionStatus(status: string): ConversationMessage["status"] {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return "completed";
}

function isDynamicToolCall(value: unknown): value is DynamicToolCallParams {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.callId === "string" &&
    (typeof value.namespace === "string" || value.namespace === null) &&
    typeof value.tool === "string" &&
    "arguments" in value
  );
}
