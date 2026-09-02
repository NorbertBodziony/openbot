// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import { serializeChatTagReference } from "@openbot/contracts/chat-tag-references";
import type { AgentEvent } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "./agent-client";
import { AgentMemoryStore } from "./agent-memory-store";
import { AgentRoutineStore } from "./agent-routine-store";
import { AgentService } from "./agent-service";
import {
  CREATE_BOT_INPUT,
  createFakeClaude,
  createFakeCodex,
  createFakeGrok,
  createPendingFakeClaude,
  EMPTY_LAYOUT,
  FakeAgentClient,
  fakeBrowser,
  firstInputText,
  paramsRecord,
  protocolMessages,
  readTextOrEmpty,
  stores,
  waitFor,
} from "./agent-service-test-harness";
import type { DynamicToolCallParams } from "./protocol";

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

describe.sequential("AgentService: providers", () => {
  it("checks providers concurrently and publishes each completed row", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    process.env.OPENBOT_GROK_PATH = await createFakeGrok(root);
    const { store, mailbox } = stores(root);
    const delays: Record<AgentProvider, number> = { codex: 60, claude: 5, grok: 30 };
    const availableOrder: AgentProvider[] = [];
    const seen = new Set<AgentProvider>();
    const accountReads = new Set<AgentProvider>();
    let releaseAccountReads: (() => void) | undefined;
    const allAccountReadsStarted = new Promise<void>((resolve) => {
      releaseAccountReads = resolve;
    });
    const waitForConcurrentAccountReads = async (method: string, provider: AgentProvider) => {
      if (method !== "account/read") return;
      accountReads.add(provider);
      if (accountReads.size === 3) releaseAccountReads?.();
      await allAccountReadsStarted;
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) =>
        new FakeAgentClient(
          provider,
          "DONE",
          true,
          true,
          { "account/read": delays[provider] },
          waitForConcurrentAccountReads,
        ),
    );
    service.on("event", (event) => {
      if (event.type !== "status") return;
      for (const provider of event.status.providers ?? []) {
        if (provider.state !== "available" || seen.has(provider.id)) continue;
        seen.add(provider.id);
        availableOrder.push(provider.id);
      }
    });

    await Promise.race([
      service.initialize(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Provider account checks did not start concurrently.")), 3_000),
      ),
    ]);

    expect(availableOrder).toEqual(["claude", "grok", "codex"]);

    // The fake CLI advertises models outside the curated set, and
    // CURATED_CODEX_MODEL_IDS (agent-service.ts:3296) has to drop them.
    const codexModelIds = service
      .listModels()
      .filter((model) => model.provider === "codex")
      .map((model) => model.id);
    for (const uncurated of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]) {
      expect(codexModelIds).not.toContain(uncurated);
    }
    expect(codexModelIds).toContain("gpt-5.6-luna");
  });

  it("duplicates persistent agent data without conversation or routine-run history", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    const source = await store.getOrCreate("chief", "Research", "Research lead");
    await store.updateBot({
      botId: source.id,
      description: "Finds primary sources.",
      notifications: false,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    await writeFile(join(source.workspacePath, "research.md"), "source workspace\n");
    service.createMemory({ botId: source.id, text: "Use official documents." });
    new AgentMemoryStore(store.database).saveAutomatic({
      botId: source.id,
      text: "The user prefers short briefs.",
      sourceTurnId: "turn-source-memory",
    });
    const activeRoutine = service.createRoutine({
      botId: source.id,
      name: "Morning brief",
      instruction: "Prepare the morning brief.",
      active: true,
      timezone: "Europe/Warsaw",
      schedule: { kind: "daily", time: "09:00" },
    });
    const inactiveRoutine = service.createRoutine({
      botId: source.id,
      name: "Weekly review",
      instruction: "Review the week.",
      active: false,
      timezone: "UTC",
      schedule: { kind: "weekly", weekday: 1, time: "10:30" },
    });
    const routineStore = new AgentRoutineStore(store.database);
    const oldRun = routineStore.createRun(
      activeRoutine,
      activeRoutine.trigger.id,
      "scheduled",
      "2026-08-31T07:00:00.000Z",
    );
    routineStore.updateRunStatus(oldRun.id, "succeeded");
    service.setMarketplaceSource(source.id, {
      agentId: "market-research",
      versionId: "market-research-v2",
      version: 2,
      skillIds: ["primary-sources"],
      routineIds: [activeRoutine.id],
    });
    const duplicateStartedAt = Date.now();
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));

    const duplicate = await service.duplicateBot(source.id);

    expect(service.listBots().some((bot) => bot.id === duplicate.id)).toBe(false);
    await expect(service.sendMessage({ botId: duplicate.id, text: "Do not start yet." })).rejects.toThrow(
      `Unknown bot: ${duplicate.id}`,
    );
    await expect(service.updateBot({ botId: duplicate.id, title: "Hidden copy" })).rejects.toThrow(
      `Unknown bot: ${duplicate.id}`,
    );
    expect(service.listQueue(duplicate.id).deliveries).toEqual([]);
    expect(events).toEqual([]);
    await service.commitBotDuplication(duplicate.id, EMPTY_LAYOUT);
    expect(service.listBots().some((bot) => bot.id === duplicate.id)).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "bots-changed" }),
        expect.objectContaining({ type: "memories-changed", botId: duplicate.id }),
        expect.objectContaining({ type: "routines-changed", botId: duplicate.id }),
      ]),
    );

    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate).toMatchObject({
      name: "Research copy",
      title: "Research lead",
      description: "Finds primary sources.",
      notifications: false,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      threadId: null,
      preview: "No messages yet",
    });
    expect((await service.readConversation(duplicate.id)).messages).toEqual([]);
    await expect(readFile(join(duplicate.workspacePath, "research.md"), "utf8")).resolves.toBe("source workspace\n");

    const sourceMemories = service.listMemories(source.id);
    const duplicateMemories = service.listMemories(duplicate.id);
    expect(
      duplicateMemories
        .map(({ text, origin, sourceTurnId }) => ({ text, origin, sourceTurnId }))
        .sort((left, right) => left.text.localeCompare(right.text)),
    ).toEqual(
      sourceMemories
        .map(({ text, origin }) => ({ text, origin, sourceTurnId: null }))
        .sort((left, right) => left.text.localeCompare(right.text)),
    );
    expect(new Set(duplicateMemories.map((memory) => memory.id))).not.toEqual(
      new Set(sourceMemories.map((memory) => memory.id)),
    );

    const sourceRoutines = service.listRoutines(source.id);
    const duplicateRoutines = service.listRoutines(duplicate.id);
    expect(
      duplicateRoutines
        .map(({ name, instruction, active, timezone, trigger }) => ({
          name,
          instruction,
          active,
          timezone,
          schedule: trigger.schedule,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    ).toEqual(
      sourceRoutines
        .map(({ name, instruction, active, timezone, trigger }) => ({
          name,
          instruction,
          active,
          timezone,
          schedule: trigger.schedule,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    );
    expect(duplicateRoutines.every((routine) => Date.parse(routine.trigger.nextRunAt) >= duplicateStartedAt)).toBe(
      true,
    );
    expect(duplicateRoutines.map((routine) => routine.id)).not.toEqual(sourceRoutines.map((routine) => routine.id));
    for (const routine of duplicateRoutines) {
      expect(service.listRoutineRuns({ botId: duplicate.id, routineId: routine.id, limit: 10 })).toEqual([]);
    }
    expect(duplicate.marketplaceSource).toMatchObject({
      agentId: "market-research",
      skillIds: ["primary-sources"],
      routineIds: [duplicateRoutines.find((routine) => routine.name === activeRoutine.name)?.id],
    });

    await writeFile(join(duplicate.workspacePath, "research.md"), "duplicate workspace\n");
    await service.updateMemory({
      botId: duplicate.id,
      memoryId: duplicateMemories[0]?.id ?? "missing",
      text: "Changed only in the duplicate.",
    });
    const copiedActiveRoutine = duplicateRoutines.find((routine) => routine.name === activeRoutine.name);
    if (!copiedActiveRoutine) throw new Error("The duplicated active routine is missing.");
    service.updateRoutine({ botId: duplicate.id, routineId: copiedActiveRoutine.id, active: false });

    await expect(readFile(join(source.workspacePath, "research.md"), "utf8")).resolves.toBe("source workspace\n");
    expect(service.listMemories(source.id).some((memory) => memory.text === "Changed only in the duplicate.")).toBe(
      false,
    );
    expect(service.listRoutines(source.id).find((routine) => routine.id === activeRoutine.id)?.active).toBe(true);
    expect(service.listRoutines(source.id).find((routine) => routine.id === inactiveRoutine.id)?.active).toBe(false);
  });

  it("blocks duplication while the source agent has active work", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("chief");
    await service.sendMessage({ botId: "chief", text: "Keep working.", attachmentDraftIds: [] });

    await expect(service.duplicateBot("chief")).rejects.toThrow("finish and clear its queue");
    expect(store.list().map((bot) => bot.id)).toEqual(["chief"]);
  });

  it("creates a bounded runtime snapshot for reconnecting clients", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("chief");

    expect(service.getRuntimeSnapshot()).toMatchObject({
      bots: [expect.objectContaining({ id: "chief" })],
      activeTurns: [],
      work: [],
      attentionComplete: true,
      pendingPrompts: [],
      pendingApprovals: [],
      pendingBrowserTakeovers: [],
      failedTurns: [],
    });
    expect(service.getRuntimeSnapshot().bots[0]).not.toHaveProperty("workspacePath");
    expect(service.getRuntimeSnapshot().bots[0]).not.toHaveProperty("description");
  });

  it("resolves only regular files inside the shared directory", async () => {
    const { store, mailbox } = stores(root);
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

  it("opens a historical routine message that only exists in the mailbox", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("chief");
    await store.ensureThreadId("chief");
    const receipt = await mailbox.enqueue({
      sender: {
        kind: "routine",
        routineId: "routine-1",
        runId: "run-1",
        routineName: "Morning brief",
        scheduledFor: "2026-08-25T07:00:00.000Z",
      },
      recipientBotIds: ["chief"],
      text: "Prepare the morning brief.",
      idempotencyKey: "test:routine-history:run-1",
    });
    const messageId = receipt.deliveries[0]?.id;
    if (!messageId) throw new Error("The routine delivery was not created.");

    const page = await service.readConversationPageFor("chief", "member-1", { type: "around", messageId }, 50);

    expect(page.messages).toContainEqual(
      expect.objectContaining({
        id: messageId,
        source: "routine",
        routine: expect.objectContaining({ routineId: "routine-1", runId: "run-1" }),
      }),
    );
  });

  it("resolves only regular files inside the selected agent workspace", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    const bot = await store.createBot(CREATE_BOT_INPUT);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
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

  it("expands agent and skill tags before sending text to the agent", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    await store.getOrCreate("research", "Research Lead", "Research partner");

    await service.sendMessage({
      botId: "chief",
      text: `Ask ${serializeChatTagReference("agent", "Old Research", "research")} to use ${serializeChatTagReference("skill", "Release Notes", "skill-1")}.`,
    });
    await waitFor(() => Boolean(clients.get("codex")?.requests.some((request) => request.method === "turn/start")));

    const turn = clients.get("codex")?.requests.find((request) => request.method === "turn/start");
    expect(firstInputText(turn?.params)).toContain("Ask @Research Lead to use Release Notes (skill).");
    expect(firstInputText(turn?.params)).not.toContain("Old Research");
  });

  it("creates independent full-access threads with browser and OpenBot tools", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
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
        { id: "claude", state: "error", version: null },
        { id: "grok", state: "not-installed", version: null },
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
    await waitFor(
      async () => (await protocolMessages(logPath)).filter((item) => item.method === "turn/start").length === 2,
    );

    const requests = await protocolMessages(logPath);
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
      expect(params.developerInstructions).toContain("For every browser task");
      expect(params.developerInstructions).toContain("Use the installed Computer Use plugin only");
      expect(params.developerInstructions).toContain("When you use openbot_browser");
      expect(params.developerInstructions).toContain("openbot.create_routine");
      expect(params.developerInstructions).toContain("Never use ChatGPT Sites");
      expect(params.developerInstructions).toContain("openbot.attach_files_to_response");
      expect(params.developerInstructions).toContain("sadness, disappointment, frustration, loneliness");
      expect(params.developerInstructions).toContain("An emoji written inside your answer does not count");
      expect(params.developerInstructions).toContain("Omit botId to target yourself");
      expect(params.dynamicTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "namespace", name: "openbot_browser" }),
          expect.objectContaining({
            type: "namespace",
            name: "openbot",
            tools: expect.arrayContaining([
              expect.objectContaining({ name: "attach_files_to_response" }),
              expect.objectContaining({ name: "ask_user" }),
              expect.objectContaining({ name: "list_agents" }),
              expect.objectContaining({ name: "update_profile" }),
              expect.objectContaining({ name: "list_routines" }),
              expect.objectContaining({ name: "create_routine" }),
              expect.objectContaining({ name: "update_routine" }),
              expect.objectContaining({ name: "delete_routine" }),
              expect.objectContaining({ name: "test_routine" }),
              expect.objectContaining({ name: "react_to_user_message" }),
            ]),
          }),
        ]),
      );
      const browserTools = (Array.isArray(params.dynamicTools) ? params.dynamicTools : [])
        .filter(isDynamicRecord)
        .find((tool) => tool.type === "namespace" && tool.name === "openbot_browser");
      expect(browserTools).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: "request_takeover" })]),
      });
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

  it("connects ChatGPT through the Codex App Server and promotes the authenticated client", async () => {
    const { store, mailbox } = stores(root);
    const codexClients: FakeAgentClient[] = [];
    const openExternal = vi.fn(async () => undefined);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(
        provider,
        provider === "codex" ? "CODEX_DONE" : "CLAUDE_DONE",
        true,
        provider !== "codex",
      );
      if (provider === "codex") codexClients.push(client);
      return client;
    });
    await service.initialize();

    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "codex", state: "sign-in-required" }),
    );
    const connecting = await service.connectChatGPT(openExternal);

    expect(connecting.providers).toContainEqual(
      expect.objectContaining({
        id: "codex",
        state: "sign-in-required",
        connectionState: "connecting",
        version: "0.144.1",
      }),
    );
    expect(openExternal).toHaveBeenCalledWith("https://auth.openai.test/connect");
    expect(codexClients).toHaveLength(2);
    expect(codexClients[1]?.requests).toContainEqual({
      method: "account/login/start",
      params: {
        type: "chatgpt",
        appBrand: "chatgpt",
        codexStreamlinedLogin: true,
        useHostedLoginSuccessPage: true,
      },
    });

    await service.connectChatGPT(openExternal);
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(codexClients).toHaveLength(3);
    expect(codexClients[1]?.requests).toContainEqual({
      method: "account/login/cancel",
      params: { loginId: "login-1" },
    });
    expect(codexClients[1]?.running).toBe(false);
    codexClients[1]?.completeLogin(true);
    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "codex", connectionState: "connecting" }),
    );
    codexClients[2]?.completeLogin(true);
    await waitFor(
      () => service?.getStatus().providers?.find((provider) => provider.id === "codex")?.state === "available",
    );

    expect(service.getStatus().phase).toBe("ready");
    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "codex", state: "available", email: "codex@example.com" }),
    );
  });

  it("connects Claude through the bundled CLI login command", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    const { store, mailbox } = stores(root);
    let claudeClients = 0;
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "claude", (provider) => {
      const authenticated = provider === "claude" ? claudeClients > 0 : true;
      if (provider === "claude") claudeClients += 1;
      return new FakeAgentClient(provider, "DONE", true, authenticated);
    });
    await service.initialize();

    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "claude", state: "sign-in-required" }),
    );

    const connecting = await service.connectClaude();

    expect(connecting.providers).toContainEqual(
      expect.objectContaining({ id: "claude", state: "sign-in-required", connectionState: "connecting" }),
    );
    await waitFor(() => claudeClients === 2);
    await waitFor(
      () => service?.getStatus().providers?.find((provider) => provider.id === "claude")?.state === "available",
    );
    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "claude", state: "available", email: "claude@example.com" }),
    );
  });

  it("restores the connect action when the login page cannot open", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => new FakeAgentClient(provider, "DONE", true, provider !== "codex"),
    );
    await service.initialize();

    await expect(service.connectChatGPT(async () => Promise.reject(new Error("browser failed")))).rejects.toThrow(
      "could not open",
    );
    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "codex", state: "sign-in-required" }),
    );
  });

  it("cancels a ChatGPT login that does not complete", async () => {
    const { store, mailbox } = stores(root);
    const codexClients: FakeAgentClient[] = [];
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "DONE", true, provider !== "codex");
      if (provider === "codex") codexClients.push(client);
      return client;
    });
    await service.initialize();
    vi.useFakeTimers();
    await service.connectChatGPT(async () => undefined);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(codexClients[1]?.requests).toContainEqual({
      method: "account/login/cancel",
      params: { loginId: "login-1" },
    });
    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({
        id: "codex",
        state: "sign-in-required",
        message: expect.stringContaining("timed out"),
      }),
    );
  });

  it("runs provider logins independently and Refresh cancels both generations", async () => {
    const claudeLoginLog = join(root, "claude-login.log");
    process.env.OPENBOT_FAKE_CLAUDE_LOGIN_LOG = claudeLoginLog;
    process.env.OPENBOT_CLAUDE_PATH = await createPendingFakeClaude(root);
    const { store, mailbox } = stores(root);
    const codexClients: FakeAgentClient[] = [];
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "DONE", true, false);
      if (provider === "codex") codexClients.push(client);
      return client;
    });
    await service.initialize();

    await Promise.all([service.connectChatGPT(async () => undefined), service.connectClaude()]);
    expect(service.getStatus().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex", connectionState: "connecting" }),
        expect.objectContaining({ id: "claude", connectionState: "connecting" }),
      ]),
    );
    await waitFor(async () => (await readTextOrEmpty(claudeLoginLog)).includes("started"));

    await service.connectClaude();
    await waitFor(async () => {
      const log = await readTextOrEmpty(claudeLoginLog);
      return log.match(/^started$/gmu)?.length === 2 && log.includes("stopped");
    });
    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "claude", connectionState: "connecting" }),
    );

    await service.refreshProviders();

    expect(codexClients[1]?.requests).toContainEqual({
      method: "account/login/cancel",
      params: { loginId: "login-1" },
    });
    expect(codexClients[1]?.running).toBe(false);
    await waitFor(async () => (await readTextOrEmpty(claudeLoginLog)).match(/^stopped$/gmu)?.length === 2);
    expect(service.getStatus().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex", state: "sign-in-required" }),
        expect.objectContaining({ id: "claude", state: "sign-in-required" }),
      ]),
    );
    expect(service.getStatus().providers?.some((provider) => provider.connectionState === "connecting")).toBe(false);

    codexClients[1]?.completeLogin(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "codex", state: "sign-in-required" }),
    );
  });

  it("keeps the active ChatGPT client until reconnect succeeds", async () => {
    const { store, mailbox } = stores(root);
    const codexClients: FakeAgentClient[] = [];
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "DONE", true, provider !== "codex" || codexClients.length === 0);
      if (provider === "codex") codexClients.push(client);
      return client;
    });
    await service.initialize();
    const activeClient = codexClients[0];

    await service.connectChatGPT(async () => undefined);
    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "codex", state: "available", connectionState: "connecting" }),
    );
    codexClients[1]?.completeLogin(false);
    await waitFor(() => !service?.getStatus().providers?.find((provider) => provider.id === "codex")?.connectionState);
    expect(activeClient?.running).toBe(true);
    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "codex", state: "available", message: expect.stringContaining("not completed") }),
    );

    await service.connectChatGPT(async () => undefined);
    codexClients[2]?.completeLogin(true);
    await waitFor(
      () =>
        service?.getStatus().providers?.find((provider) => provider.id === "codex")?.state === "available" &&
        !service?.getStatus().providers?.find((provider) => provider.id === "codex")?.connectionState,
    );
    expect(activeClient?.running).toBe(false);
    expect(codexClients[2]?.running).toBe(true);
  });

  it("maps provider browser tool calls to the stable OpenBot thread", async () => {
    const calls: DynamicToolCallParams[] = [];
    const browser = fakeBrowser();
    browser.handleDynamicTool = async (params) => {
      calls.push(params);
      return { success: true, contentItems: [] };
    };
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, browser, 30_000, "codex", (provider) => {
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
    expect(calls[0]).toMatchObject({ threadId: openbotThreadId, ownerBotId: "chief" });
  });

  it("serializes duplication until the previous copy is committed", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("chief");
    await store.getOrCreate("research");
    const first = await service.duplicateBot("chief");
    let secondResolved = false;
    const secondRequest = service.duplicateBot("research").then((duplicate) => {
      secondResolved = true;
      return duplicate;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(secondResolved).toBe(false);
    await service.commitBotDuplication(first.id, EMPTY_LAYOUT);
    const second = await secondRequest;
    await service.commitBotDuplication(second.id, EMPTY_LAYOUT);
    expect(service.listBots().map((bot) => bot.id)).toEqual(
      expect.arrayContaining(["chief", "research", first.id, second.id]),
    );
  });

  it("removes copied data when the source changes during duplication", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("chief");
    const duplicateInStore = store.duplicateBot.bind(store);
    vi.spyOn(store, "duplicateBot").mockImplementationOnce(async (botId) => {
      const duplicate = await duplicateInStore(botId);
      service?.createMemory({ botId, text: "Changed during duplication." });
      return duplicate;
    });

    await expect(service.duplicateBot("chief")).rejects.toThrow("changed while it was being duplicated");

    expect(store.list().map((bot) => bot.id)).toEqual(["chief"]);
    expect(service.listMemories("chief")).toEqual([expect.objectContaining({ text: "Changed during duplication." })]);
  });
});
