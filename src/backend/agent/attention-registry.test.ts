// @vitest-environment node
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  AGENT_RUNTIME_QUESTION_DESCRIPTION_LIMIT,
  AGENT_RUNTIME_TEXT_LIMIT,
  type AgentEvent,
  type BrowserTab,
  isAgentEvent,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "../agent-client";
import { AgentService } from "../agent-service";
import {
  FakeAgentClient,
  fakeBrowser,
  openBotToolPayload,
  startAgentTestFixture,
  stopAgentTestFixture,
  stores,
  waitFor,
} from "../agent-service-test-harness";

let root: string;
let service: AgentService | null = null;

beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
});

afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});

describe.sequential("AttentionRegistry: prompts, approvals and browser takeovers", () => {
  it("surfaces Codex approvals without auto-accepting and maps one-shot decisions", async () => {
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
    await service.sendMessage({ botId: "chief", text: "Need an approval" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    if (!client) throw new Error("Codex client was not created.");
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!turnId) throw new Error("Turn did not start.");
    const externalId = store.activeProviderSession("chief")?.externalSessionId;
    if (!externalId) throw new Error("External thread did not start.");

    client.emit("request", {
      method: "item/commandExecution/requestApproval",
      id: "approval-command",
      params: {
        threadId: externalId,
        turnId,
        command: ["npm", "test"],
        cwd: "/tmp/openbot",
        reason: "r".repeat(1_000),
      },
    });
    await waitFor(() => events.some((event) => event.type === "approval"));
    expect(client.responses).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval",
        approval: expect.objectContaining({
          requestId: "approval-command",
          botId: "chief",
          kind: "command",
          command: "npm test",
          cwd: "/tmp/openbot",
        }),
      }),
    );
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot: service.getRuntimeSnapshot() })).toBe(true);
    expect(service.getRuntimeSnapshot().pendingApprovals[0]?.reason).toHaveLength(AGENT_RUNTIME_TEXT_LIMIT);
    expect(service.getRuntimeSnapshot().pendingApprovals[0]?.truncated).toBe(true);

    await service.respondToApproval({ requestId: "approval-command", decision: "accept" });
    expect(client.responses).toEqual([{ id: "approval-command", result: { decision: "accept" } }]);
    expect(events).toContainEqual({
      type: "agent-input-resolved",
      kind: "approval",
      requestId: "approval-command",
      botId: "chief",
    });
    expect(events.findLast((event) => event.type === "runtime-snapshot")).toMatchObject({
      snapshot: { pendingApprovals: [] },
    });

    client.emit("request", {
      method: "item/permissions/requestApproval",
      id: "approval-permissions",
      params: {
        threadId: externalId,
        turnId,
        permissions: {
          fileSystem: { read: ["/tmp/openbot"], write: ["/tmp/openbot/out"] },
          network: { enabled: true },
        },
      },
    });
    await waitFor(() => events.filter((event) => event.type === "approval").length === 2);
    await service.respondToApproval({ requestId: "approval-permissions", decision: "decline" });
    expect(client.responses.at(-1)).toEqual({
      id: "approval-permissions",
      result: { permissions: {}, scope: "turn" },
    });
  });
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
