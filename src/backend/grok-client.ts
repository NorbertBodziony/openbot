import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationContentValue,
  type InitializeResponse,
  ndJsonStream,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { type DynamicRecord, isBoolean, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { AgentProvider } from "./agent-client";
import type { GrokCliInfo } from "./cli";
import { type DynamicToolNamespace, LocalMcpBridge, type LocalMcpSession } from "./local-mcp-bridge";
import {
  type AccountRateLimitsReadResult,
  type AppServerNotification,
  type AppServerRequest,
  type DynamicToolResult,
  getArray,
  getRecord,
  getString,
  isRecord,
  type RequestId,
  type ResponseDecoder,
  type RpcError,
  type ThreadItem,
} from "./protocol";

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string];
}

interface PendingServerRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface GrokTurn {
  id: string;
  itemId: string;
  thoughtItemId: string;
  text: string;
  thought: string;
  thoughtStarted: boolean;
  task: Promise<void>;
}

interface GrokThread {
  id: string;
  cwd: string;
  developerInstructions: string;
  configOptions: SessionConfigOption[];
  currentModelId: string | null;
  mcp: LocalMcpSession;
  activeTurn: GrokTurn | null;
  turns: Array<{ id: string; status: string; items: ThreadItem[] }>;
}

interface GrokModel {
  id: string;
  name: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  reasoningEffortWireValues: Map<string, string>;
  usesModelReasoningEffort: boolean | null;
}

export class GrokAgentClient extends EventEmitter<ClientEvents> {
  readonly provider: AgentProvider = "grok";
  readonly #cli: GrokCliInfo;
  readonly #requestTimeoutMs: number;
  readonly #bridge = new LocalMcpBridge();
  readonly #threads = new Map<string, GrokThread>();
  readonly #pendingServerRequests = new Map<RequestId, PendingServerRequest>();
  #process: ChildProcessWithoutNullStreams | null = null;
  #connection: ClientSideConnection | null = null;
  #initialized: Promise<void> | null = null;
  #initialization: InitializeResponse | null = null;
  #models: GrokModel[] = [];
  #signedIn = false;
  #stopping = false;

  constructor(cli: GrokCliInfo, requestTimeoutMs = 30_000) {
    super();
    this.#cli = cli;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  get running(): boolean {
    return this.#process !== null && this.#process.exitCode === null && !this.#stopping;
  }

  start(): void {
    if (this.running) return;
    this.#stopping = false;
    const child = spawn(this.#cli.executable, ["--no-auto-update", "agent", "stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GROK_OAUTH2_REFERRER: "openbot" },
      shell: process.platform === "win32",
      windowsHide: true,
    });
    this.#process = child;
    const stream = ndJsonStream(
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: Node and DOM declare the same Web Stream ABI with incompatible generic variance.
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: Node and DOM declare the same Web Stream ABI with incompatible generic variance.
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    this.#connection = new ClientSideConnection(
      () => ({
        requestPermission: (params) => this.#requestPermission(params),
        sessionUpdate: (params) => this.#sessionUpdate(params),
        createElicitation: (params) => this.#createElicitation(params),
        extMethod: (method, params) => this.#requestUserInput(method, params),
      }),
      stream,
    );
    child.stderr.on("data", (chunk: Buffer) => {
      const message = redactGrokDiagnostic(chunk.toString("utf8").trim());
      if (message) this.emit("diagnostic", message);
    });
    child.once("error", (error) => this.#fail(error, child));
    child.once("exit", (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#fail(new Error(`Grok ACP process exited with ${suffix}.`), child);
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#process;
    this.#process = null;
    this.#connection = null;
    this.#initialized = null;
    for (const thread of this.#threads.values()) thread.mcp.close();
    this.#threads.clear();
    for (const pending of this.#pendingServerRequests.values()) pending.reject(new Error("Grok session stopped."));
    this.#pendingServerRequests.clear();
    await this.#bridge.close();
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  async request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>, _timeoutMs?: number): Promise<T> {
    if (!this.running) throw new Error("Grok ACP client is not running.");
    switch (method) {
      case "initialize":
        await this.#ensureInitialized();
        return decoder({});
      case "account/read":
        return decoder({
          account: this.#signedIn ? { type: "grok", email: null, planType: null } : null,
          requiresOpenaiAuth: false,
        });
      case "account/rateLimits/read":
        await this.#ensureInitialized();
        if (!this.#signedIn) return decoder({ rateLimits: null, rateLimitsByLimitId: null });
        return decoder(grokRateLimits(await this.#requireConnection().extMethod("_x.ai/billing", {})));
      case "model/list":
        return decoder({
          data: this.#models.map((model) => ({
            model: model.id,
            displayName: model.name,
            description: model.description,
            defaultReasoningEffort: model.defaultReasoningEffort,
            supportedReasoningEfforts: model.supportedReasoningEfforts.map((reasoningEffort) => ({ reasoningEffort })),
          })),
        });
      case "plugin/list":
        return decoder({ marketplaces: [] });
      case "thread/start":
        return decoder(await this.#startThread(params, false));
      case "thread/resume":
        return decoder(await this.#startThread(params, true));
      case "thread/read": {
        const thread = this.#requireThread(requiredString(params, "threadId"));
        return decoder({ thread: { id: thread.id, turns: thread.turns } });
      }
      case "turn/start":
        return decoder(await this.#startTurn(params, false));
      case "turn/steer":
        return decoder(await this.#startTurn(params, true));
      case "turn/interrupt": {
        const thread = this.#requireThread(requiredString(params, "threadId"));
        this.#requireConnection().cancel({ sessionId: thread.id });
        return decoder({});
      }
      case "thread/compact/start":
        return decoder({});
      default:
        throw new Error(`Grok ACP adapter does not implement ${method}.`);
    }
  }

  notify(): void {
    // ACP initialization is a request/response exchange without a follow-up notification.
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

  async #ensureInitialized(): Promise<void> {
    if (this.#initialized) return this.#initialized;
    this.#initialized = this.#initialize();
    return this.#initialized;
  }

  async #initialize(): Promise<void> {
    const connection = this.#requireConnection();
    this.#initialization = await withTimeout(
      connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {} },
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { name: "openbot", title: "OpenBot", version: "0.1.0" },
      }),
      this.#requestTimeoutMs,
      "Grok ACP initialization timed out.",
    );
    const authMethod = process.env.XAI_API_KEY?.trim() ? "xai.api_key" : "cached_token";
    const advertised = this.#initialization.authMethods ?? [];
    const selected =
      advertised.find((method) => method.id === authMethod) ??
      advertised.find((method) => method.id === "cached_token");
    try {
      if (selected) await connection.authenticate({ methodId: selected.id });
      const probe = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
      this.#models = modelsFromSessionSetup(probe);
      if (this.#models.length === 0) {
        throw new Error("Grok CLI did not advertise any ACP models. OpenBot will not guess a fallback model.");
      }
      this.#signedIn = true;
      await connection.closeSession({ sessionId: probe.sessionId }).catch(() => undefined);
    } catch (error) {
      if (isAuthenticationError(error)) {
        this.#signedIn = false;
        return;
      }
      throw error;
    }
  }

  async #startThread(params: unknown, resume: boolean): Promise<{ thread: { id: string } }> {
    await this.#ensureInitialized();
    if (!this.#signedIn) throw new Error("Run `grok login` or set XAI_API_KEY to use Grok.");
    const requestedThreadId = getString(params, "threadId");
    if (resume && requestedThreadId && this.#threads.has(requestedThreadId))
      return { thread: { id: requestedThreadId } };
    const cwd = requiredString(params, "cwd");
    const dynamicTools = getArray(params, "dynamicTools").filter(isDynamicToolNamespace);
    let threadRef: GrokThread | null = null;
    const mcp = await this.#bridge.createSession(
      requestedThreadId ?? randomUUID(),
      dynamicTools,
      () => threadRef?.activeTurn?.id ?? null,
      (call) => this.#callDynamicTool(call),
    );
    try {
      const connection = this.#requireConnection();
      const additionalDirectories = getArray(params, "runtimeWorkspaceRoots").filter(isString);
      let id: string;
      let configOptions: SessionConfigOption[];
      let currentModelId: string | null;
      if (resume && requestedThreadId) {
        const response = await connection.loadSession({
          sessionId: requestedThreadId,
          cwd,
          additionalDirectories,
          mcpServers: mcp.servers,
        });
        id = requestedThreadId;
        configOptions = response.configOptions ?? [];
        currentModelId = currentModelFromSessionSetup(response);
      } else {
        const response = await connection.newSession({ cwd, additionalDirectories, mcpServers: mcp.servers });
        id = response.sessionId;
        configOptions = response.configOptions ?? [];
        currentModelId = currentModelFromSessionSetup(response);
      }
      mcp.setThreadId(id);
      const thread: GrokThread = {
        id,
        cwd,
        developerInstructions: getString(params, "developerInstructions") ?? "",
        configOptions,
        currentModelId,
        mcp,
        activeTurn: null,
        turns: [],
      };
      threadRef = thread;
      this.#threads.set(id, thread);
      await this.#applyConfig(thread, getString(params, "model"), getString(params, "effort"));
      return { thread: { id } };
    } catch (error) {
      mcp.close();
      throw error;
    }
  }

  async #applyConfig(thread: GrokThread, model: string | null, effort: string | null): Promise<void> {
    for (const [category, value] of [
      ["model", model],
      ["thought_level", effort],
    ] as const) {
      if (!value) continue;
      if (category === "thought_level" && thread.currentModelId) {
        const currentModel = this.#models.find((candidate) => candidate.id === thread.currentModelId);
        if (currentModel && currentModel.usesModelReasoningEffort !== null) {
          if (currentModel.usesModelReasoningEffort && currentModel.supportedReasoningEfforts.includes(value)) {
            await this.#requireConnection().request("session/set_model", {
              sessionId: thread.id,
              modelId: thread.currentModelId,
              _meta: { reasoningEffort: currentModel.reasoningEffortWireValues.get(value) ?? value },
            });
          }
          continue;
        }
      }
      const option = thread.configOptions.find(
        (candidate): candidate is Extract<SessionConfigOption, { type: "select" }> =>
          candidate.category === category && candidate.type === "select",
      );
      if (!option) {
        if (category === "model" && thread.currentModelId !== value) {
          await this.#requireConnection().request("session/set_model", {
            sessionId: thread.id,
            modelId: value,
          });
          thread.currentModelId = value;
        }
        continue;
      }
      const selected = selectValues(option).find((candidate) =>
        category === "thought_level" ? normalizeEffort(candidate.value) === value : candidate.value === value,
      );
      if (!selected) continue;
      const response = await this.#requireConnection().setSessionConfigOption({
        sessionId: thread.id,
        configId: option.id,
        value: selected.value,
      });
      thread.configOptions = response.configOptions;
      if (category === "model") thread.currentModelId = selected.value;
    }
  }

  async #startTurn(
    params: unknown,
    steer: boolean,
  ): Promise<{ turn: { id: string; status: string }; turnId?: string }> {
    const thread = this.#requireThread(requiredString(params, "threadId"));
    if (!steer && thread.activeTurn) throw new Error("The Grok thread already has an active turn.");
    if (steer && !thread.activeTurn) throw new Error("The Grok thread has no active turn to steer.");
    await this.#applyConfig(thread, getString(params, "model"), getString(params, "effort"));
    const activeTurn = thread.activeTurn;
    const turnId = steer && activeTurn ? activeTurn.id : (getString(params, "clientUserMessageId") ?? randomUUID());
    const blocks = await promptBlocks(params);
    if (!steer && thread.developerInstructions) {
      blocks.unshift({
        type: "text",
        text: `<openbot-developer-instructions>\n${thread.developerInstructions}\n</openbot-developer-instructions>`,
      });
    }
    if (steer) {
      void this.#requireConnection()
        .prompt({ sessionId: thread.id, prompt: blocks })
        .catch((error) => {
          this.emit("diagnostic", `Grok steer failed: ${String(error)}`);
        });
      return { turn: { id: turnId, status: "inProgress" }, turnId };
    }
    const turn: GrokTurn = {
      id: turnId,
      itemId: `${turnId}:assistant`,
      thoughtItemId: `${turnId}:thought`,
      text: "",
      thought: "",
      thoughtStarted: false,
      task: Promise.resolve(),
    };
    thread.activeTurn = turn;
    this.emit("notification", {
      method: "turn/started",
      params: { threadId: thread.id, turn: { id: turn.id, status: "inProgress" } },
    });
    turn.task = this.#consumePrompt(thread, turn, blocks);
    return { turn: { id: turn.id, status: "inProgress" } };
  }

  async #consumePrompt(thread: GrokThread, turn: GrokTurn, prompt: ContentBlock[]): Promise<void> {
    try {
      const response = await this.#requireConnection().prompt({ sessionId: thread.id, prompt });
      const status =
        response.stopReason === "cancelled"
          ? "interrupted"
          : response.stopReason === "end_turn"
            ? "completed"
            : "failed";
      this.#completeTurn(thread, turn, status, status === "failed" ? response.stopReason : null);
    } catch (error) {
      this.#completeTurn(thread, turn, "failed", error);
    }
  }

  #sessionUpdate(notification: SessionNotification): void {
    const thread = this.#threads.get(notification.sessionId);
    if (!thread) return;
    const turn = thread.activeTurn;
    const update = notification.update;
    if (!turn) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      turn.text += update.content.text;
      this.emit("notification", {
        method: "item/agentMessage/delta",
        params: { threadId: thread.id, turnId: turn.id, itemId: turn.itemId, delta: update.content.text },
      });
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
      /* A delta carries no phase, so the item has to be opened as `commentary` first — otherwise the
         thought lands in an ordinary agentMessage and renders as a chat bubble. */
      if (!turn.thoughtStarted) {
        turn.thoughtStarted = true;
        this.emit("notification", {
          method: "item/started",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: { id: turn.thoughtItemId, type: "agentMessage", phase: "commentary" },
          },
        });
      }
      turn.thought += update.content.text;
      this.emit("notification", {
        method: "item/agentMessage/delta",
        params: { threadId: thread.id, turnId: turn.id, itemId: turn.thoughtItemId, delta: update.content.text },
      });
      return;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.emit("notification", {
        method: update.status === "completed" || update.status === "failed" ? "item/completed" : "item/started",
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: {
            id: update.toolCallId,
            type: "toolCall",
            name: update.name ?? update.title ?? "tool",
            status: update.status,
            arguments: update.rawInput,
            result: update.rawOutput,
          },
        },
      });
      return;
    }
    if (update.sessionUpdate === "plan") {
      const text = update.entries
        .map((entry) => `- [${entry.status === "completed" ? "x" : " "}] ${entry.content}`)
        .join("\n");
      this.emit("notification", {
        method: "item/completed",
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: { id: `${turn.id}:plan`, type: "agentMessage", phase: "analysis", text },
        },
      });
    }
  }

  #completeTurn(thread: GrokThread, turn: GrokTurn, status: string, error: unknown): void {
    if (thread.activeTurn !== turn) return;
    const item = { id: turn.itemId, type: "agentMessage", text: turn.text } satisfies ThreadItem;
    const thoughtItem = turn.thoughtStarted
      ? ({
          id: turn.thoughtItemId,
          type: "agentMessage",
          phase: "commentary",
          text: turn.thought,
        } satisfies ThreadItem)
      : null;
    if (thoughtItem) {
      this.emit("notification", {
        method: "item/completed",
        params: { threadId: thread.id, turnId: turn.id, item: thoughtItem },
      });
    }
    this.emit("notification", { method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
    if (status === "failed" && error) {
      this.emit("notification", {
        method: "error",
        params: { threadId: thread.id, turnId: turn.id, message: String(error) },
      });
    }
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId: thread.id, turn: { id: turn.id, status } },
    });
    thread.turns.push({ id: turn.id, status, items: thoughtItem ? [thoughtItem, item] : [item] });
    thread.activeTurn = null;
  }

  async #requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const thread = this.#threads.get(params.sessionId);
    const turnId = thread?.activeTurn?.id ?? randomUUID();
    const kind =
      params.toolCall.kind === "execute"
        ? "command"
        : ["edit", "delete", "move"].includes(params.toolCall.kind ?? "")
          ? "file-change"
          : "permissions";
    const requestedPermissions = kind === "permissions" ? { [params.toolCall.kind ?? "file-system"]: true } : null;
    const result = await this.#callServerRequest(
      `item/${kind === "command" ? "commandExecution" : kind === "file-change" ? "fileChange" : "permissions"}/requestApproval`,
      {
        threadId: params.sessionId,
        turnId,
        command: params.toolCall.kind === "execute" ? printableInput(params.toolCall.rawInput) : null,
        reason: params.toolCall.title ?? null,
        permissions: requestedPermissions,
        acpOptions: params.options,
      },
    );
    const accepted =
      isRecord(result) &&
      (result.decision === "accept" ||
        result.decision === "approved" ||
        (isRecord(result.permissions) && Object.keys(result.permissions).length > 0));
    const option = bestPermissionOption(params.options, accepted);
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async #requestUserInput(method: string, params: DynamicRecord): Promise<DynamicRecord> {
    const sessionId = getString(params, "sessionId") ?? [...this.#threads.keys()][0];
    const thread = sessionId ? this.#threads.get(sessionId) : undefined;
    const result = await this.#callServerRequest("item/tool/requestUserInput", {
      ...params,
      threadId: sessionId,
      turnId: thread?.activeTurn?.id ?? randomUUID(),
      sourceMethod: method,
    });
    return isRecord(result) ? result : {};
  }

  async #createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const schema = getRecord(params, "requestedSchema");
    const properties = getRecord(schema, "properties") ?? {};
    const questions = Object.entries(properties).flatMap(([id, rawProperty]) => {
      if (!isRecord(rawProperty)) return [];
      const property = rawProperty;
      return [
        {
          id,
          header: getString(property, "title") ?? id,
          question:
            getString(property, "description") ?? getString(params, "message") ?? "Grok needs more information.",
          options: elicitationOptions(property),
        },
      ];
    });
    if (questions.length === 0) {
      questions.push({
        id: "response",
        header: "Grok",
        question: getString(params, "message") ?? "Grok needs confirmation.",
        options: null,
      });
    }
    const result = await this.#requestUserInput("session/elicitation", { ...params, questions });
    const answers = isRecord(result.answers) ? result.answers : null;
    if (!answers) return { action: "decline" };
    const content: Record<string, ElicitationContentValue> = {};
    for (const [id, answerValue] of Object.entries(answers)) {
      const answer = isRecord(answerValue) ? getArray(answerValue, "answers").filter(isString) : [];
      if (answer.length === 0) continue;
      content[id] = elicitationValue(isRecord(properties[id]) ? properties[id] : undefined, answer);
    }
    return Object.keys(content).length > 0 ? { action: "accept", content } : { action: "decline" };
  }

  async #callDynamicTool(params: {
    threadId: string;
    turnId: string;
    callId: string;
    namespace: string;
    tool: string;
    arguments: unknown;
  }): Promise<DynamicToolResult> {
    const result = await this.#callServerRequest("item/tool/call", params);
    if (!isDynamicToolResult(result)) throw new Error("OpenBot returned an invalid dynamic tool result.");
    return result;
  }

  #callServerRequest(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.#pendingServerRequests.set(id, { resolve, reject });
      this.emit("request", { id, method, params });
    });
  }

  #requireThread(id: string): GrokThread {
    const thread = this.#threads.get(id);
    if (!thread) throw new Error(`Unknown Grok session: ${id}`);
    return thread;
  }

  #requireConnection(): ClientSideConnection {
    if (!this.#connection) throw new Error("Grok ACP connection is not running.");
    return this.#connection;
  }

  #fail(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.#process !== child) return;
    this.#process = null;
    if (!this.#stopping) this.emit("exit", error);
  }
}

function isDynamicToolNamespace(value: unknown): value is DynamicToolNamespace {
  return (
    isRecord(value) &&
    value.type === "namespace" &&
    isString(value.name) &&
    Array.isArray(value.tools) &&
    value.tools.every(
      (tool) => isRecord(tool) && tool.type === "function" && isString(tool.name) && isRecord(tool.inputSchema),
    )
  );
}

interface SessionSetupResponse {
  configOptions?: SessionConfigOption[] | null;
  models?: unknown;
}

function modelsFromSessionSetup(response: SessionSetupResponse): GrokModel[] {
  const options = sessionConfigOptions(response);
  const discovered = availableModels(response);
  if (discovered.length === 0) return modelsFromConfig(options);
  const configReasoning = reasoningFromConfig(options);
  return discovered.map((model) => {
    const supportedReasoningEfforts = model.supportedReasoningEfforts ?? configReasoning.supportedReasoningEfforts;
    const reasoningEffortWireValues = model.reasoningEffortWireValues;
    const defaultReasoningEffort =
      model.defaultReasoningEffort && supportedReasoningEfforts.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : supportedReasoningEfforts.includes(configReasoning.defaultReasoningEffort)
          ? configReasoning.defaultReasoningEffort
          : (supportedReasoningEfforts[0] ?? "medium");
    return {
      id: model.id,
      name: model.name,
      description: model.description ?? "Model discovered from Grok CLI through ACP.",
      defaultReasoningEffort,
      supportedReasoningEfforts,
      reasoningEffortWireValues:
        reasoningEffortWireValues && reasoningEffortWireValues.size > 0
          ? reasoningEffortWireValues
          : configReasoning.reasoningEffortWireValues,
      usesModelReasoningEffort: model.usesModelReasoningEffort,
    };
  });
}

function modelsFromConfig(options: SessionConfigOption[]): GrokModel[] {
  const model = options.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.category === "model" && option.type === "select",
  );
  if (!model) return [];
  const reasoning = reasoningFromConfig(options);
  return selectValues(model).map((option) => ({
    id: option.value,
    name: option.name,
    description: option.description ?? "Model discovered from Grok CLI through ACP.",
    ...reasoning,
    usesModelReasoningEffort: null,
  }));
}

function reasoningFromConfig(
  options: SessionConfigOption[],
): Pick<GrokModel, "defaultReasoningEffort" | "supportedReasoningEfforts" | "reasoningEffortWireValues"> {
  const thought = options.find((option) => option.category === "thought_level" && option.type === "select");
  const wireValues = reasoningEffortWireValues(
    thought && thought.type === "select" ? selectValues(thought).map((option) => option.value) : ["medium"],
  );
  const supported = [...wireValues.keys()];
  const currentEffort =
    thought && thought.type === "select" ? (normalizeEffort(thought.currentValue) ?? "medium") : "medium";
  return {
    defaultReasoningEffort: supported.includes(currentEffort) ? currentEffort : (supported[0] ?? "medium"),
    supportedReasoningEfforts: supported.length > 0 ? supported : ["medium"],
    reasoningEffortWireValues: wireValues.size > 0 ? wireValues : new Map([["medium", "medium"]]),
  };
}

function sessionConfigOptions(response: SessionSetupResponse): SessionConfigOption[] {
  return response.configOptions ?? [];
}

function currentModelFromSessionSetup(response: SessionSetupResponse): string | null {
  if (!isRecord(response.models)) return null;
  return isString(response.models.currentModelId) && response.models.currentModelId.trim()
    ? response.models.currentModelId.trim()
    : null;
}

function availableModels(response: SessionSetupResponse): Array<{
  id: string;
  name: string;
  description: string | null;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: string[] | null;
  reasoningEffortWireValues: Map<string, string> | null;
  usesModelReasoningEffort: boolean | null;
}> {
  if (!isRecord(response.models) || !Array.isArray(response.models.availableModels)) return [];
  const seen = new Set<string>();
  return response.models.availableModels.flatMap((value) => {
    if (!isRecord(value) || !isString(value.modelId) || !value.modelId.trim()) return [];
    const id = value.modelId.trim();
    if (seen.has(id)) return [];
    seen.add(id);
    const metadata = isRecord(value._meta) ? value._meta : null;
    const reasoningEffortValues = Array.isArray(metadata?.reasoningEfforts)
      ? metadata.reasoningEfforts.filter(isRecord).flatMap((effort) => (isString(effort.value) ? [effort.value] : []))
      : null;
    const wireValues = reasoningEffortValues ? reasoningEffortWireValues(reasoningEffortValues) : null;
    const supportedReasoningEfforts = wireValues ? [...wireValues.keys()] : null;
    const usesModelReasoningEffort =
      metadata?.supportsReasoningEffort === false
        ? false
        : metadata?.supportsReasoningEffort === true || (supportedReasoningEfforts?.length ?? 0) > 0
          ? true
          : null;
    return [
      {
        id,
        name: isString(value.name) && value.name.trim() ? value.name.trim() : id,
        description: isString(value.description) && value.description.trim() ? value.description.trim() : null,
        defaultReasoningEffort:
          metadata && isString(metadata.reasoningEffort) ? normalizeEffort(metadata.reasoningEffort) : null,
        supportedReasoningEfforts:
          metadata?.supportsReasoningEffort === false
            ? ["medium"]
            : supportedReasoningEfforts && supportedReasoningEfforts.length > 0
              ? supportedReasoningEfforts
              : null,
        reasoningEffortWireValues: wireValues,
        usesModelReasoningEffort,
      },
    ];
  });
}

function selectValues(option: Extract<SessionConfigOption, { type: "select" }>) {
  return option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

function reasoningEffortWireValues(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    const normalized = normalizeEffort(value);
    if (normalized && !result.has(normalized)) result.set(normalized, value);
  }
  return result;
}

function normalizeEffort(value: string): string | null {
  const normalized = value.toLowerCase().replaceAll("-", "_");
  if (["low", "medium", "high", "xhigh", "max"].includes(normalized)) return normalized;
  if (["minimal", "none", "off"].includes(normalized)) return "low";
  if (["extra_high", "very_high"].includes(normalized)) return "xhigh";
  return null;
}

async function promptBlocks(params: unknown): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const item of getArray(params, "input")) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && isString(item.text)) blocks.push({ type: "text", text: item.text });
    if (item.type === "mention" && isString(item.path)) {
      blocks.push({ type: "text", text: `Attached local file: ${item.path}` });
    }
    if (item.type === "localImage" && isString(item.path)) {
      const data = await readFile(item.path);
      blocks.push({ type: "image", data: data.toString("base64"), mimeType: imageMimeType(item.path), uri: item.path });
    }
  }
  return blocks;
}

function imageMimeType(path: string): "image/jpeg" | "image/webp" | "image/png" {
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.webp$/i.test(path)) return "image/webp";
  return "image/png";
}

function grokRateLimits(value: unknown): AccountRateLimitsReadResult {
  const config = getRecord(value, "config");
  const period = getRecord(config, "currentPeriod");
  if (!config || !period) return { rateLimits: null, rateLimitsByLimitId: null };
  const usedPercent = grokCreditUsagePercent(config);
  if (usedPercent === null) return { rateLimits: null, rateLimitsByLimitId: null };
  const start = Date.parse(getString(period, "start") ?? "");
  const end = Date.parse(getString(period, "end") ?? "");
  const durationMins = Number.isFinite(start) && Number.isFinite(end) ? (end - start) / 60_000 : Number.NaN;
  const periodType = getString(period, "type") ?? getString(period, "periodType");
  const weekly = periodType ? periodType.toLowerCase().includes("weekly") : nearWeeklyDuration(durationMins);
  if (!weekly) return { rateLimits: null, rateLimitsByLimitId: null };
  return {
    rateLimits: {
      limitId: "grok",
      primary: null,
      secondary: {
        usedPercent,
        windowDurationMins: Number.isFinite(durationMins) ? durationMins : 10_080,
        resetsAt: Number.isFinite(end) ? end / 1_000 : null,
      },
    },
    rateLimitsByLimitId: null,
  };
}

function grokCreditUsagePercent(config: DynamicRecord): number | null {
  if (config.creditUsagePercent !== undefined) {
    return isNumber(config.creditUsagePercent) && Number.isFinite(config.creditUsagePercent)
      ? Math.max(0, Math.min(100, config.creditUsagePercent))
      : null;
  }
  const limit = grokCentValue(config, "monthlyLimit");
  const used = grokCentValue(config, "used") ?? 0;
  return limit && limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
}

function grokCentValue(config: DynamicRecord, key: string): number | null {
  const cent = getRecord(config, key);
  if (!cent) return null;
  if (cent.val === undefined) return 0;
  return isNumber(cent.val) && Number.isFinite(cent.val) ? cent.val : null;
}

function nearWeeklyDuration(durationMins: number): boolean {
  return Number.isFinite(durationMins) && Math.abs(durationMins - 10_080) <= 10_080 * 0.05;
}

function requiredString(value: unknown, key: string): string {
  const result = getString(value, key);
  if (!result) throw new Error(`${key} is required.`);
  return result;
}

function printableInput(value: unknown): string | null {
  if (isString(value)) return value;
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function bestPermissionOption(options: PermissionOption[], accepted: boolean): PermissionOption | null {
  const kinds = accepted ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  return kinds.flatMap((kind) => options.filter((option) => option.kind === kind))[0] ?? null;
}

function elicitationOptions(property: DynamicRecord): Array<{ label: string; description: string }> | null {
  if (Array.isArray(property.oneOf)) {
    return property.oneOf.filter(isRecord).flatMap((option) => {
      const value = getString(option, "const");
      if (!value) return [];
      return [{ label: getString(option, "title") ?? value, description: getString(option, "description") ?? "" }];
    });
  }
  if (Array.isArray(property.enum)) {
    return property.enum.filter(isString).map((value) => ({ label: value, description: "" }));
  }
  if (property.type === "boolean") {
    return [
      { label: "Yes", description: "" },
      { label: "No", description: "" },
    ];
  }
  return null;
}

function elicitationValue(property: DynamicRecord | undefined, answers: string[]): ElicitationContentValue {
  if (!property) return answers[0] ?? "";
  if (property.type === "array") return answers;
  if (property.type === "boolean") return /^(yes|true|1)$/i.test(answers[0] ?? "");
  if (property.type === "number" || property.type === "integer") {
    const parsed = Number(answers[0]);
    return Number.isFinite(parsed) ? parsed : (answers[0] ?? "");
  }
  return answers[0] ?? "";
}

function isDynamicToolResult(value: unknown): value is DynamicToolResult {
  return (
    isRecord(value) &&
    isBoolean(value.success) &&
    Array.isArray(value.contentItems) &&
    value.contentItems.every(
      (item) =>
        isRecord(item) &&
        ((item.type === "inputText" && isString(item.text)) || (item.type === "inputImage" && isString(item.imageUrl))),
    )
  );
}

function isAuthenticationError(error: unknown): boolean {
  return /auth|login|credential|token|unauthori[sz]ed|api key/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function redactGrokDiagnostic(message: string): string {
  return message
    .replace(/(?:xai[-_ ]api[-_ ]key|authorization|bearer|token)["':= ]+[A-Za-z0-9._-]{8,}/gi, "$1 [redacted]")
    .replace(/xai-[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .slice(0, 2_000);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
