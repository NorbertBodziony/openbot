import { execFile } from "node:child_process";
import { randomUUID, type UUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import {
  type CanUseTool,
  createSdkMcpServer,
  getSessionMessages,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type DynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { z } from "zod";
import type { AgentProvider } from "./agent-client";
import type { ClaudeCliInfo } from "./cli";
import {
  type AppServerNotification,
  type AppServerRequest,
  getString,
  isRecord,
  type RequestId,
  type RpcError,
  type ThreadResponse,
} from "./protocol";

const execFileAsync = promisify(execFile);

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string];
}

interface ThreadConfig {
  cwd: string;
  model?: string;
  effort?: string;
  developerInstructions: string;
  additionalDirectories: string[];
  persistSession: boolean;
}

interface ActiveTurn {
  id: string;
  itemId: string;
  text: string;
  assistantMessages: Map<string, string>;
}

interface ThreadRuntime {
  id: string;
  config: ThreadConfig;
  input: AsyncMessageQueue;
  query: Query;
  activeTurn: ActiveTurn | null;
  consume: Promise<void>;
}

interface PendingServerRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

type QueryFactory = (params: Parameters<typeof query>[0]) => Query;

export class ClaudeAgentClient extends EventEmitter<ClientEvents> {
  readonly provider: AgentProvider = "claude";
  readonly #cli: ClaudeCliInfo;
  readonly #createQuery: QueryFactory;
  readonly #threads = new Map<string, ThreadRuntime>();
  readonly #pendingServerRequests = new Map<RequestId, PendingServerRequest>();
  #running = false;

  constructor(cli: ClaudeCliInfo, createQuery: QueryFactory = query) {
    super();
    this.#cli = cli;
    this.#createQuery = createQuery;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const runtime of this.#threads.values()) {
      runtime.input.close();
      runtime.query.close();
    }
    await Promise.allSettled([...this.#threads.values()].map((runtime) => runtime.consume));
    this.#threads.clear();
    for (const pending of this.#pendingServerRequests.values()) {
      pending.reject(new Error("Claude session stopped."));
    }
    this.#pendingServerRequests.clear();
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.#running) throw new Error("Claude Agent SDK is not running.");

    switch (method) {
      case "initialize":
        return {} as T;
      case "account/read":
        return (await this.#readAccount()) as T;
      case "account/rateLimits/read":
        return { rateLimits: null, rateLimitsByLimitId: null } as T;
      case "model/list":
        return { data: CLAUDE_MODELS } as T;
      case "plugin/list":
        return { marketplaces: [] } as T;
      case "thread/start": {
        const threadId = randomUUID();
        await this.#startThread(threadId, readThreadConfig(params), false);
        return { thread: { id: threadId } } as T;
      }
      case "thread/resume": {
        const threadId = requiredString(params, "threadId");
        if (!this.#threads.has(threadId)) {
          await this.#startThread(threadId, readThreadConfig(params), true);
        }
        return { thread: { id: threadId } } as T;
      }
      case "thread/read":
        return (await this.#readThread(requiredString(params, "threadId"))) as T;
      case "turn/start":
        return (await this.#startTurn(params)) as T;
      case "turn/interrupt": {
        const runtime = this.#requireThread(requiredString(params, "threadId"));
        await runtime.query.interrupt();
        return {} as T;
      }
      case "thread/compact/start":
        // Claude Code manages its own context compaction.
        return {} as T;
      default:
        throw new Error(`Claude adapter does not implement ${method}.`);
    }
  }

  notify(): void {
    // Claude Agent SDK has no initialize notification.
  }

  respond(id: RequestId, result: unknown): void {
    const pending = this.#pendingServerRequests.get(id);
    if (!pending) return;
    this.#pendingServerRequests.delete(id);
    pending.resolve(result);
  }

  respondError(id: RequestId, error: RpcError): void {
    const pending = this.#pendingServerRequests.get(id);
    if (!pending) return;
    this.#pendingServerRequests.delete(id);
    pending.reject(new Error(error.message));
  }

  async #readAccount(): Promise<unknown> {
    try {
      const { stdout } = await execFileAsync(this.#cli.executable, ["auth", "status", "--json"], {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        shell: process.platform === "win32",
      });
      const status = JSON.parse(stdout) as unknown;
      if (!isRecord(status) || status.loggedIn !== true) {
        return { account: null, requiresOpenaiAuth: false };
      }
      return {
        account: {
          type: "claude",
          email: isString(status.email) ? status.email : null,
          planType: isString(status.subscriptionType) ? status.subscriptionType : null,
        },
        requiresOpenaiAuth: false,
      };
    } catch {
      return { account: null, requiresOpenaiAuth: false };
    }
  }

  async #startThread(threadId: string, config: ThreadConfig, resume: boolean): Promise<void> {
    const input = new AsyncMessageQueue();
    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      if (toolName !== "AskUserQuestion") {
        return { behavior: "allow", updatedInput: toolInput } satisfies PermissionResult;
      }
      return this.#requestUserInput(threadId, toolInput, options.toolUseID ?? randomUUID());
    };
    const mcpServers = this.#createOpenBotServers(threadId);
    const claudeQuery = this.#createQuery({
      prompt: input,
      options: {
        cwd: config.cwd,
        pathToClaudeCodeExecutable: this.#cli.executable,
        ...(config.model ? { model: normalizeClaudeModel(config.model) } : {}),
        ...(config.effort ? { effort: normalizeClaudeEffort(config.effort) } : {}),
        ...(resume ? { resume: threadId } : { sessionId: threadId }),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: config.developerInstructions,
        },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        persistSession: config.persistSession,
        additionalDirectories: config.additionalDirectories,
        canUseTool,
        mcpServers,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "openbot/0.1.0" },
      },
    });
    const runtime: ThreadRuntime = {
      id: threadId,
      config,
      input,
      query: claudeQuery,
      activeTurn: null,
      consume: Promise.resolve(),
    };
    runtime.consume = this.#consume(runtime);
    this.#threads.set(threadId, runtime);
  }

  async #startTurn(params: unknown): Promise<unknown> {
    const threadId = requiredString(params, "threadId");
    const runtime = this.#requireThread(threadId);
    if (runtime.activeTurn) throw new Error("The Claude thread already has an active turn.");

    const requestedModel = getString(params, "model");
    if (requestedModel && requestedModel !== runtime.config.model) {
      await runtime.query.setModel(normalizeClaudeModel(requestedModel));
      runtime.config.model = requestedModel;
    }
    const requestedEffort = getString(params, "effort");
    if (requestedEffort && requestedEffort !== runtime.config.effort) {
      await runtime.query.setMaxThinkingTokens(thinkingTokens(requestedEffort));
      runtime.config.effort = requestedEffort;
    }

    const clientId = getString(params, "clientUserMessageId");
    const turnId = clientId && isUuid(clientId) ? clientId : randomUUID();
    const text = readInputText(params);
    const activeTurn = {
      id: turnId,
      itemId: `${turnId}:assistant`,
      text: "",
      assistantMessages: new Map<string, string>(),
    };
    runtime.activeTurn = activeTurn;
    this.emit("notification", {
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    runtime.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid: turnId as UUID,
      session_id: threadId,
    });
    return { turn: { id: turnId, status: "inProgress" } };
  }

  async #consume(runtime: ThreadRuntime): Promise<void> {
    try {
      for await (const message of runtime.query) this.#handleMessage(runtime, message);
      if (this.#running) this.#fail(new Error("Claude session stream ended unexpectedly."));
    } catch (error) {
      if (!this.#running) return;
      const activeTurn = runtime.activeTurn;
      if (activeTurn) this.#completeTurn(runtime, "failed", error);
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #fail(error: Error): void {
    if (!this.#running) return;
    this.#running = false;
    this.emit("exit", error);
  }

  #handleMessage(runtime: ThreadRuntime, message: SDKMessage): void {
    if (message.type === "stream_event" && message.parent_tool_use_id === null) {
      const event = message.event as unknown;
      const delta = isRecord(event) ? event.delta : null;
      if (
        event &&
        isRecord(event) &&
        event.type === "content_block_delta" &&
        isRecord(delta) &&
        delta.type === "text_delta" &&
        isString(delta.text)
      ) {
        this.#appendDelta(runtime, delta.text);
      }
      return;
    }

    if (message.type === "assistant") {
      if (message.parent_tool_use_id !== null) return;
      const turn = runtime.activeTurn;
      const text = messageText(message.message);
      if (!turn || !text) return;
      turn.assistantMessages.set(message.uuid, text);
      const completeText = [...turn.assistantMessages.values()].join("");
      if (completeText.startsWith(turn.text)) {
        this.#appendDelta(runtime, completeText.slice(turn.text.length));
      }
      return;
    }

    if (message.type !== "result") return;
    const fallback = message.subtype === "success" ? message.result : "";
    const turn = runtime.activeTurn;
    if (turn) {
      const completeText = [...turn.assistantMessages.values()].join("");
      if (completeText) turn.text = completeText;
      else if (!turn.text && fallback) this.#appendDelta(runtime, fallback);
    }
    const interrupted =
      message.terminal_reason === "aborted_streaming" ||
      message.terminal_reason === "aborted_tools" ||
      ("errors" in message && message.errors.some((error) => /interrupt|abort/i.test(error)));
    const status = interrupted
      ? "interrupted"
      : message.subtype === "success"
        ? "completed"
        : "failed";
    this.#completeTurn(runtime, status, "errors" in message ? message.errors.join("\n") : null);
  }

  #appendDelta(runtime: ThreadRuntime, delta: string): void {
    const turn = runtime.activeTurn;
    if (!turn || !delta) return;
    turn.text += delta;
    this.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: runtime.id,
        turnId: turn.id,
        itemId: turn.itemId,
        delta,
      },
    });
  }

  #completeTurn(runtime: ThreadRuntime, status: string, error: unknown): void {
    const turn = runtime.activeTurn;
    if (!turn) return;
    this.emit("notification", {
      method: "item/completed",
      params: {
        threadId: runtime.id,
        turnId: turn.id,
        item: { id: turn.itemId, type: "agentMessage", text: turn.text },
      },
    });
    if (status === "failed" && error) {
      this.emit("notification", {
        method: "error",
        params: { threadId: runtime.id, turnId: turn.id, message: String(error) },
      });
    }
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId: runtime.id, turn: { id: turn.id, status } },
    });
    runtime.activeTurn = null;
  }

  async #readThread(threadId: string): Promise<ThreadResponse> {
    const runtime = this.#threads.get(threadId);
    const messages = await getSessionMessages(
      threadId,
      runtime?.config.cwd ? { dir: runtime.config.cwd } : undefined,
    );
    const turns: NonNullable<ThreadResponse["thread"]["turns"]> = [];
    let current: (typeof turns)[number] | null = null;
    for (const message of messages) {
      if (message.parent_tool_use_id) continue;
      const text = messageText(message.message);
      if (message.type === "user") {
        if (!text) continue;
        current = {
          id: message.uuid,
          status: "completed",
          items: [
            {
              id: message.uuid,
              type: "userMessage",
              clientId: message.uuid,
              content: [{ type: "text", text }],
            },
          ],
        };
        turns.push(current);
      } else if (message.type === "assistant" && text) {
        if (!current) {
          current = { id: message.uuid, status: "completed", items: [] };
          turns.push(current);
        }
        current.items?.push({ id: message.uuid, type: "agentMessage", text });
      }
    }
    return { thread: { id: threadId, turns } };
  }

  #createOpenBotServers(threadId: string) {
    const call = (namespace: string, name: string, args: unknown) =>
      this.#callDynamicTool(threadId, namespace, name, args);
    return {
      openbot_browser: createSdkMcpServer({
        name: "openbot_browser",
        version: "0.1.0",
        tools: [
          tool(
            "open",
            "Open an HTTP(S) URL in OpenBot's private browser.",
            { url: z.string() },
            (args) => call("openbot_browser", "open", args),
          ),
          tool("list_tabs", "List OpenBot browser tabs.", {}, (args) =>
            call("openbot_browser", "list_tabs", args),
          ),
          tool(
            "snapshot",
            "Read a browser page and get element references.",
            { tabId: z.string() },
            (args) => call("openbot_browser", "snapshot", args),
          ),
          tool(
            "act",
            "Click, type, press a key, scroll, navigate, or reload in OpenBot's browser.",
            {
              tabId: z.string(),
              revision: z.number().int(),
              action: z.object({
                type: z.enum(["click", "type", "key", "scroll", "back", "forward", "reload"]),
                ref: z.string().optional(),
                text: z.string().optional(),
                submit: z.boolean().optional(),
                key: z.string().optional(),
                deltaY: z.number().optional(),
              }),
            },
            (args) => call("openbot_browser", "act", args),
          ),
          tool("screenshot", "Capture the visible browser page.", { tabId: z.string() }, (args) =>
            call("openbot_browser", "screenshot", args),
          ),
          tool("close_tab", "Close an OpenBot browser tab.", { tabId: z.string() }, (args) =>
            call("openbot_browser", "close_tab", args),
          ),
        ],
      }),
      openbot: createSdkMcpServer({
        name: "openbot",
        version: "0.1.0",
        tools: [
          tool("list_agents", "List OpenBot agents that can receive local messages.", {}, (args) =>
            call("openbot", "list_agents", args),
          ),
          tool(
            "send_message",
            "Send an asynchronous message or local files to OpenBot teammates.",
            {
              recipientBotIds: z.array(z.string()).min(1).max(32),
              text: z.string().min(1).max(100_000),
              paths: z.array(z.string()).max(10).optional(),
              replyToMessageId: z.string().nullable().optional(),
            },
            (args) => call("openbot", "send_message", args),
          ),
        ],
      }),
    };
  }

  async #callDynamicTool(
    threadId: string,
    namespace: string,
    name: string,
    args: unknown,
  ): Promise<CallToolResult> {
    const runtime = this.#requireThread(threadId);
    const result = await this.#callServerRequest("item/tool/call", {
      threadId,
      turnId: runtime.activeTurn?.id ?? randomUUID(),
      callId: randomUUID(),
      namespace,
      tool: name,
      arguments: args,
    });
    if (!isRecord(result)) return { content: [{ type: "text" as const, text: String(result) }] };
    const content: CallToolResult["content"] = [];
    if (Array.isArray(result.contentItems)) {
      for (const item of result.contentItems) content.push(...dynamicContent(item));
    }
    return { content, isError: result.success === false };
  }

  async #requestUserInput(
    threadId: string,
    input: DynamicRecord,
    toolUseId: string,
  ): Promise<PermissionResult> {
    const runtime = this.#requireThread(threadId);
    const rawQuestions = Array.isArray(input.questions) ? input.questions.filter(isRecord) : [];
    const questions = rawQuestions.map((question, index) => ({
      id: `question-${index}`,
      header: isString(question.header) ? question.header : "Question",
      question: isString(question.question) ? question.question : "Claude needs more information.",
      options: Array.isArray(question.options) ? question.options : undefined,
    }));
    const result = await this.#callServerRequest("item/tool/requestUserInput", {
      threadId,
      turnId: runtime.activeTurn?.id ?? randomUUID(),
      itemId: toolUseId,
      questions,
    });
    const responseAnswers = isRecord(result) && isRecord(result.answers) ? result.answers : {};
    const answers = Object.fromEntries(
      questions.map((question) => {
        const entry = responseAnswers[question.id];
        const values = isRecord(entry) && Array.isArray(entry.answers) ? entry.answers : [];
        return [
          question.question,
          values.filter((value): value is string => isString(value)).join(", "),
        ];
      }),
    );
    return { behavior: "allow", updatedInput: { questions: input.questions, answers } };
  }

  #callServerRequest(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.#pendingServerRequests.set(id, { resolve, reject });
      this.emit("request", { id, method, params });
    });
  }

  #requireThread(threadId: string): ThreadRuntime {
    const runtime = this.#threads.get(threadId);
    if (!runtime) throw new Error(`Unknown Claude thread: ${threadId}`);
    return runtime;
  }
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  readonly #values: SDKUserMessage[] = [];
  readonly #waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  #closed = false;

  push(value: SDKUserMessage): void {
    if (this.#closed) throw new Error("Claude input queue is closed.");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

const CLAUDE_MODELS = [
  {
    model: "claude-fable-5",
    displayName: "Claude Fable 5",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({
      reasoningEffort,
    })),
  },
  {
    model: "claude-opus-5",
    displayName: "Claude Opus 5",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({
      reasoningEffort,
    })),
  },
  {
    model: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({
      reasoningEffort,
    })),
  },
];

function readThreadConfig(params: unknown): ThreadConfig {
  const roots =
    isRecord(params) && Array.isArray(params.runtimeWorkspaceRoots)
      ? params.runtimeWorkspaceRoots.filter((value): value is string => isString(value))
      : [];
  const cwd = requiredString(params, "cwd");
  return {
    cwd,
    model: getString(params, "model") ?? undefined,
    effort: getString(params, "effort") ?? undefined,
    developerInstructions: getString(params, "developerInstructions") ?? "",
    additionalDirectories: [...new Set([cwd, ...roots])],
    persistSession: !isRecord(params) || params.persistSession !== false,
  };
}

function requiredString(value: unknown, key: string): string {
  const result = getString(value, key);
  if (!result) throw new Error(`${key} is required.`);
  return result;
}

function readInputText(params: unknown): string {
  if (!isRecord(params) || !Array.isArray(params.input)) return "";
  return params.input
    .filter(isRecord)
    .filter((item) => item.type === "text" && isString(item.text))
    .map((item) => item.text as string)
    .join("\n");
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return "";
  if (isString(message.content)) return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(isRecord)
    .filter((block) => block.type === "text" && isString(block.text))
    .map((block) => block.text as string)
    .join("\n");
}

function dynamicContent(value: unknown): CallToolResult["content"] {
  if (!isRecord(value)) return [];
  if (value.type === "inputText" && isString(value.text)) {
    return [{ type: "text" as const, text: value.text }];
  }
  if (value.type === "inputImage" && isString(value.imageUrl)) {
    const match = value.imageUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (match) return [{ type: "image" as const, mimeType: match[1], data: match[2] }];
  }
  return [];
}

function normalizeClaudeModel(model: string): string {
  return model.startsWith("claude-") ? model : "claude-opus-5";
}

function normalizeClaudeEffort(effort: string): "low" | "medium" | "high" | "xhigh" | "max" {
  return ["low", "medium", "high", "xhigh", "max"].includes(effort)
    ? (effort as "low" | "medium" | "high" | "xhigh" | "max")
    : "high";
}

function thinkingTokens(effort: string): number {
  return { low: 2_000, medium: 8_000, high: 16_000, xhigh: 32_000, max: 64_000 }[effort] ?? 16_000;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
