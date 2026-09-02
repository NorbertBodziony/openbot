// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  AGENT_RUNTIME_QUESTION_DESCRIPTION_LIMIT,
  type AgentEvent,
  type BrowserTab,
  isAgentEvent,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "./agent-client";
import { AgentService } from "./agent-service";
import {
  CREATE_BOT_INPUT,
  createFakeClaude,
  createFakeCodex,
  FakeAgentClient,
  fakeBrowser,
  notification,
  openBotToolPayload,
  stores,
  waitFor,
} from "./agent-service-test-harness";

let root: string;
let logPath: string;
let service: AgentService | null = null;
const originalCodexPath = process.env.OPENBOT_CODEX_PATH;
const originalClaudePath = process.env.OPENBOT_CLAUDE_PATH;
const originalGrokPath = process.env.OPENBOT_GROK_PATH;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-agent-test-"));
  logPath = join(root, "protocol.jsonl");
  process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
  process.env.OPENBOT_CODEX_PATH = await createFakeCodex(root);
  process.env.OPENBOT_CLAUDE_PATH = join(root, "missing-claude");
  process.env.OPENBOT_GROK_PATH = join(root, "missing-grok");
});

afterEach(async () => {
  await service?.stop();
  service = null;
  vi.useRealTimers();
  if (originalCodexPath === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = originalCodexPath;
  if (originalClaudePath === undefined) delete process.env.OPENBOT_CLAUDE_PATH;
  else process.env.OPENBOT_CLAUDE_PATH = originalClaudePath;
  if (originalGrokPath === undefined) delete process.env.OPENBOT_GROK_PATH;
  else process.env.OPENBOT_GROK_PATH = originalGrokPath;
  delete process.env.OPENBOT_FAKE_CODEX_LOG;
  delete process.env.OPENBOT_FAKE_AGENT_TOOL;
  delete process.env.OPENBOT_FAKE_AGENT_TOOL_PATHS;
  delete process.env.OPENBOT_FAKE_AGENT_TOOL_CALLS;
  delete process.env.OPENBOT_FAKE_THREAD_READ_DELAY;
  delete process.env.OPENBOT_FAKE_AUTO_COMPLETE;
  delete process.env.OPENBOT_FAKE_CONTEXT_USAGE;
  delete process.env.OPENBOT_FAKE_COMPACTION_ERROR;
  delete process.env.OPENBOT_FAKE_ARCHIVED_THREAD;
  delete process.env.OPENBOT_FAKE_TURN_START_RESPONSE_DELAY;
  delete process.env.OPENBOT_FAKE_WARNING;
  delete process.env.OPENBOT_FAKE_CLAUDE_LOGIN_LOG;
  await rm(root, { recursive: true, force: true });
});

describe.sequential("AgentService: questions", () => {
  it("surfaces Computer Use app access elicitations and returns the user's persistence choice", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Use Telegram" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The Computer Use test turn did not start.");

    client.emit("request", {
      method: "mcpServer/elicitation/request",
      id: "computer-use-always",
      params: {
        threadId,
        turnId,
        serverName: "computer-use",
        mode: "openai/form",
        _meta: { persist: ["always"] },
        message: "Allow ChatGPT to use Telegram?",
        requestedSchema: { type: "object", properties: {} },
      },
    });

    await waitFor(() => events.some((event) => event.type === "prompt"));
    expect(client.responses).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "prompt",
        requestId: "computer-use-always",
        botId: "chief",
        questions: [
          expect.objectContaining({
            question: "Allow ChatGPT to use Telegram?",
            options: [
              expect.objectContaining({ label: "Allow once" }),
              expect.objectContaining({ label: "Always allow" }),
              expect.objectContaining({ label: "Don't allow" }),
            ],
          }),
        ],
      }),
    );

    await service.respondToPrompt({
      requestId: "computer-use-always",
      answers: { "mcp-elicitation-decision": ["Always allow"] },
    });
    expect(client.responses.at(-1)).toEqual({
      id: "computer-use-always",
      result: { action: "accept", content: {}, _meta: { persist: "always" } },
    });

    client.emit("request", {
      method: "mcpServer/elicitation/request",
      id: "computer-use-decline",
      params: {
        threadId,
        turnId,
        serverName: "computer-use",
        mode: "form",
        _meta: { persist: ["always"] },
        message: "Allow ChatGPT to use Preview?",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await waitFor(() => events.filter((event) => event.type === "prompt").length === 2);
    await service.respondToPrompt({
      requestId: "computer-use-decline",
      answers: { "mcp-elicitation-decision": ["Don't allow"] },
    });
    expect(client.responses.at(-1)).toEqual({
      id: "computer-use-decline",
      result: { action: "decline", content: null, _meta: null },
    });

    client.emit("request", {
      method: "mcpServer/elicitation/request",
      id: "unsupported-elicitation",
      params: {
        threadId,
        turnId,
        serverName: "other-plugin",
        mode: "form",
        _meta: null,
        message: "Enter a value.",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "unsupported-elicitation"));
    expect(client.responses.at(-1)).toEqual({
      id: "unsupported-elicitation",
      result: { action: "decline", content: null, _meta: null },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", code: "mcp_safety_handoff", botId: "chief" }),
    );
  });

  it("provides a default-mode ask_user tool that resolves through the Questions card", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Ask me a question" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    if (!client) throw new Error("Codex client was not created.");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!threadId || !turnId) throw new Error("Turn did not start.");

    const optionLabel = "L".repeat(INPUT_LIMITS.promptOptionLabel);
    client.emit("request", {
      method: "item/tool/call",
      id: "question-call",
      params: {
        threadId,
        turnId,
        callId: "question-call",
        namespace: "openbot",
        tool: "ask_user",
        arguments: {
          questions: [
            {
              id: "favorite",
              header: "Favorite",
              question: "What is your favorite color?",
              options: [{ label: optionLabel, description: "d".repeat(1_000) }],
            },
            {
              id: "token",
              header: "Token",
              question: "What is the private token?",
              isSecret: true,
            },
          ],
        },
      },
    });
    await waitFor(() => events.some((event) => event.type === "prompt"));
    const runtimeSnapshot = service.getRuntimeSnapshot();
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot: runtimeSnapshot })).toBe(true);
    expect(runtimeSnapshot.pendingPrompts[0]?.questions[0]?.options?.[0]?.description).toHaveLength(
      AGENT_RUNTIME_QUESTION_DESCRIPTION_LIMIT,
    );
    expect(runtimeSnapshot.pendingPrompts[0]?.questions[0]?.options?.[0]?.label).toBe(optionLabel);
    expect(client.responses).toHaveLength(0);
    const pendingMessage = (await service.readConversation("chief")).messages.find(
      (message) => message.questionPrompt?.requestId === "question-call",
    );
    expect(pendingMessage).toMatchObject({
      itemType: "question_prompt",
      text: expect.stringContaining("What is your favorite color?"),
      questionPrompt: { resolution: null },
    });
    expect(runtimeSnapshot.latestMessages).not.toContainEqual(expect.objectContaining({ id: pendingMessage?.id }));

    await service.respondToPrompt({
      requestId: "question-call",
      answers: { favorite: [optionLabel], token: ["super-secret"] },
    });
    expect(events).toContainEqual({
      type: "agent-input-resolved",
      kind: "prompt",
      requestId: "question-call",
      botId: "chief",
    });
    expect(events.findLast((event) => event.type === "runtime-snapshot")).toMatchObject({
      snapshot: { pendingPrompts: [] },
    });
    await waitFor(() => client.responses.length === 1);
    expect(client.responses[0]).toMatchObject({
      id: "question-call",
      result: expect.objectContaining({ success: true }),
    });
    const result = client.responses[0]?.result;
    if (!isDynamicRecord(result) || !Array.isArray(result.contentItems)) {
      throw new Error("The question result has no content items.");
    }
    const content = result.contentItems[0];
    if (!isDynamicRecord(content) || !isString(content.text)) {
      throw new Error("The question result has no text content.");
    }
    expect(JSON.parse(content.text)).toEqual({ favorite: [optionLabel], token: ["super-secret"] });

    const resolvedMessage = (await service.readConversation("chief")).messages.find(
      (message) => message.questionPrompt?.requestId === "question-call",
    );
    expect(resolvedMessage?.questionPrompt?.resolution).toEqual({
      status: "answered",
      responses: {
        favorite: { status: "answered", answers: [optionLabel] },
        token: { status: "answered" },
      },
    });
    expect(resolvedMessage?.text).toContain(`Answer: ${optionLabel}`);
    expect(resolvedMessage?.text).toContain("Answer: Private answer");
    expect(JSON.stringify(resolvedMessage)).not.toContain("super-secret");
    const persisted = store.database.readConversation(
      "chief",
      resolvedMessage?.turnId ? (store.list().find((bot) => bot.id === "chief")?.threadId ?? null) : null,
    );
    expect(JSON.stringify(persisted)).not.toContain("super-secret");
    expect(service.searchConversationMessages(optionLabel, "chief").results).toEqual([
      expect.objectContaining({ message: expect.objectContaining({ id: resolvedMessage?.id }) }),
    ]);

    client.emit("request", {
      method: "item/tool/call",
      id: "skipped-question-call",
      params: {
        threadId,
        turnId,
        callId: "skipped-question-call",
        namespace: "openbot",
        tool: "ask_user",
        arguments: {
          questions: [{ id: "favorite", header: "Favorite", question: "Choose again." }],
        },
      },
    });
    await waitFor(() => events.filter((event) => event.type === "prompt").length === 2);
    await service.respondToPrompt({ requestId: "skipped-question-call", answers: { favorite: [] } });
    expect(
      (await service.readConversation("chief")).messages.find(
        (message) => message.questionPrompt?.requestId === "skipped-question-call",
      )?.questionPrompt?.resolution,
    ).toEqual({ status: "answered", responses: { favorite: { status: "skipped" } } });

    client.emit("request", {
      method: "item/tool/call",
      id: "cancelled-question-call",
      params: {
        threadId,
        turnId,
        callId: "cancelled-question-call",
        namespace: "openbot",
        tool: "ask_user",
        arguments: {
          questions: [{ id: "favorite", header: "Favorite", question: "Choose one more time." }],
        },
      },
    });
    await waitFor(() => events.filter((event) => event.type === "prompt").length === 3);
    await service.respondToPrompt({ requestId: "cancelled-question-call", answers: {} });
    expect(
      (await service.readConversation("chief")).messages.find(
        (message) => message.questionPrompt?.requestId === "cancelled-question-call",
      )?.questionPrompt?.resolution,
    ).toEqual({ status: "cancelled" });

    client.emit("request", {
      method: "item/tool/call",
      id: "duplicate-question-call",
      params: {
        threadId,
        turnId,
        callId: "duplicate-question-call",
        namespace: "openbot",
        tool: "ask_user",
        arguments: {
          questions: [
            { id: "duplicate", header: "Secret", question: "Private value?", isSecret: true },
            { id: "duplicate", header: "Public", question: "Public value?" },
          ],
        },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "duplicate-question-call"));
    expect(client.responses.find((response) => response.id === "duplicate-question-call")?.result).toMatchObject({
      success: false,
    });
    expect(events.filter((event) => event.type === "prompt")).toHaveLength(3);

    const invalidPrompts = [
      {
        id: "too-many-questions-call",
        questions: Array.from({ length: 33 }, (_, index) => ({
          id: `question-${index}`,
          header: "Question",
          question: `Question ${index}?`,
        })),
      },
      {
        id: "too-many-options-call",
        questions: [
          {
            id: "options",
            header: "Options",
            question: "Choose one.",
            options: Array.from({ length: 6 }, (_, index) => ({ label: `Option ${index}` })),
          },
        ],
      },
      {
        id: "long-question-call",
        questions: [{ id: "long", header: "Long", question: "q".repeat(2_001) }],
      },
    ];
    for (const invalidPrompt of invalidPrompts) {
      client.emit("request", {
        method: "item/tool/call",
        id: invalidPrompt.id,
        params: {
          threadId,
          turnId,
          callId: invalidPrompt.id,
          namespace: "openbot",
          tool: "ask_user",
          arguments: { questions: invalidPrompt.questions },
        },
      });
      await waitFor(() => client.responses.some((response) => response.id === invalidPrompt.id));
      expect(client.responses.find((response) => response.id === invalidPrompt.id)?.result).toMatchObject({
        success: false,
      });
    }
    expect(events.filter((event) => event.type === "prompt")).toHaveLength(3);

    client.emit("request", {
      method: "item/tool/requestUserInput",
      id: "empty-legacy-question",
      params: { threadId, turnId, questions: [] },
    });
    await waitFor(() => client.responses.some((response) => response.id === "empty-legacy-question"));
    expect(client.responses.find((response) => response.id === "empty-legacy-question")?.result).toEqual({
      answers: {},
    });
    expect(events.filter((event) => event.type === "prompt")).toHaveLength(3);

    client.emit("request", {
      method: "item/tool/call",
      id: "retry-question-call",
      params: {
        threadId,
        turnId,
        callId: "retry-question-call",
        namespace: "openbot",
        tool: "ask_user",
        arguments: {
          questions: [{ id: "retry", header: "Retry", question: "Can this answer be retried?" }],
        },
      },
    });
    await waitFor(() => events.filter((event) => event.type === "prompt").length === 4);
    await expect(
      service.respondToPrompt({ requestId: "retry-question-call", answers: { typo: ["Yes"] } }),
    ).rejects.toThrow("does not match an active question");
    expect(client.responses.some((response) => response.id === "retry-question-call")).toBe(false);
    expect(
      (await service.readConversation("chief")).messages.find(
        (message) => message.questionPrompt?.requestId === "retry-question-call",
      )?.questionPrompt?.resolution,
    ).toBeNull();
    client.responseError = new Error("Provider process is not running.");
    await expect(
      service.respondToPrompt({ requestId: "retry-question-call", answers: { retry: ["Yes"] } }),
    ).rejects.toThrow("Provider process is not running.");
    expect(
      (await service.readConversation("chief")).messages.find(
        (message) => message.questionPrompt?.requestId === "retry-question-call",
      )?.questionPrompt?.resolution,
    ).toBeNull();
    client.responseError = null;
    await service.respondToPrompt({ requestId: "retry-question-call", answers: { retry: ["Yes"] } });
    expect(
      (await service.readConversation("chief")).messages.find(
        (message) => message.questionPrompt?.requestId === "retry-question-call",
      )?.questionPrompt?.resolution,
    ).toEqual({ status: "answered", responses: { retry: { status: "answered", answers: ["Yes"] } } });

    client.emit("request", {
      method: "item/tool/call",
      id: "persistence-question-call",
      params: {
        threadId,
        turnId,
        callId: "persistence-question-call",
        namespace: "openbot",
        tool: "ask_user",
        arguments: {
          questions: [{ id: "delivery", header: "Delivery", question: "Was the answer delivered?" }],
        },
      },
    });
    await waitFor(() => events.filter((event) => event.type === "prompt").length === 5);
    const persistenceFailure = vi.spyOn(store.database, "persistConversation").mockImplementationOnce(() => {
      throw new Error("Database write failed.");
    });
    await expect(
      service.respondToPrompt({ requestId: "persistence-question-call", answers: { delivery: ["Yes"] } }),
    ).resolves.toBeUndefined();
    expect(client.responses.filter((response) => response.id === "persistence-question-call")).toHaveLength(1);
    await expect(
      service.respondToPrompt({ requestId: "persistence-question-call", answers: { delivery: ["Yes"] } }),
    ).rejects.toThrow("no longer active");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", code: "prompt_persistence_failed", botId: "chief" }),
    );
    persistenceFailure.mockRestore();
  });

  it("does not use a question prompt summary as the completed assistant reply", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "DONE", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Ask only one question" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The question-only turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "question-only-call",
      params: {
        threadId,
        turnId,
        callId: "question-only-call",
        namespace: "openbot",
        tool: "ask_user",
        arguments: {
          questions: [{ id: "scope", header: "Scope", question: "Which scope should we use?" }],
        },
      },
    });
    await waitFor(() => events.some((event) => event.type === "prompt"));
    await service.respondToPrompt({ requestId: "question-only-call", answers: { scope: ["Small"] } });
    const previewBeforeCompletion = service.listBots().find((bot) => bot.id === "chief")?.preview;

    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } }),
    );
    await waitFor(() => events.some((event) => event.type === "turn-completed"));

    const previewAfterCompletion = service.listBots().find((bot) => bot.id === "chief")?.preview;
    expect(previewAfterCompletion).toBe(previewBeforeCompletion);
    expect(previewAfterCompletion).not.toContain("Which scope should we use?");
  });

  it("keeps prompts from a healthy provider active when another provider exits", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "DONE", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Ask from Codex" });
    await service.setPreferredProvider("claude");
    const claudeBot = await service.createBot({
      ...CREATE_BOT_INPUT,
      name: "Claude Prompt Bot",
      avatarSeed: "setup:claude-prompt",
    });
    await service.sendMessage({ botId: claudeBot.id, text: "Ask from Claude" });
    await waitFor(() => events.filter((event) => event.type === "turn-started").length === 2);

    const codexClient = clients.get("codex");
    const claudeClient = clients.get("claude");
    const codexThreadId = store.activeProviderSession("chief")?.externalSessionId;
    const claudeThreadId = store.activeProviderSession(claudeBot.id)?.externalSessionId;
    const codexTurn = events.find((event) => event.type === "turn-started" && event.botId === "chief");
    const claudeTurn = events.find((event) => event.type === "turn-started" && event.botId === claudeBot.id);
    if (
      !codexClient ||
      !claudeClient ||
      !codexThreadId ||
      !claudeThreadId ||
      codexTurn?.type !== "turn-started" ||
      claudeTurn?.type !== "turn-started"
    ) {
      throw new Error("Both provider turns did not start.");
    }

    codexClient.emit("request", {
      method: "item/tool/call",
      id: "codex-provider-prompt",
      params: {
        threadId: codexThreadId,
        turnId: codexTurn.turnId,
        callId: "codex-provider-prompt",
        namespace: "openbot",
        tool: "ask_user",
        arguments: { questions: [{ id: "codex", header: "Codex", question: "Codex question?" }] },
      },
    });
    claudeClient.emit("request", {
      method: "item/tool/call",
      id: "claude-provider-prompt",
      params: {
        threadId: claudeThreadId,
        turnId: claudeTurn.turnId,
        callId: "claude-provider-prompt",
        namespace: "openbot",
        tool: "ask_user",
        arguments: { questions: [{ id: "claude", header: "Claude", question: "Claude question?" }] },
      },
    });
    await waitFor(() => events.filter((event) => event.type === "prompt").length === 2);

    codexClient.emit("exit", new Error("Codex exited."));
    await waitFor(() => events.some((event) => event.type === "error" && event.code === "codex_exited"));
    expect(
      (await service.readConversation("chief")).messages.find(
        (message) => message.questionPrompt?.requestId === "codex-provider-prompt",
      )?.questionPrompt?.resolution,
    ).toEqual({ status: "expired" });
    expect(
      (await service.readConversation(claudeBot.id)).messages.find(
        (message) => message.questionPrompt?.requestId === "claude-provider-prompt",
      )?.questionPrompt?.resolution,
    ).toBeNull();

    await service.respondToPrompt({ requestId: "claude-provider-prompt", answers: { claude: ["Still active"] } });
    expect(claudeClient.responses.find((response) => response.id === "claude-provider-prompt")).toBeDefined();
  });

  it("pauses a browser tool call until the user resolves the takeover", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const tabs: BrowserTab[] = [];
    const browser = fakeBrowser(tabs);
    browser.handleDynamicTool = async (params) => {
      if (params.tool === "open") {
        tabs.push({
          id: "protected-tab",
          title: "Sign in",
          url: "https://example.com/login",
          loading: false,
          ownerThreadId: params.threadId,
          ownerBotId: params.ownerBotId ?? null,
        });
      }
      return { success: true, contentItems: [] };
    };
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, browser, 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Open a protected page" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    const externalThreadId = store.activeProviderSession("chief")?.externalSessionId;
    const started = events.find((event) => event.type === "turn-started");
    if (!client || !externalThreadId || started?.type !== "turn-started") throw new Error("Turn did not start.");
    client.emit("request", {
      method: "item/tool/call",
      id: "open-call",
      params: {
        threadId: externalThreadId,
        turnId: started.turnId,
        callId: "open-call",
        namespace: "openbot_browser",
        tool: "open",
        arguments: { url: "https://example.com/login" },
      },
    });
    await waitFor(() => client.responses.length === 1);
    expect(tabs[0]).toMatchObject({
      ownerThreadId: started.threadId,
      ownerBotId: "chief",
    });

    client.emit("request", {
      method: "item/tool/call",
      id: "takeover-call",
      params: {
        threadId: externalThreadId,
        turnId: started.turnId,
        callId: "takeover-call",
        namespace: "openbot_browser",
        tool: "request_takeover",
        arguments: { tabId: "protected-tab" },
      },
    });
    await waitFor(() => events.some((event) => event.type === "browser-takeover-requested"));
    expect(client.responses).toHaveLength(1);
    expect(events.find((event) => event.type === "browser-takeover-requested")).toMatchObject({
      request: { requestId: "takeover-call", botId: "chief", tabId: "protected-tab" },
    });

    await service.respondToBrowserTakeover({ requestId: "takeover-call", decision: "complete" });
    await waitFor(() => client.responses.length === 2);
    expect(openBotToolPayload(client.responses[1]?.result)).toEqual({
      status: "completed",
      next: "Take a fresh snapshot and continue the task.",
    });
    expect(events).toContainEqual({
      type: "browser-takeover-resolved",
      requestId: "takeover-call",
      botId: "chief",
    });
    expect(events.findLast((event) => event.type === "runtime-snapshot")).toMatchObject({
      snapshot: { pendingBrowserTakeovers: [] },
    });

    client.emit("request", {
      method: "item/tool/call",
      id: "takeover-cancel",
      params: {
        threadId: externalThreadId,
        turnId: started.turnId,
        callId: "takeover-cancel",
        namespace: "openbot_browser",
        tool: "request_takeover",
        arguments: { tabId: "protected-tab" },
      },
    });
    await waitFor(() =>
      events.some(
        (event) => event.type === "browser-takeover-requested" && event.request.requestId === "takeover-cancel",
      ),
    );
    await service.respondToBrowserTakeover({ requestId: "takeover-cancel", decision: "cancel" });
    await waitFor(() => client.responses.length === 3);
    expect(openBotToolPayload(client.responses[2]?.result)).toEqual({ status: "cancelled" });
  });

  it("commits an automatic memory only after a successful turn and refreshes the next turn context", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "DONE", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "I prefer concise status updates." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The memory test turn did not start.");
    const startRequest = client.requests.find((request) => request.method === "thread/start");
    expect(JSON.stringify(startRequest?.params)).toContain('"name":"remember"');
    expect(JSON.stringify(startRequest?.params)).toContain('"name":"forget_memory"');

    client.emit("request", {
      method: "item/tool/call",
      id: "remember-request",
      params: {
        threadId,
        turnId,
        callId: "remember-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { text: "The user prefers concise status updates." },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "remember-request"));
    expect(service.listMemories("chief")).toEqual([]);

    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } }),
    );
    await waitFor(() => service?.listMemories("chief").length === 1);
    expect(events).toContainEqual({ type: "memories-changed", botId: "chief" });

    await service.sendMessage({ botId: "chief", text: "Prepare an update." });
    await waitFor(() => client.requests.filter((request) => request.method === "thread/resume").length > 0);
    const resume = client.requests.findLast((request) => request.method === "thread/resume");
    expect(JSON.stringify(resume?.params)).toContain("The user prefers concise status updates.");
  });

  it("discards staged memories after a failed turn and preserves a concurrent manual edit", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "DONE", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await store.getOrCreate("chief");
    const manual = service.createMemory({ botId: "chief", text: "Use Bun for scripts." });
    await store.getOrCreate("research");
    const otherMemory = service.createMemory({ botId: "research", text: "Research-only memory." });
    await service.sendMessage({ botId: "chief", text: "Change my package manager preference." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The memory conflict turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "foreign-memory-request",
      params: {
        threadId,
        turnId,
        callId: "foreign-memory-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { memoryId: otherMemory.id, text: "Changed by another agent." },
      },
    });
    await waitFor(() => client.errors.some((response) => response.id === "foreign-memory-request"));
    expect(service.listMemories("research").map((memory) => memory.text)).toEqual(["Research-only memory."]);

    client.emit("request", {
      method: "item/tool/call",
      id: "update-memory-request",
      params: {
        threadId,
        turnId,
        callId: "update-memory-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { memoryId: manual.id, text: "Use npm for scripts." },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "update-memory-request"));
    service.updateMemory({ botId: "chief", memoryId: manual.id, text: "Use Bun 1.3 for scripts." });
    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } }),
    );
    await waitFor(() => events.some((event) => event.type === "turn-completed"));
    expect(service.listMemories("chief").map((memory) => memory.text)).toEqual(["Use Bun 1.3 for scripts."]);

    await service.sendMessage({ botId: "chief", text: "Remember one temporary value." });
    await waitFor(() => events.filter((event) => event.type === "turn-started").length === 2);
    const failedTurnId = events.filter((event) => event.type === "turn-started")[1]?.turnId;
    if (!failedTurnId) throw new Error("The failed memory turn did not start.");
    client.emit("request", {
      method: "item/tool/call",
      id: "failed-memory-request",
      params: {
        threadId,
        turnId: failedTurnId,
        callId: "failed-memory-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { text: "This must not persist." },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "failed-memory-request"));
    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: failedTurnId, status: "failed" } }),
    );
    await waitFor(() => events.filter((event) => event.type === "turn-completed").length === 2);
    expect(service.listMemories("chief").map((memory) => memory.text)).toEqual(["Use Bun 1.3 for scripts."]);

    await service.sendMessage({ botId: "chief", text: "Remember a value, then stop." });
    await waitFor(() => events.filter((event) => event.type === "turn-started").length === 3);
    const interruptedTurnId = events.filter((event) => event.type === "turn-started")[2]?.turnId;
    if (!interruptedTurnId) throw new Error("The interrupted memory turn did not start.");
    client.emit("request", {
      method: "item/tool/call",
      id: "interrupted-memory-request",
      params: {
        threadId,
        turnId: interruptedTurnId,
        callId: "interrupted-memory-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { text: "This interrupted value must not persist." },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "interrupted-memory-request"));
    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: interruptedTurnId, status: "interrupted" } }),
    );
    await waitFor(() => events.filter((event) => event.type === "turn-completed").length === 3);
    expect(service.listMemories("chief").map((memory) => memory.text)).toEqual(["Use Bun 1.3 for scripts."]);

    await service.sendMessage({ botId: "chief", text: "Remember a value while I clear memory." });
    await waitFor(() => events.filter((event) => event.type === "turn-started").length === 4);
    const clearedTurnId = events.filter((event) => event.type === "turn-started")[3]?.turnId;
    if (!clearedTurnId) throw new Error("The clear-memory turn did not start.");
    client.emit("request", {
      method: "item/tool/call",
      id: "cleared-memory-request",
      params: {
        threadId,
        turnId: clearedTurnId,
        callId: "cleared-memory-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { text: "This staged value must not return after clear." },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "cleared-memory-request"));
    const memoryEventCount = events.filter((event) => event.type === "memories-changed").length;
    service.clearMemories("chief");
    expect(service.listMemories("chief")).toEqual([]);
    expect(events.filter((event) => event.type === "memories-changed")).toHaveLength(memoryEventCount + 1);
    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: clearedTurnId, status: "completed" } }),
    );
    await waitFor(() => events.filter((event) => event.type === "turn-completed").length === 4);
    expect(service.listMemories("chief")).toEqual([]);
    expect(events.filter((event) => event.type === "memories-changed")).toHaveLength(memoryEventCount + 1);
  });

  it("keeps legacy approvals interactive and clears pending approvals on shutdown", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Need a legacy approval" });
    await waitFor(() => clients.get("codex")?.requests.some((request) => request.method === "turn/start"));
    const client = clients.get("codex");
    if (!client) throw new Error("Codex client was not created.");
    const conversationId = store.activeProviderSession("chief")?.externalSessionId;
    if (!conversationId) throw new Error("Conversation did not start.");

    client.emit("request", {
      method: "execCommandApproval",
      id: 42,
      params: { conversationId, command: "git status", reason: "Inspect the worktree." },
    });
    await waitFor(() => client.responses.length === 0);
    await service.respondToApproval({ requestId: 42, decision: "decline" });
    expect(client.responses.at(-1)).toEqual({
      id: 42,
      result: { decision: { denied: { rejection: "The user declined this action." } } },
    });

    client.emit("request", {
      method: "applyPatchApproval",
      id: 43,
      params: { conversationId, turnId: "turn-legacy", reason: "Update the file." },
    });
    await service.stop();
    await expect(service.respondToApproval({ requestId: 43, decision: "accept" })).rejects.toThrow(
      "This approval is no longer active.",
    );
  });
});
