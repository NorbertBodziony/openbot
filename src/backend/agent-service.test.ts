// @vitest-environment node

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import type { AgentEvent, BrowserControlState, BrowserTab } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentClient, AgentProvider } from "./agent-client";
import { AgentService } from "./agent-service";
import { BotStore } from "./bot-store";
import { MailboxStore } from "./mailbox-store";
import {
  type AppServerNotification,
  type DynamicToolCallParams,
  getString,
  type RequestId,
  type ResponseDecoder,
  type RpcError,
} from "./protocol";

let root: string;
let logPath: string;
let service: AgentService | null = null;
const originalCodexPath = process.env.OPENBOT_CODEX_PATH;
const originalClaudePath = process.env.OPENBOT_CLAUDE_PATH;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-agent-test-"));
  logPath = join(root, "protocol.jsonl");
  process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
  process.env.OPENBOT_CODEX_PATH = await createFakeCodex(root);
  process.env.OPENBOT_CLAUDE_PATH = join(root, "missing-claude");
});

afterEach(async () => {
  await service?.stop();
  service = null;
  if (originalCodexPath === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = originalCodexPath;
  if (originalClaudePath === undefined) delete process.env.OPENBOT_CLAUDE_PATH;
  else process.env.OPENBOT_CLAUDE_PATH = originalClaudePath;
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
  await rm(root, { recursive: true, force: true });
});

describe.sequential("AgentService", () => {
  it("resolves only regular files inside the shared directory", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    const nested = join(store.sharedRoot, "nested");
    const sharedFile = join(nested, "report.csv");
    const outside = join(root, "outside.csv");
    const link = join(nested, "outside-link.csv");
    await mkdir(nested, { recursive: true });
    await writeFile(sharedFile, "value\n");
    await writeFile(outside, "secret\n");
    await symlink(outside, link);

    await expect(service.resolveSharedFile("~/OpenBot/Shared/nested/report.csv")).resolves.toMatchObject({
      path: await realpath(sharedFile),
      name: "report.csv",
      size: 6,
    });
    await expect(service.resolveSharedFile(outside)).rejects.toThrow("inside the shared directory");
    await expect(service.resolveSharedFile(link)).rejects.toThrow("inside the shared directory");
  });

  it("resolves only regular files inside the selected agent workspace", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    const bot = await store.createBot();
    const appDirectory = join(bot.workspacePath, "app");
    const page = join(appDirectory, "page.tsx");
    const spaced = join(bot.workspacePath, "lutra brand board.html");
    const outside = join(root, "outside.html");
    const link = join(appDirectory, "outside-link.html");
    await mkdir(appDirectory, { recursive: true });
    await writeFile(page, "export default function Page() {}\n");
    await writeFile(spaced, "<!doctype html>\n");
    await writeFile(outside, "secret\n");
    await symlink(outside, link);

    await expect(service.resolveWorkspaceFile(bot.id, "app/page.tsx")).resolves.toMatchObject({
      path: await realpath(page),
      name: "page.tsx",
    });
    await expect(service.resolveWorkspaceFile(bot.id, page)).resolves.toMatchObject({
      path: await realpath(page),
      name: "page.tsx",
    });
    await expect(service.resolveWorkspaceFile(bot.id, "lutra%20brand%20board.html")).resolves.toMatchObject({
      path: await realpath(spaced),
      name: "lutra brand board.html",
    });
    await expect(service.resolveWorkspaceFile(bot.id, outside)).rejects.toThrow("inside the agent workspace");
    await expect(service.resolveWorkspaceFile(bot.id, link)).rejects.toThrow("inside the agent workspace");
    await expect(service.resolveWorkspaceFile("missing", page)).rejects.toThrow("Unknown bot");
  });

  it("does not surface the skills context-budget notice as an agent error", async () => {
    process.env.OPENBOT_FAKE_WARNING = "Skill descriptions were shortened to fit the skills context budget.";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "First task" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          message: expect.stringContaining("Skill descriptions were shortened"),
        }),
      ]),
    );
  });

  it("expands inline file references before sending text to the agent", async () => {
    const source = join(root, "start-types.d.ts");
    await writeFile(source, "export type Start = true;\n");
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    const [draft] = await service.prepareAttachments([source]);

    await service.sendMessage({
      botId: "chief",
      text: `Review ${serializeAttachmentReference(draft.name, draft.id)}`,
      attachmentDraftIds: [draft.id],
    });
    await waitFor(() => Boolean(clients.get("codex")?.requests.some((request) => request.method === "turn/start")));

    const turn = clients.get("codex")?.requests.find((request) => request.method === "turn/start");
    const inputText = firstInputText(turn?.params);
    expect(inputText).toContain("Review start-types.d.ts");
    expect(inputText).not.toContain("attachment:");
  });

  it("creates independent full-access threads with browser and OpenBot tools", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), () => ({
      screenRecording: true,
      accessibility: true,
    }));
    await service.initialize();

    expect(service.getStatus()).toMatchObject({
      phase: "ready",
      auth: { kind: "chatgpt", email: "codex@example.com" },
      providers: [
        {
          id: "codex",
          state: "available",
          version: "0.144.1",
          email: "codex@example.com",
        },
        { id: "claude", state: "not-installed", version: null },
      ],
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
    });
    await expect(service.getUsage()).resolves.toMatchObject({
      limits: [
        {
          id: "codex",
          primary: { usedPercent: 25, windowDurationMins: 300 },
          secondary: { usedPercent: 40, windowDurationMins: 10_080 },
        },
      ],
    });
    await service.sendMessage({ botId: "chief", text: "First task" });
    await service.sendMessage({ botId: "sales-outbound", text: "Second task" });
    await waitFor(async () => (await protocolMessages()).filter((item) => item.method === "turn/start").length === 2);

    const requests = await protocolMessages();
    const starts = requests.filter((message) => message.method === "thread/start");
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      const params = paramsRecord(start.params);
      if (!params) throw new Error("The fake thread request has no parameters.");
      expect(params).toMatchObject({
        model: "gpt-5.6-luna",
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        ephemeral: false,
        serviceName: "openbot",
      });
      expect(params.runtimeWorkspaceRoots).toEqual([params.cwd, store.sharedRoot]);
      expect(params.developerInstructions).toContain(
        "You have full local computer, filesystem, command, and network access",
      );
      expect(params.developerInstructions).toContain(
        "You may list, read, create, edit, move, and delete files and run local commands in both directories.",
      );
      expect(params.dynamicTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "namespace", name: "openbot_browser" }),
          expect.objectContaining({
            type: "namespace",
            name: "openbot",
            tools: expect.arrayContaining([
              expect.objectContaining({ name: "ask_user" }),
              expect.objectContaining({ name: "list_agents" }),
              expect.objectContaining({ name: "update_profile" }),
            ]),
          }),
        ]),
      );
    }
    for (const turn of requests.filter((message) => message.method === "turn/start")) {
      const params = paramsRecord(turn.params);
      if (!params) throw new Error("The fake turn request has no parameters.");
      expect(params).toMatchObject({
        model: "gpt-5.6-luna",
        effort: "medium",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      expect(params.runtimeWorkspaceRoots).toEqual([params.cwd, store.sharedRoot]);
    }
    expect((await store.getOrCreate("chief")).threadId).not.toBe((await store.getOrCreate("sales-outbound")).threadId);
  });

  it("maps provider browser tool calls to the stable OpenBot thread", async () => {
    const calls: DynamicToolCallParams[] = [];
    const browser = fakeBrowser();
    browser.handleDynamicTool = async (params) => {
      calls.push(params);
      return { success: true, contentItems: [] };
    };
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, browser, null, 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Browse" });
    await waitFor(() => Boolean(store.activeProviderSession("chief")));

    const providerThreadId = store.activeProviderSession("chief")?.externalSessionId;
    const openbotThreadId = (await store.getOrCreate("chief")).threadId;
    const client = clients.get("codex");
    if (!providerThreadId || !openbotThreadId || !client) throw new Error("Browser test thread was not created.");
    expect(providerThreadId).not.toBe(openbotThreadId);

    client.emit("request", {
      method: "item/tool/call",
      id: "browser-call",
      params: {
        threadId: providerThreadId,
        turnId: "turn-browser",
        callId: "browser-call",
        namespace: "openbot_browser",
        tool: "list_tabs",
        arguments: {},
      },
    });

    await waitFor(() => calls.length === 1);
    expect(calls[0]?.threadId).toBe(openbotThreadId);
  });

  it("surfaces Codex approvals without auto-accepting and maps one-shot decisions", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
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
        reason: "Run tests.",
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

    await service.respondToApproval({ requestId: "approval-command", decision: "accept" });
    expect(client.responses).toEqual([{ id: "approval-command", result: { decision: "accept" } }]);

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

  it("provides a default-mode ask_user tool that resolves through the Questions card", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
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
              options: [{ label: "Blue", description: "A calm choice." }],
            },
          ],
        },
      },
    });
    await waitFor(() => events.some((event) => event.type === "prompt"));
    expect(client.responses).toHaveLength(0);

    await service.respondToPrompt({
      requestId: "question-call",
      answers: { favorite: ["Blue"] },
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
    expect(JSON.parse(content.text)).toEqual({ favorite: ["Blue"] });
  });

  it("keeps legacy approvals interactive and clears pending approvals on shutdown", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
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

  it("updates the active account and new-agent defaults with the preferred provider", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "claude");

    await service.initialize();

    expect(service.getStatus()).toMatchObject({
      phase: "ready",
      auth: { kind: "claude", email: "claude@example.com" },
      providers: [
        {
          id: "codex",
          state: "available",
          version: "0.144.1",
          email: "codex@example.com",
        },
        {
          id: "claude",
          state: "available",
          version: "2.1.231",
          email: "claude@example.com",
        },
      ],
    });
    await service.setPreferredProvider("codex");
    expect(service.getStatus()).toMatchObject({
      auth: { kind: "chatgpt", email: "codex@example.com" },
      cliVersion: "0.144.1",
    });
    await expect(service.createBot()).resolves.toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
    });
  });

  it("keeps the agent model and thread when a lazy provider cannot start", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("chief");
    const threadId = await store.ensureThreadId("chief");

    await expect(service.updateBot({ botId: "chief", model: "claude-sonnet-5" })).rejects.toThrow(
      "Claude CLI was not found",
    );
    expect(service.listBots().find((bot) => bot.id === "chief")).toMatchObject({
      model: "gpt-5.6-luna",
      threadId,
    });
  });

  it("starts the second provider when an agent selects its model", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("chief");

    await expect(
      service.updateBot({ botId: "chief", model: "claude-sonnet-5", reasoningEffort: "high" }),
    ).resolves.toMatchObject({ model: "claude-sonnet-5", reasoningEffort: "high" });
    expect(service.getStatus().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex", state: "available" }),
        expect.objectContaining({ id: "claude", state: "available" }),
      ]),
    );
  });

  it("hands one SQLite conversation across Codex, Claude, and a new Codex session", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "First request" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "completed");
    const publicThreadId = service.listBots().find((bot) => bot.id === "chief")?.threadId;

    await service.updateBot({ botId: "chief", model: "claude-sonnet-5" });
    expect(service.listBots().find((bot) => bot.id === "chief")?.threadId).toBe(publicThreadId);
    await service.sendMessage({ botId: "chief", text: "Second request" });
    await waitFor(() => service?.listQueue("chief").deliveries[1]?.status === "completed");

    const claudeInput = clients.get("claude")?.requests.find((request) => request.method === "turn/start")?.params;
    expect(firstInputText(claudeInput)).toContain("CODEX_DONE");
    expect(firstInputText(claudeInput)).toContain("Second request");

    await service.updateBot({ botId: "chief", model: "gpt-5.6-sol" });
    await service.sendMessage({ botId: "chief", text: "Third request" });
    await waitFor(() => service?.listQueue("chief").deliveries[2]?.status === "completed");
    const codexStarts = clients.get("codex")?.requests.filter((request) => request.method === "thread/start");
    expect(codexStarts).toHaveLength(2);
    const codexTurns = clients.get("codex")?.requests.filter((request) => request.method === "turn/start");
    const latestCodexTurn = codexTurns?.at(-1)?.params;
    expect(firstInputText(latestCodexTurn)).toContain("CLAUDE_DONE");

    const conversation = await service.readConversation("chief");
    expect(conversation.threadId).toBe(publicThreadId);
    expect(conversation.messages.map((message) => message.text)).toEqual(
      expect.arrayContaining(["CODEX_DONE", "CLAUDE_DONE"]),
    );
    if (!publicThreadId) throw new Error("The public thread was not created.");
    expect(store.database.listProviderSessions(publicThreadId)).toMatchObject([
      { provider: "codex", state: "inactive" },
      { provider: "claude", state: "inactive" },
      { provider: "codex", state: "active" },
    ]);
  });

  it("stores a visible summary when a provider handoff exceeds its budget", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
      const output = provider === "codex" ? "X".repeat(250_000) : "CLAUDE_DONE";
      const client = new FakeAgentClient(provider, output);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Create a long result" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "completed");
    const publicThreadId = service.listBots().find((bot) => bot.id === "chief")?.threadId;

    await service.updateBot({ botId: "chief", model: "claude-sonnet-5" });
    await service.sendMessage({ botId: "chief", text: "Continue from the result" });
    await waitFor(() => service?.listQueue("chief").deliveries[1]?.status === "completed");

    const claudeTurn = clients.get("claude")?.requests.find((request) => request.method === "turn/start")?.params;
    expect(firstInputText(claudeTurn)).toContain("oldest visible history was summarized");
    if (!publicThreadId) throw new Error("The public thread was not created.");
    expect(store.database.latestThreadSummary(publicThreadId)).toMatchObject({
      threadId: publicThreadId,
      throughMessageId: expect.any(String),
    });
  });

  it("starts a new thread with the persisted onboarding remit", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("chief");
    await service.updateBot({
      botId: "chief",
      title: "Research & writing",
      description: "Researches topics and turns findings into clear writing.",
    });

    await service.sendMessage({
      botId: "chief",
      text: "Focus on research and writing.",
    });
    await waitFor(async () => (await protocolMessages()).some((message) => message.method === "thread/start"));

    const start = (await protocolMessages()).find((message) => message.method === "thread/start");
    const instructions = getString(start?.params, "developerInstructions") ?? "";
    expect(instructions).toContain('"title": "Research & writing"');
    expect(instructions).toContain('"description": "Researches topics and turns findings into clear writing."');
    expect(instructions).toContain("Be pragmatic and direct");
    expect(instructions).toContain("Give the shortest answer that is complete and useful");
    expect(instructions).toContain("Do not add filler");
    expect(instructions).toContain("openbot.ask_user");
    expect(instructions).toContain("GitHub-flavored Markdown tables");
    expect(instructions).toContain("at least three dashes per column");
    expect(instructions).toContain("put exactly ✓ or — in every option cell");
    expect(instructions).toContain("render that Markdown as a comparison table");
    expect(instructions).toContain("standing remit");
  });

  it("keeps rapid messages in FIFO order before the first turn-start event is observed", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "Start immediately" });
    await service.sendMessage({ botId: "chief", text: "Wait behind the first message" });

    await waitFor(() => {
      const deliveries = service?.listQueue("chief").deliveries ?? [];
      return deliveries[0]?.status === "running" && deliveries[1]?.status === "queued";
    });
    const deliveries = service.listQueue("chief").deliveries;
    expect(deliveries.map((delivery) => delivery.text)).toEqual(["Start immediately", "Wait behind the first message"]);
    expect((await protocolMessages()).filter((message) => message.method === "turn/start")).toHaveLength(1);
  });

  it("keeps each completed response after the queued message that started its turn", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "Question 1" });
    await service.sendMessage({ botId: "chief", text: "Question 2" });
    await service.sendMessage({ botId: "chief", text: "Question 3" });
    await service.sendMessage({ botId: "chief", text: "Question 4" });

    await waitFor(() => {
      const deliveries = service?.listQueue("chief").deliveries ?? [];
      return deliveries.length === 4 && deliveries.every((delivery) => delivery.status === "completed");
    });

    const conversation = await service.readConversation("chief");
    const turnMessages = conversation.messages.filter(
      (message) => message.author === "user" || message.author === "assistant",
    );
    expect(turnMessages).toHaveLength(8);
    for (let index = 0; index < turnMessages.length; index += 2) {
      expect(turnMessages[index]?.author).toBe("user");
      expect(turnMessages[index + 1]?.author).toBe("assistant");
      expect(turnMessages[index + 1]?.turnId).toBe(turnMessages[index]?.turnId);
    }
    expect(clients.get("codex")?.requests.filter((request) => request.method === "turn/start")).toHaveLength(4);
  });

  it("queues FIFO instead of steering and continues draining after an interrupt", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "Start" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const active = events.find((event) => event.type === "turn-started");
    if (active?.type !== "turn-started") throw new Error("Turn did not start.");
    await service.sendMessage({ botId: "chief", text: "Run after the first task" });

    const queue = service.listQueue("chief");
    expect(queue.deliveries.map((item) => item.status)).toEqual(["running", "queued"]);
    expect((await protocolMessages()).some((message) => message.method === "turn/steer")).toBe(false);

    await service.interrupt("chief", active.turnId);
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "interrupted");

    await waitFor(async () => (await protocolMessages()).filter((item) => item.method === "turn/start").length === 2);
    expect(service.listQueue("chief").deliveries[1]?.status).toBe("running");

    const conversationSignatures = events
      .filter((event) => event.type === "conversation" && event.snapshot.botId === "chief")
      .map((event) =>
        event.type === "conversation"
          ? JSON.stringify({
              threadId: event.snapshot.threadId,
              activeTurnId: event.snapshot.activeTurnId,
              messages: event.snapshot.messages,
            })
          : "",
      );
    for (let index = 1; index < conversationSignatures.length; index += 1) {
      expect(conversationSignatures[index]).not.toBe(conversationSignatures[index - 1]);
    }
  });

  it("steers a queued delivery into the active turn and completes it with that turn", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "CODEX_DONE", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "Start this turn" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const active = events.find((event) => event.type === "turn-started");
    if (active?.type !== "turn-started") throw new Error("Turn did not start.");
    await service.sendMessage({ botId: "chief", text: "Add this to the active turn" });
    const queued = service.listQueue("chief").deliveries.find((delivery) => delivery.status === "queued");
    if (!queued) throw new Error("Queued delivery was not created.");

    await service.steerQueuedMessage({
      botId: "chief",
      deliveryId: queued.id,
      expectedTurnId: active.turnId,
    });

    const client = clients.get("codex");
    expect(client?.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "turn/steer",
          params: expect.objectContaining({
            expectedTurnId: active.turnId,
            clientUserMessageId: queued.id,
          }),
        }),
      ]),
    );
    const externalThreadId = store.activeProviderSession("chief")?.externalSessionId;
    if (!client || !externalThreadId) throw new Error("Active provider session is missing.");
    client.emit(
      "notification",
      notification("turn/completed", {
        threadId: externalThreadId,
        turn: { id: active.turnId, status: "completed" },
      }),
    );
    await waitFor(() =>
      service
        ?.listQueue("chief")
        .deliveries.filter((delivery) => delivery.id === queued.id)
        .every((delivery) => delivery.status === "completed"),
    );
  });

  it("renders a Codex image generation item and manages its saved image", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    const imagePath = join(root, "codex-image.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Create a mountain observatory." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const started = events.find((event) => event.type === "turn-started");
    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    if (started?.type !== "turn-started" || !client || !threadId) {
      throw new Error("The fake Codex turn did not start.");
    }
    const item = {
      id: "image-call-1",
      type: "image_generation_call",
      status: "in_progress",
      size: "1536x1024",
      aspect_ratio: "landscape",
    };
    client.emit(
      "notification",
      notification("item/started", {
        threadId,
        turnId: started.turnId,
        item,
      }),
    );
    await waitFor(async () =>
      (await service?.readConversation("chief"))?.messages.some(
        (message) => message.id === item.id && message.status === "streaming",
      ),
    );
    client.emit(
      "notification",
      notification("item/completed", {
        threadId,
        turnId: started.turnId,
        item: {
          ...item,
          status: "completed",
          revised_prompt: "A mountain observatory at blue hour",
          saved_path: imagePath,
        },
      }),
    );
    client.emit(
      "notification",
      notification("turn/completed", {
        threadId,
        turn: { id: started.turnId, status: "completed" },
      }),
    );

    await waitFor(async () => {
      const message = (await service?.readConversation("chief"))?.messages.find(
        (candidate) => candidate.id === item.id,
      );
      return message?.status === "completed" && Boolean(message.attachments?.[0]);
    });
    const message = (await service.readConversation("chief")).messages.find((candidate) => candidate.id === item.id);
    expect(message).toMatchObject({
      itemType: "image_generation",
      imageGeneration: {
        prompt: "A mountain observatory at blue hour",
        resolution: "1536x1024",
        aspectRatio: "landscape",
      },
      attachments: [{ kind: "image", previewKind: "image" }],
    });
    await expect(mailbox.resolveAttachment(message?.attachments?.[0]?.id ?? "")).resolves.toMatchObject({
      mimeType: "image/png",
    });
  });

  it("falls back to Codex base64 image results without persisting the encoded payload", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Make this image vivid." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const started = events.find((event) => event.type === "turn-started");
    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    if (started?.type !== "turn-started" || !client || !threadId) {
      throw new Error("The fake Codex turn did not start.");
    }
    const imageCall = { id: "image-call-base64", type: "image_generation_call" };
    client.emit("notification", notification("item/started", { threadId, turnId: started.turnId, item: imageCall }));
    client.emit(
      "notification",
      notification("item/completed", {
        threadId,
        turnId: started.turnId,
        item: {
          ...imageCall,
          status: "completed",
          result: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
        },
      }),
    );
    client.emit(
      "notification",
      notification("turn/completed", {
        threadId,
        turn: { id: started.turnId, status: "completed" },
      }),
    );

    await waitFor(async () => {
      const message = (await service?.readConversation("chief"))?.messages.find(
        (candidate) => candidate.id === imageCall.id,
      );
      return message?.status === "completed" && Boolean(message.attachments?.[0]);
    });
    const message = (await service.readConversation("chief")).messages.find(
      (candidate) => candidate.id === imageCall.id,
    );
    expect(JSON.stringify(message)).not.toContain("iVBORw0KGgo");
    await expect(mailbox.resolveAttachment(message?.attachments?.[0]?.id ?? "")).resolves.toMatchObject({
      mimeType: "image/png",
    });
  });

  it("keeps failed and interrupted image generations visible in the conversation", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Generate two atmospheric studies." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const started = events.find((event) => event.type === "turn-started");
    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    if (started?.type !== "turn-started" || !client || !threadId) {
      throw new Error("The fake Codex turn did not start.");
    }
    const failedCall = { id: "image-call-failed", type: "image_generation_call" };
    const interruptedCall = { id: "image-call-interrupted", type: "image_generation_call" };
    client.emit("notification", notification("item/started", { threadId, turnId: started.turnId, item: failedCall }));
    client.emit(
      "notification",
      notification("item/completed", {
        threadId,
        turnId: started.turnId,
        item: {
          ...failedCall,
          status: "failed",
          failure: { message: "The image provider rejected the prompt." },
        },
      }),
    );
    client.emit(
      "notification",
      notification("item/started", {
        threadId,
        turnId: started.turnId,
        item: interruptedCall,
      }),
    );
    client.emit(
      "notification",
      notification("turn/completed", {
        threadId,
        turn: { id: started.turnId, status: "interrupted" },
      }),
    );

    await waitFor(async () => {
      const messages = (await service?.readConversation("chief"))?.messages ?? [];
      return (
        messages.some(
          (message) =>
            message.id === failedCall.id &&
            message.status === "failed" &&
            message.imageGeneration?.error === "The image provider rejected the prompt.",
        ) && messages.some((message) => message.id === interruptedCall.id && message.status === "interrupted")
      );
    });
    const messages = (await service.readConversation("chief")).messages;
    expect(messages.find((message) => message.id === failedCall.id)?.imageGeneration?.prompt).toBe(
      "Generate two atmospheric studies.",
    );
    expect(messages.find((message) => message.id === interruptedCall.id)?.imageGeneration?.error).toBe(
      "Image generation was interrupted.",
    );
  });

  it("marks an active image generation interrupted before a late Codex result arrives", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Generate a cinematic still." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const started = events.find((event) => event.type === "turn-started");
    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    if (started?.type !== "turn-started" || !client || !threadId) {
      throw new Error("The fake Codex turn did not start.");
    }
    const item = {
      id: "image-call-late-result",
      type: "image_generation_call",
      status: "in_progress",
      revised_prompt: "A cinematic still at blue hour",
    };
    client.emit("notification", notification("item/started", { threadId, turnId: started.turnId, item }));
    await waitFor(async () => {
      const message = (await service?.readConversation("chief"))?.messages.find(
        (candidate) => candidate.id === item.id,
      );
      return message?.status === "streaming";
    });

    await service.interrupt("chief", started.turnId);
    await waitFor(async () => {
      const message = (await service?.readConversation("chief"))?.messages.find(
        (candidate) => candidate.id === item.id,
      );
      return message?.status === "interrupted";
    });

    client.emit(
      "notification",
      notification("item/completed", {
        threadId,
        turnId: started.turnId,
        item: {
          ...item,
          status: "completed",
          result: Buffer.from("late-image").toString("base64"),
        },
      }),
    );
    client.emit(
      "notification",
      notification("turn/completed", {
        threadId,
        turn: { id: started.turnId, status: "interrupted" },
      }),
    );

    await waitFor(async () => {
      const message = (await service?.readConversation("chief"))?.messages.find(
        (candidate) => candidate.id === item.id,
      );
      return message?.status === "interrupted" && !message.attachments?.length;
    });
    const message = (await service.readConversation("chief")).messages.find((candidate) => candidate.id === item.id);
    expect(message?.imageGeneration?.error).toBe("Image generation was interrupted.");
  });

  it("waits for active queue drains before shutdown completes", async () => {
    process.env.OPENBOT_FAKE_TURN_START_RESPONSE_DELAY = "2000";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "Stop during startup" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "starting");
    await service.stop();

    expect(["failed", "interrupted"]).toContain(service.listQueue("chief").deliveries[0]?.status);
  });

  it("compacts a pressured agent context before draining its next queued message", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "DONE";
    process.env.OPENBOT_FAKE_CONTEXT_USAGE = "82000";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "First large task" });
    await service.sendMessage({ botId: "chief", text: "Run after compaction" });
    await waitFor(async () => {
      const messages = await protocolMessages();
      return messages.filter((message) => message.method === "turn/start").length === 2;
    });

    const lifecycle = (await protocolMessages())
      .filter((message) => ["turn/start", "thread/compact/start"].includes(String(message.method)))
      .map((message) => message.method);
    expect(lifecycle.slice(0, 3)).toEqual(["turn/start", "thread/compact/start", "turn/start"]);
    expect(lifecycle.filter((method) => method === "thread/compact/start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn-started")).toHaveLength(2);
  });

  it("does not compact context below the safety threshold", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "DONE";
    process.env.OPENBOT_FAKE_CONTEXT_USAGE = "79000";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Normal task" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "completed");

    expect((await protocolMessages()).some((message) => message.method === "thread/compact/start")).toBe(false);
  });

  it("continues queued work when context compaction is unavailable", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "DONE";
    process.env.OPENBOT_FAKE_CONTEXT_USAGE = "82000";
    process.env.OPENBOT_FAKE_COMPACTION_ERROR = "1";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "First task" });
    await service.sendMessage({ botId: "chief", text: "Must still run" });
    await waitFor(async () => {
      const messages = await protocolMessages();
      return messages.filter((message) => message.method === "turn/start").length === 2;
    });

    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "error", code: "context_compaction_failed" })]),
    );
  });

  it("fans out an idempotent agent tool message with referenced files", async () => {
    process.env.OPENBOT_FAKE_AGENT_TOOL = "1";
    const notePath = join(root, "generated-note.txt");
    const imagePath = join(root, "generated-image.png");
    await Promise.all([
      writeFile(notePath, "OPENBOT_SHARED_FILE_OK\n"),
      writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    ]);
    process.env.OPENBOT_FAKE_AGENT_TOOL_PATHS = JSON.stringify([notePath, imagePath]);
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await Promise.all([store.getOrCreate("sales-outbound"), store.getOrCreate("inbox-manager")]);
    await service.sendMessage({ botId: "chief", text: "Coordinate the team" });

    await waitFor(async () => {
      const messages = await protocolMessages();
      return messages.some((message) => message.id === "agent-tool-1" && message.result);
    });
    await waitFor(() => service?.listQueue("sales-outbound").deliveries.length === 1);
    await waitFor(() => service?.listQueue("inbox-manager").deliveries.length === 1);

    const sales = service.listQueue("sales-outbound").deliveries[0];
    const inbox = service.listQueue("inbox-manager").deliveries[0];
    expect(sales.messageId).toBe(inbox.messageId);
    expect(sales.sender).toEqual({ kind: "bot", botId: "chief" });
    expect(sales.text).toBe("Please prepare your reports.");
    expect(sales.attachments.map((item) => item.name)).toEqual(["generated-note.txt", "generated-image.png"]);
    const managedNote = await mailbox.resolveAttachment(sales.attachments[0]?.id ?? "");
    const managedImage = await mailbox.resolveAttachment(sales.attachments[1]?.id ?? "");
    expect(managedNote?.path).not.toBe(notePath);
    expect(managedImage?.path).not.toBe(imagePath);
    await expect(readFile(managedNote?.path ?? "", "utf8")).resolves.toBe("OPENBOT_SHARED_FILE_OK\n");

    const chiefMessages = (await service.readConversation("chief")).messages;
    expect(chiefMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exchange: expect.objectContaining({ direction: "outgoing" }) }),
      ]),
    );
    expect(chiefMessages.findIndex((message) => message.exchange?.direction === "outgoing")).toBeLessThan(
      chiefMessages.findIndex((message) => message.author === "assistant"),
    );
    await waitFor(async () =>
      (await service?.readConversation("sales-outbound"))?.messages.some(
        (message) => message.exchange?.direction === "incoming",
      ),
    );
    expect((await service.readConversation("sales-outbound")).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          senderBotId: "chief",
          exchange: expect.objectContaining({ direction: "incoming" }),
        }),
      ]),
    );

    const starts = (await protocolMessages()).filter((message) => message.method === "turn/start");
    const salesStart = starts.find((message) => getString(message.params, "cwd")?.endsWith("/sales-outbound"));
    const salesInput = inputRecords(salesStart?.params);
    expect(getString(salesInput[0], "text")).toContain(
      "After completing the request, send a concise result back to Chief",
    );
    expect(getString(salesInput[0], "text")).toContain(`replyToMessageId "${sales.messageId}"`);
    expect(salesInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "mention",
          name: "generated-note.txt",
          path: expect.stringContaining("generated-note.txt"),
        }),
        expect.objectContaining({
          type: "localImage",
          path: expect.stringContaining("generated-image.png"),
        }),
      ]),
    );
  });

  it("lists complete local profiles and updates a selected agent profile", async () => {
    process.env.OPENBOT_FAKE_AGENT_TOOL_CALLS = JSON.stringify([
      { tool: "list_agents", arguments: {} },
      {
        tool: "update_profile",
        arguments: {
          botId: "design",
          name: "Design Studio",
          title: "Product design",
          description: "Owns product interface and visual design.",
        },
      },
    ]);
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("design", "Designer", "Design");
    await service.sendMessage({ botId: "chief", text: "Update the design teammate." });

    await waitFor(async () => {
      const messages = await protocolMessages();
      return messages.some((message) => message.id === "agent-tool-configured-1" && message.result);
    });

    expect(await store.getOrCreate("design")).toMatchObject({
      name: "Design Studio",
      title: "Product design",
      description: "Owns product interface and visual design.",
    });
    const listResponse = (await protocolMessages()).find((message) => message.id === "agent-tool-configured-0");
    expect(JSON.stringify(listResponse?.result)).toContain('\\"title\\":\\"Design\\"');
    expect(JSON.stringify(listResponse?.result)).toContain('\\"description\\":\\"\\"');
  });

  it("sends a teammate request only to the selected profile match", async () => {
    process.env.OPENBOT_FAKE_AGENT_TOOL_CALLS = JSON.stringify([
      { tool: "list_agents", arguments: {} },
      {
        tool: "send_message",
        arguments: {
          recipientBotIds: ["design"],
          text: "Please review the interface proposal.",
        },
      },
    ]);
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("design", "Design Studio", "Product design");
    await store.updateBot({
      botId: "design",
      description: "Owns product interface and visual design.",
    });
    await store.getOrCreate("research", "Research", "Research partner");
    await service.sendMessage({ botId: "chief", text: "Ask the design bot." });

    await waitFor(() => service?.listQueue("design").deliveries.length === 1);
    expect(service.listQueue("research").deliveries).toHaveLength(0);
    expect(service.listQueue("design").deliveries[0]?.sender).toEqual({ kind: "bot", botId: "chief" });
  });

  it("reliably relays a completed teammate result back through a reply chain without loops", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "AUTO_WEATHER_RESULT";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await store.initialize();
    await mailbox.initialize();
    await store.getOrCreate("chief");
    await store.getOrCreate("sales-outbound");

    const rootMessage = await mailbox.enqueue({
      sender: { kind: "bot", botId: "chief" },
      recipientBotIds: ["sales-outbound"],
      text: "Check the weather.",
    });
    const clarification = await mailbox.enqueue({
      sender: { kind: "bot", botId: "sales-outbound" },
      recipientBotIds: ["chief"],
      text: "Which city?",
      replyToMessageId: rootMessage.messageId,
    });
    const location = await mailbox.enqueue({
      sender: { kind: "bot", botId: "chief" },
      recipientBotIds: ["sales-outbound"],
      text: "Kraków.",
      replyToMessageId: clarification.messageId,
    });

    await service.initialize();
    await waitFor(() =>
      service
        ?.listQueue("chief")
        .deliveries.some(
          (delivery) =>
            delivery.sender.kind === "bot" &&
            delivery.sender.botId === "sales-outbound" &&
            delivery.replyToMessageId === location.messageId,
        ),
    );
    await waitFor(() =>
      (service?.listQueue("chief").deliveries ?? []).every((delivery) => delivery.status === "completed"),
    );

    expect(await service.readConversation("chief")).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          author: "agent",
          senderBotId: "sales-outbound",
          text: "AUTO_WEATHER_RESULT",
          replyToMessageId: location.messageId,
        }),
      ]),
    });
    expect(service.listQueue("sales-outbound").deliveries).toHaveLength(2);
    expect(service.listQueue("chief").deliveries).toHaveLength(2);
  });

  it("reads the canonical SQLite conversation during an active stream", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "First turn" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");
    const firstTurnId = service.listQueue("chief").deliveries[0]?.turnId;
    if (!firstTurnId) throw new Error("First turn did not start.");
    await service.interrupt("chief", firstTurnId);
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "interrupted");
    await service.sendMessage({ botId: "chief", text: "New live turn" });
    await waitFor(() => service?.listQueue("chief").deliveries[1]?.status === "running");

    const snapshot = await service.readConversation("chief");
    expect(snapshot.activeTurnId).toBe(service.listQueue("chief").deliveries[1]?.turnId);
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Streaming", status: "streaming" })]),
    );
    expect((await protocolMessages()).filter((message) => message.method === "thread/read")).toHaveLength(0);
  });

  it("does not fail or replay a turn whose start response times out after lifecycle events", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "Finished despite the late response";
    process.env.OPENBOT_FAKE_TURN_START_RESPONSE_DELAY = "2000";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), null, 1000);
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "Run exactly once" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "completed");
    await waitFor(() => events.some((event) => event.type === "error" && event.code === "delivery_start_unconfirmed"));

    expect(service.listQueue("chief").deliveries[0]).toMatchObject({
      status: "completed",
      error: null,
    });
    expect((await protocolMessages()).filter((message) => message.method === "turn/start")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "delivery_start_unconfirmed" }));
  });

  it("resumes stored threads and does not replay an uncertain running delivery", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Remember this" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");
    const threadId = (await store.getOrCreate("chief")).threadId;
    await service.stop();

    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    expect(service.listQueue("chief").deliveries[0]?.status).toBe("interrupted");
    await service.sendMessage({ botId: "chief", text: "Continue" });
    await waitFor(async () => (await protocolMessages()).some((message) => message.method === "thread/resume"));
    const resume = (await protocolMessages()).find((message) => message.method === "thread/resume");
    expect(resume?.params).toMatchObject({
      dynamicTools: expect.arrayContaining([
        expect.objectContaining({ type: "namespace", name: "openbot_browser" }),
        expect.objectContaining({ type: "namespace", name: "openbot" }),
      ]),
    });
    expect((await store.getOrCreate("chief")).threadId).toBe(threadId);
  });

  it("does not persist unchanged provider history after repeated restarts", async () => {
    const clients: FakeAgentClient[] = [];
    const { store, mailbox } = stores();
    const createService = () =>
      new AgentService(store, mailbox, fakeBrowser(), null, 30_000, "codex", (provider) => {
        const client = new FakeAgentClient(provider);
        clients.push(client);
        return client;
      });
    service = createService();
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Remember this" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "completed");
    const before = await service.readConversation("chief");
    await service.stop();

    for (let restart = 0; restart < 2; restart += 1) {
      service = createService();
      await service.initialize();
      const client = clients.at(-1);
      await waitFor(() => client?.requests.some((request) => request.method === "thread/read"));
      await service.stop();
    }

    expect(
      store.database.connection
        .prepare("SELECT COUNT(*) AS count FROM orchestration_events WHERE event_type = 'provider-history.backfilled'")
        .get(),
    ).toMatchObject({ count: 0 });
    expect((await store.database.readConversation("chief", before.threadId)).revision).toBe(before.revision);
  });

  it("unarchives a stored Codex thread and resumes the queued delivery", async () => {
    process.env.OPENBOT_FAKE_ARCHIVED_THREAD = "1";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Remember this" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");
    await store.getOrCreate("chief");
    const externalThreadId = store.activeProviderSession("chief")?.externalSessionId;
    await service.stop();

    service = new AgentService(store, mailbox, fakeBrowser());
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Continue" });
    await waitFor(() => service?.listQueue("chief").deliveries[1]?.status === "running");

    const requests = await protocolMessages();
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "thread/unarchive",
          params: { threadId: externalThreadId },
        }),
      ]),
    );
    expect(
      requests.filter(
        (message) => message.method === "thread/resume" && getString(message.params, "threadId") === externalThreadId,
      ),
    ).toHaveLength(2);
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          message: expect.stringContaining("is archived"),
        }),
      ]),
    );
  });

  it("deletes idle bots and refuses to orphan active work", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    await store.getOrCreate("sales-outbound");
    await service.deleteBot("sales-outbound");
    expect(service.listBots().some((bot) => bot.id === "sales-outbound")).toBe(false);
    expect(
      store.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM orchestration_events
           WHERE payload_json LIKE '%sales-outbound%'`,
        )
        .get(),
    ).toMatchObject({ count: 0 });
    expect(
      store.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM orchestration_command_receipts
           WHERE command_id LIKE '%sales-outbound%'`,
        )
        .get(),
    ).toMatchObject({ count: 0 });

    await service.sendMessage({ botId: "chief", text: "Keep working" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");
    await expect(service.deleteBot("chief")).rejects.toThrow(
      "Stop the agent and cancel its queued messages before deleting it.",
    );
    expect(service.listBots().some((bot) => bot.id === "chief")).toBe(true);
  });
});

class FakeAgentClient extends EventEmitter implements AgentClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: RequestId; result: unknown }> = [];
  #threadCounter = 0;
  running = false;

  constructor(
    readonly provider: AgentProvider,
    readonly output = provider === "codex" ? "CODEX_DONE" : "CLAUDE_DONE",
    readonly autoComplete = true,
  ) {
    super();
  }

  start(): void {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>): Promise<T> {
    this.requests.push({ method, params: structuredClone(params) });
    let result: unknown;
    if (method === "initialize") result = {};
    if (method === "account/read") {
      result = {
        account: {
          type: this.provider === "codex" ? "chatgpt" : "claude",
          email: `${this.provider}@example.com`,
        },
        requiresOpenaiAuth: false,
      };
    }
    if (method === "account/rateLimits/read") {
      result = { rateLimits: null, rateLimitsByLimitId: null };
    }
    if (method === "model/list") {
      result = {
        data:
          this.provider === "codex"
            ? ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].map((model) => ({ model }))
            : ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"].map((model) => ({ model })),
      };
    }
    if (method === "plugin/list") result = { marketplaces: [] };
    if (method === "thread/start") {
      this.#threadCounter += 1;
      result = { thread: { id: `${this.provider}-session-${this.#threadCounter}` } };
    }
    if (method === "thread/resume") {
      result = { thread: { id: stringParam(params, "threadId") } };
    }
    if (method === "thread/read") {
      result = { thread: { id: stringParam(params, "threadId"), turns: [] } };
    }
    if (method === "thread/compact/start" || method === "turn/interrupt") result = {};
    if (method === "turn/steer") {
      result = { turnId: stringParam(params, "expectedTurnId") };
    }
    if (method === "turn/start") {
      const threadId = stringParam(params, "threadId");
      const turnId = randomUUID();
      const itemId = `${turnId}:assistant`;
      const text = this.output;
      setTimeout(() => {
        if (!this.running) return;
        this.emit("notification", notification("turn/started", { threadId, turn: { id: turnId } }));
        if (!this.autoComplete) return;
        this.emit(
          "notification",
          notification("item/started", {
            threadId,
            turnId,
            item: { id: itemId, type: "agentMessage", text: "" },
          }),
        );
        this.emit("notification", notification("item/agentMessage/delta", { threadId, turnId, itemId, delta: text }));
        this.emit(
          "notification",
          notification("item/completed", {
            threadId,
            turnId,
            item: { id: itemId, type: "agentMessage", text },
          }),
        );
        this.emit(
          "notification",
          notification("turn/completed", {
            threadId,
            turn: { id: turnId, status: "completed" },
          }),
        );
      }, 0);
      result = { turn: { id: turnId, status: "inProgress", items: [] } };
    }
    if (result === undefined) throw new Error(`Fake client does not implement ${method}.`);
    return decoder(result);
  }

  notify(): void {}

  respond(id: RequestId, result: unknown): void {
    this.responses.push({ id, result: structuredClone(result) });
  }

  respondError(_id: RequestId, _error: RpcError): void {}
}

function notification(method: string, params: unknown): AppServerNotification {
  return { method, params };
}

function stringParam(value: unknown, key: string): string {
  if (!isDynamicRecord(value)) throw new Error(`${key} is missing.`);
  const result = value[key];
  if (!isString(result)) throw new Error(`${key} is missing.`);
  return result;
}

function paramsRecord(value: unknown): DynamicRecord | null {
  return isDynamicRecord(value) ? value : null;
}

function firstInputText(value: unknown): string | null {
  const input = paramsRecord(value)?.input;
  if (!Array.isArray(input)) return null;
  return getString(input[0], "text");
}

function inputRecords(value: unknown): DynamicRecord[] {
  const input = paramsRecord(value)?.input;
  return Array.isArray(input) ? input.filter(isDynamicRecord) : [];
}

function stores(): { store: BotStore; mailbox: MailboxStore } {
  const store = new BotStore(join(root, "user-data"), join(root, "home"));
  return { store, mailbox: new MailboxStore(join(root, "user-data"), store.sharedRoot) };
}

function fakeBrowser() {
  return {
    onChanged: (_listener: (tabs: BrowserTab[], activeTabId: string | null) => void) => () => undefined,
    onControlChanged: (_listener: (state: BrowserControlState) => void) => () => undefined,
    clearControls: () => undefined,
    endControl: () => undefined,
    handleDynamicTool: async (_params: DynamicToolCallParams) => ({ success: true, contentItems: [] }),
  };
}

async function protocolMessages(): Promise<DynamicRecord[]> {
  try {
    return (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(isDynamicRecord);
  } catch {
    return [];
  }
}

async function waitFor(check: () => boolean | undefined | Promise<boolean | undefined>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the fake App Server.");
}

async function createFakeCodex(directory: string): Promise<string> {
  const executable = join(directory, "codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.144.1\\n");
  process.exit(0);
}
const log = process.env.OPENBOT_FAKE_CODEX_LOG;
let buffer = "";
let threadCounter = 0;
let turnCounter = 0;
const turns = new Map();
let archivedThread = process.env.OPENBOT_FAKE_ARCHIVED_THREAD === "1";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      fs.appendFileSync(log, JSON.stringify(message) + "\\n");
      if (message.method === "initialize") write({ id: message.id, result: {} });
      if (message.method === "account/read") write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
      if (message.method === "account/rateLimits/read") write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1786563600 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1787040000 } }, rateLimitsByLimitId: null } });
      if (message.method === "model/list") write({ id: message.id, result: { data: [
        { model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
        { model: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
        { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] }
      ] } });
      if (message.method === "plugin/list") write({ id: message.id, result: { marketplaces: [{ plugins: [{ id: "computer-use@openai-bundled", name: "computer-use", installed: true, enabled: true }] }] } });
      if (message.method === "thread/start") {
        const threadId = "thread-" + (++threadCounter);
        write({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
      }
      if (message.method === "thread/resume") {
        if (archivedThread) write({ id: message.id, error: { code: -32600, message: "session " + message.params.threadId + " is archived. Run codex unarchive " + message.params.threadId + " to unarchive it first." } });
        else write({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
      }
      if (message.method === "thread/unarchive") {
        archivedThread = false;
        write({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
      }
      if (message.method === "thread/read") {
        const capturedTurns = JSON.parse(JSON.stringify([...turns.values()]));
        const respond = () => write({ id: message.id, result: { thread: { id: message.params.threadId, turns: capturedTurns } } });
        const delay = Number(process.env.OPENBOT_FAKE_THREAD_READ_DELAY || 0);
        if (delay > 0) setTimeout(respond, delay);
        else respond();
      }
      if (message.method === "turn/start") {
        const turnId = "turn-" + (++turnCounter);
        turns.set(turnId, { id: turnId, status: "inProgress", items: [] });
        const respondToStart = () => write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        const startResponseDelay = Number(process.env.OPENBOT_FAKE_TURN_START_RESPONSE_DELAY || 0);
        if (startResponseDelay > 0) setTimeout(respondToStart, startResponseDelay);
        else respondToStart();
        write({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId } } });
        if (process.env.OPENBOT_FAKE_WARNING) {
          write({ method: "warning", params: { threadId: message.params.threadId, message: process.env.OPENBOT_FAKE_WARNING } });
        }
        if (process.env.OPENBOT_FAKE_CONTEXT_USAGE) {
          const totalTokens = Number(process.env.OPENBOT_FAKE_CONTEXT_USAGE);
          write({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId, tokenUsage: { total: { totalTokens }, last: { totalTokens }, modelContextWindow: 100000 } } });
        }
        write({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, itemId: "message-" + turnId, delta: "Streaming" } });
        if (process.env.OPENBOT_FAKE_AGENT_TOOL === "1" && turnCounter === 1) {
          setTimeout(() => write({ id: "agent-tool-1", method: "item/tool/call", params: { threadId: message.params.threadId, turnId, callId: "call-1", namespace: "openbot", tool: "send_message", arguments: { recipientBotIds: ["sales-outbound", "inbox-manager"], text: "Please prepare your reports.", paths: JSON.parse(process.env.OPENBOT_FAKE_AGENT_TOOL_PATHS || "[]") } } }), 30);
        }
        if (process.env.OPENBOT_FAKE_AGENT_TOOL_CALLS && turnCounter === 1) {
          const calls = JSON.parse(process.env.OPENBOT_FAKE_AGENT_TOOL_CALLS);
          calls.forEach((call, index) => setTimeout(() => write({
            id: "agent-tool-configured-" + index,
            method: "item/tool/call",
            params: {
              threadId: message.params.threadId,
              turnId,
              callId: "configured-call-" + index,
              namespace: "openbot",
              tool: call.tool,
              arguments: call.arguments,
            },
          }), 30 + index * 30));
        }
        if (process.env.OPENBOT_FAKE_AUTO_COMPLETE) {
          setTimeout(() => {
            const text = process.env.OPENBOT_FAKE_AUTO_COMPLETE;
            const item = { type: "agentMessage", id: "message-" + turnId, text, phase: "final_answer" };
            const turn = turns.get(turnId);
            if (turn) {
              turn.status = "completed";
              turn.items = [item];
            }
            write({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
            write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
          }, 20);
        }
      }
      if (message.method === "thread/compact/start") {
        if (process.env.OPENBOT_FAKE_COMPACTION_ERROR === "1") {
          write({ id: message.id, error: { code: -32601, message: "Compaction unavailable" } });
          newline = buffer.indexOf("\\n");
          continue;
        }
        const turnId = "compact-turn-" + (++turnCounter);
        const item = { type: "contextCompaction", id: "compact-item-" + turnId };
        write({ id: message.id, result: {} });
        write({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId } } });
        write({ method: "item/started", params: { threadId: message.params.threadId, turnId, item } });
        write({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
      }
      if (message.method === "turn/interrupt") {
        write({ id: message.id, result: {} });
        const turn = turns.get(message.params.turnId);
        if (turn) turn.status = "interrupted";
        write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted" } } });
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return executable;
}

async function createFakeClaude(directory: string): Promise<string> {
  const executable = join(directory, "claude");
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.231 (Claude Code)'
elif [ "$1" = "auth" ]; then
  printf '%s' '{"loggedIn":true,"email":"claude@example.com","subscriptionType":"max"}'
fi
`,
  );
  await chmod(executable, 0o755);
  return executable;
}
