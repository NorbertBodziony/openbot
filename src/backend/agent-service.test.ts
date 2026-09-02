// @vitest-environment node

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import { serializeChatTagReference } from "@openbot/contracts/chat-tag-references";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  AGENT_RUNTIME_QUESTION_DESCRIPTION_LIMIT,
  AGENT_RUNTIME_TEXT_LIMIT,
  type AgentEvent,
  type BrowserControlState,
  type BrowserTab,
  hostedSiteConversationEvent,
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
  isAgentEvent,
  routineConversationEvent,
  routineRunConversationEvent,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentClient, AgentProvider } from "./agent-client";
import { AgentMemoryStore } from "./agent-memory-store";
import { AgentRoutineStore } from "./agent-routine-store";
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
const originalGrokPath = process.env.OPENBOT_GROK_PATH;
const CREATE_BOT_INPUT = {
  name: "Planning Bot",
  description: "Builds clear plans for everyday tasks.",
  avatarSeed: "setup:planning",
  avatarHue: 215,
  initialMessage: "Help me make a practical plan.",
} as const;
const EMPTY_LAYOUT = {
  revision: 0,
  sections: [],
  order: ["people", "unassigned"],
  agentAssignments: {},
  agentOrder: [],
};

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

describe.sequential("AgentService", () => {
  it("checks providers concurrently and publishes each completed row", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    process.env.OPENBOT_GROK_PATH = await createFakeGrok(root);
    const { store, mailbox } = stores();
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
  });

  it("only exposes the curated Codex models from the CLI catalog", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    expect(
      service
        .listModels()
        .filter((model) => model.provider === "codex")
        .map((model) => model.id),
    ).toEqual(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
  });

  it("duplicates persistent agent data without conversation or routine-run history", async () => {
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("chief");
    await service.sendMessage({ botId: "chief", text: "Keep working.", attachmentDraftIds: [] });

    await expect(service.duplicateBot("chief")).rejects.toThrow("finish and clear its queue");
    expect(store.list().map((bot) => bot.id)).toEqual(["chief"]);
  });

  it("serializes duplication until the previous copy is committed", async () => {
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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

  it("creates a bounded runtime snapshot for reconnecting clients", async () => {
    const { store, mailbox } = stores();
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

  it("opens a historical routine message that only exists in the mailbox", async () => {
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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

  it("derives live progress from the provider-neutral turn and tool lifecycle", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Check the latest result" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const started = events.find((event) => event.type === "turn-started");
    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    if (started?.type !== "turn-started" || !client || !threadId) {
      throw new Error("The fake provider turn did not start.");
    }
    const turnId = started.turnId;

    const progress = () =>
      service
        ?.readConversation("chief")
        .then((conversation) => conversation.messages.find((message) => message.id === `activity:${turnId}`)?.text);
    await expect(progress()).resolves.toBe("Reviewing the request and planning the next step…");

    client.emit(
      "notification",
      notification("item/started", {
        threadId,
        turnId,
        item: { id: "tool-1", type: "toolCall", name: "web_search", status: "in_progress" },
      }),
    );
    await waitFor(async () => (await progress()) === "Searching for current information…");

    client.emit(
      "notification",
      notification("item/completed", {
        threadId,
        turnId,
        item: { id: "tool-1", type: "toolCall", name: "web_search", status: "completed" },
      }),
    );
    await waitFor(async () => (await progress()) === "Reviewing the sources and information I found…");

    client.emit(
      "notification",
      notification("item/completed", {
        threadId,
        turnId,
        item: { id: "answer-1", type: "agentMessage", text: "Here is the result." },
      }),
    );
    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } }),
    );
    await waitFor(async () =>
      ((await service?.readConversation("chief"))?.messages ?? []).every(
        (message) => message.id !== `activity:${turnId}`,
      ),
    );
  });

  it("connects ChatGPT through the Codex App Server and promotes the authenticated client", async () => {
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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

  it("connects Grok through the bundled CLI login command", async () => {
    process.env.OPENBOT_GROK_PATH = await createFakeGrok(root);
    const { store, mailbox } = stores();
    let grokClients = 0;
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "grok", (provider) => {
      const authenticated = provider === "grok" ? grokClients > 0 : true;
      if (provider === "grok") grokClients += 1;
      return new FakeAgentClient(provider, "DONE", true, authenticated);
    });
    await service.initialize();

    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "grok", state: "sign-in-required" }),
    );

    const connecting = await service.connectGrok();

    expect(connecting.providers).toContainEqual(
      expect.objectContaining({ id: "grok", state: "sign-in-required", connectionState: "connecting" }),
    );
    await waitFor(() => grokClients === 2);
    await waitFor(
      () => service?.getStatus().providers?.find((provider) => provider.id === "grok")?.state === "available",
    );
    expect(service.getStatus().providers).toContainEqual(
      expect.objectContaining({ id: "grok", state: "available", email: "grok@example.com" }),
    );
  });

  it("restores the connect action when the login page cannot open", async () => {
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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

  it("surfaces Codex approvals without auto-accepting and maps one-shot decisions", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
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

  it("requires user approval before an agent mutates hosted sites", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    const hostedSite = {
      id: "site-1",
      hostname: "approved-public-site-for-students-k7m2q9tzab.openbot.site",
      url: "http://approved-public-site-for-students-k7m2q9tzab.openbot.localhost:3100/",
      title: "Approved public site",
      description: "A public test site.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 20,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSites = {
      list: vi.fn(async () => [hostedSite]),
      publish: vi.fn(async () => hostedSite),
      replace: vi.fn(async () => hostedSite),
      delete: vi.fn(async () => undefined),
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => {
        const client = new FakeAgentClient(provider, "", false);
        clients.set(provider, client);
        return client;
      },
      undefined,
      null,
      null,
      async () => undefined,
      hostedSites,
    );
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    await service.sendMessage({ botId: bot.id, text: "Publish my site." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(bot.id)?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The hosted site approval turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "invalid-site-approval",
      params: {
        threadId,
        turnId,
        callId: "invalid-site-approval",
        namespace: "openbot",
        tool: "publish_site",
        arguments: { title: "Hidden source", description: "This request has no source path." },
      },
    });
    await waitFor(() => client.errors.some((response) => response.id === "invalid-site-approval"));
    expect(service.getRuntimeSnapshot().pendingApprovals).toHaveLength(0);

    client.emit("request", {
      method: "item/tool/call",
      id: "publish-site-approval",
      params: {
        threadId,
        turnId,
        callId: "publish-site-approval",
        namespace: "openbot",
        tool: "publish_site",
        arguments: {
          sourcePath: bot.workspacePath,
          title: "Approved public site",
          description: "A public test site.",
        },
      },
    });
    await waitFor(() => events.some((event) => event.type === "approval"));
    expect(hostedSites.publish).not.toHaveBeenCalled();
    expect(client.responses).toHaveLength(0);
    expect(events.find((event) => event.type === "approval")).toMatchObject({
      approval: {
        kind: "permissions",
        reason: 'Publish "Approved public site" as a public site on openbot.site.',
        permissions: { fileSystem: { read: [bot.workspacePath], write: [] }, network: true },
      },
    });

    const appendConversationMessage = store.database.appendConversationMessage.bind(store.database);
    let failedTerminalAppend = false;
    let failRunningAppend = false;
    vi.spyOn(store.database, "appendConversationMessage").mockImplementation((input) => {
      if (failRunningAppend && input.message.itemType?.includes(":running:")) {
        throw new Error("Persistent marker write failure.");
      }
      if (!failedTerminalAppend && input.message.itemType?.includes(":succeeded:")) {
        failedTerminalAppend = true;
        throw new Error("Temporary marker write failure.");
      }
      return appendConversationMessage(input);
    });
    const accepted = service.respondToApproval({ requestId: "publish-site-approval", decision: "accept" });
    await expect(service.respondToApproval({ requestId: "publish-site-approval", decision: "accept" })).rejects.toThrow(
      "no longer active",
    );
    await accepted;
    expect(hostedSites.publish).toHaveBeenCalledTimes(1);
    expect(openBotToolPayload(client.responses[0]?.result)).toMatchObject({ id: "site-1", status: "active" });
    expect(
      (await service.readConversation(bot.id)).messages.flatMap(
        (message) => hostedSiteConversationEvent(message) ?? [],
      ),
    ).toEqual([
      expect.objectContaining({ action: "publish", status: "running", title: hostedSite.title }),
      expect.objectContaining({
        action: "publish",
        status: "succeeded",
        siteId: hostedSite.id,
        hostname: hostedSite.hostname,
        url: hostedSite.url,
      }),
    ]);

    client.emit("request", {
      method: "item/tool/call",
      id: "publish-site-persistence-failure",
      params: {
        threadId,
        turnId,
        callId: "publish-site-persistence-failure",
        namespace: "openbot",
        tool: "publish_site",
        arguments: {
          sourcePath: bot.workspacePath,
          title: "Unrecorded site",
          description: "This deploy must not start.",
        },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    failRunningAppend = true;
    await service.respondToApproval({ requestId: "publish-site-persistence-failure", decision: "accept" });
    failRunningAppend = false;
    expect(hostedSites.publish).toHaveBeenCalledTimes(1);
    expect(client.errors.at(-1)).toMatchObject({
      id: "publish-site-persistence-failure",
      error: { message: "The hosted site change could not be recorded." },
    });

    client.emit("request", {
      method: "item/tool/call",
      id: "delete-site-approval",
      params: {
        threadId,
        turnId,
        callId: "delete-site-approval",
        namespace: "openbot",
        tool: "delete_site",
        arguments: { siteId: "site-1" },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    expect(events.findLast((event) => event.type === "approval")).toMatchObject({
      approval: { reason: `Delete ${hostedSite.hostname} from openbot.site.` },
    });
    await service.respondToApproval({ requestId: "delete-site-approval", decision: "decline" });
    expect(hostedSites.delete).not.toHaveBeenCalled();
    expect(client.errors.at(-1)).toMatchObject({
      id: "delete-site-approval",
      error: { message: "The user declined this hosted site change." },
    });
    const markers = (await service.readConversation(bot.id)).messages.flatMap(
      (message) => hostedSiteConversationEvent(message) ?? [],
    );
    expect(markers.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: "publish", status: "running" },
      { action: "publish", status: "succeeded" },
      { action: "delete", status: "cancelled" },
    ]);
    expect((await service.readConversationPageFor(bot.id, "member-1")).readState?.unreadCount).toBe(0);
    expect(service.searchConversationMessages(hostedSite.title, bot.id).total).toBe(0);
  });

  it("records failed site updates and successful site deletions as separate transitions", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    const hostedSite = {
      id: "site-1",
      hostname: "existing-site-23456789ab.openbot.site",
      url: "https://existing-site-23456789ab.openbot.site",
      title: "Existing site",
      description: "A public test site.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 20,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSites = {
      list: vi.fn(async () => [hostedSite]),
      publish: vi.fn(async () => hostedSite),
      replace: vi.fn(async () => {
        throw new Error("Upload failed.");
      }),
      delete: vi.fn(async () => undefined),
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => {
        const client = new FakeAgentClient(provider, "", false);
        clients.set(provider, client);
        return client;
      },
      undefined,
      null,
      null,
      async () => undefined,
      hostedSites,
    );
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    await service.sendMessage({ botId: bot.id, text: "Update and remove my site." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(bot.id)?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The hosted site transition turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "replace-site-approval",
      params: {
        threadId,
        turnId,
        callId: "replace-site-approval",
        namespace: "openbot",
        tool: "replace_site",
        arguments: {
          siteId: hostedSite.id,
          sourcePath: bot.workspacePath,
          title: "Updated site",
          description: "Updated content.",
        },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    await service.respondToApproval({ requestId: "replace-site-approval", decision: "accept" });
    expect(hostedSites.replace).toHaveBeenCalledTimes(1);
    expect(client.errors.at(-1)).toMatchObject({
      id: "replace-site-approval",
      error: { message: "Error: Upload failed." },
    });

    client.emit("request", {
      method: "item/tool/call",
      id: "delete-site-success",
      params: {
        threadId,
        turnId,
        callId: "delete-site-success",
        namespace: "openbot",
        tool: "delete_site",
        arguments: { siteId: hostedSite.id },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    await service.respondToApproval({ requestId: "delete-site-success", decision: "accept" });
    expect(hostedSites.delete).toHaveBeenCalledTimes(1);

    const markers = (await service.readConversation(bot.id)).messages.flatMap(
      (message) => hostedSiteConversationEvent(message) ?? [],
    );
    expect(markers.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: "replace", status: "running" },
      { action: "replace", status: "failed" },
      { action: "delete", status: "running" },
      { action: "delete", status: "succeeded" },
    ]);
    expect(markers[0]).toMatchObject({ title: "Updated site", hostname: hostedSite.hostname });
  });

  it("keeps a successful hosted site result when the provider response cannot be delivered", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    const hostedSite = {
      id: "site-response-failure",
      hostname: "response-failure-site-23456789ab.openbot.site",
      url: "https://response-failure-site-23456789ab.openbot.site",
      title: "Response failure site",
      description: "A public test site.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 20,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSites = {
      list: vi.fn(async () => [hostedSite]),
      publish: vi.fn(async () => hostedSite),
      replace: vi.fn(async () => hostedSite),
      delete: vi.fn(async () => undefined),
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => {
        const client = new FakeAgentClient(provider, "", false);
        clients.set(provider, client);
        return client;
      },
      undefined,
      null,
      null,
      async () => undefined,
      hostedSites,
    );
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    await service.sendMessage({ botId: bot.id, text: "Publish my site." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(bot.id)?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The hosted site response test turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "publish-site-response-failure",
      params: {
        threadId,
        turnId,
        callId: "publish-site-response-failure",
        namespace: "openbot",
        tool: "publish_site",
        arguments: {
          sourcePath: bot.workspacePath,
          title: hostedSite.title,
          description: hostedSite.description,
        },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    client.responseError = new Error("The provider connection closed.");
    await service.respondToApproval({ requestId: "publish-site-response-failure", decision: "accept" });

    expect(hostedSites.publish).toHaveBeenCalledTimes(1);
    expect(
      (await service.readConversation(bot.id)).messages
        .flatMap((message) => hostedSiteConversationEvent(message) ?? [])
        .map((marker) => marker.status),
    ).toEqual(["running", "succeeded"]);
  });

  it("retries a durable hosted site result after restart without repeating the deploy", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    const hostedSite = {
      id: "site-durable-result",
      hostname: "durable-result-site-23456789ab.openbot.site",
      url: "https://durable-result-site-23456789ab.openbot.site",
      title: "Durable result site",
      description: "A public test site.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 20,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSites = {
      list: vi.fn(async () => [hostedSite]),
      publish: vi.fn(async () => hostedSite),
      replace: vi.fn(async () => hostedSite),
      delete: vi.fn(async () => undefined),
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => {
        const client = new FakeAgentClient(provider, "", false);
        clients.set(provider, client);
        return client;
      },
      undefined,
      null,
      null,
      async () => undefined,
      hostedSites,
    );
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    await service.sendMessage({ botId: bot.id, text: "Publish my site." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(bot.id)?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The hosted site retry test turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "publish-site-durable-result",
      params: {
        threadId,
        turnId,
        callId: "publish-site-durable-result",
        namespace: "openbot",
        tool: "publish_site",
        arguments: {
          sourcePath: bot.workspacePath,
          title: hostedSite.title,
          description: hostedSite.description,
        },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    const appendConversationMessage = store.database.appendConversationMessage.bind(store.database);
    const appendSpy = vi.spyOn(store.database, "appendConversationMessage").mockImplementation((input) => {
      if (input.message.itemType?.includes(":succeeded:")) {
        throw new Error("The terminal marker store is temporarily unavailable.");
      }
      return appendConversationMessage(input);
    });
    const pendingSpy = vi.spyOn(store.database, "recordPendingHostedSiteTerminalEvent").mockImplementation(() => {
      throw new Error("The terminal outbox is temporarily unavailable.");
    });
    await service.respondToApproval({ requestId: "publish-site-durable-result", decision: "accept" });

    expect(hostedSites.publish).toHaveBeenCalledTimes(1);
    expect(client.responses).toHaveLength(0);
    expect(
      (await service.readConversation(bot.id)).messages
        .flatMap((message) => hostedSiteConversationEvent(message) ?? [])
        .map((marker) => marker.status),
    ).toEqual(["running"]);
    expect(store.database.activeHostedSiteConversationEvents()).toHaveLength(1);
    expect(store.database.pendingHostedSiteTerminalEvents()).toEqual([]);

    pendingSpy.mockRestore();
    await waitFor(() => client.responses.length === 1);
    expect(store.database.pendingHostedSiteTerminalEvents()).toEqual([
      expect.objectContaining({ action: "publish", status: "succeeded" }),
    ]);

    appendSpy.mockRestore();
    await service.stop();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    expect(hostedSites.publish).toHaveBeenCalledTimes(1);
    expect(
      (await service.readConversation(bot.id)).messages
        .flatMap((message) => hostedSiteConversationEvent(message) ?? [])
        .map((marker) => marker.status),
    ).toEqual(["running", "succeeded"]);
    expect(store.database.pendingHostedSiteTerminalEvents()).toEqual([]);
    expect(store.database.activeHostedSiteConversationEvents()).toEqual([]);
  });

  it("normalizes legacy hosted site metadata without blocking deletion", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    const hostedSite = {
      id: "legacy-site",
      hostname: "legacy.example.com",
      url: "http://legacy.example.com",
      title: "",
      description: "A legacy site.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 20,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSites = {
      list: vi.fn(async () => [hostedSite]),
      publish: vi.fn(async () => hostedSite),
      replace: vi.fn(async () => hostedSite),
      delete: vi.fn(async () => undefined),
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => {
        const client = new FakeAgentClient(provider, "", false);
        clients.set(provider, client);
        return client;
      },
      undefined,
      null,
      null,
      async () => undefined,
      hostedSites,
    );
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    await service.sendMessage({ botId: bot.id, text: "Delete my old site." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(bot.id)?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The legacy hosted site test turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "delete-legacy-site",
      params: {
        threadId,
        turnId,
        callId: "delete-legacy-site",
        namespace: "openbot",
        tool: "delete_site",
        arguments: { siteId: hostedSite.id },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    await service.respondToApproval({ requestId: "delete-legacy-site", decision: "accept" });

    expect(hostedSites.delete).toHaveBeenCalledTimes(1);
    const markers = (await service.readConversation(bot.id)).messages.flatMap(
      (message) => hostedSiteConversationEvent(message) ?? [],
    );
    expect(markers.map((marker) => marker.status)).toEqual(["running", "succeeded"]);
    expect(markers[0]).toMatchObject({
      siteId: hostedSite.id,
      title: hostedSite.hostname,
      hostname: null,
      url: null,
    });
  });

  it("interrupts an unfinished hosted site marker after restart", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    const threadId = store.ensureThreadIdNow(bot.id);
    const details = { siteId: null, title: "Restarted deploy", hostname: null, url: null };
    store.database.appendConversationMessage({
      botId: bot.id,
      threadId,
      activeTurnId: null,
      message: {
        id: "hosted-site-event:operation-restart:running",
        turnId: "turn-restart",
        author: "system",
        source: "system",
        text: hostedSiteConversationEventText(details),
        createdAt: "2026-09-01T12:00:00.000Z",
        status: "completed",
        itemType: hostedSiteConversationEventItemType("publish", "running", "operation-restart"),
      },
      eventType: "hosted-site.publish-running",
      commandId: "hosted-site-event:operation-restart:running",
    });
    store.database.recordActiveHostedSiteConversationEvent({
      botId: bot.id,
      threadId,
      turnId: "turn-restart",
      createdAt: "2026-09-01T12:00:00.000Z",
      event: { action: "publish", status: "running", operationId: "operation-restart", ...details },
    });

    await service.stop();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    const markers = (await service.readConversation(bot.id)).messages.flatMap(
      (message) => hostedSiteConversationEvent(message) ?? [],
    );
    expect(markers.map((marker) => marker.status)).toEqual(["running", "interrupted"]);
    expect(markers[1]).toMatchObject({ action: "publish", title: details.title, operationId: "operation-restart" });
  });

  it("surfaces Computer Use app access elicitations and returns the user's persistence choice", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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
    const { store, mailbox } = stores();
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

  it("updates the active account and new-agent defaults with the preferred provider", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "claude");

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
          version: "2.1.246",
          email: "claude@example.com",
        },
        { id: "grok", state: "not-installed", version: null },
      ],
    });
    await expect(
      service.createBot({
        ...CREATE_BOT_INPUT,
        name: "Claude Planning Bot",
        avatarSeed: "setup:claude-planning",
      }),
    ).resolves.toMatchObject({
      model: "claude-opus-5",
      reasoningEffort: "high",
    });
    await service.setPreferredProvider("codex");
    expect(service.getStatus()).toMatchObject({
      auth: { kind: "chatgpt", email: "codex@example.com" },
      cliVersion: "0.144.1",
    });
    await expect(service.createBot(CREATE_BOT_INPUT)).resolves.toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
    });
  });

  it("detects a newly installed provider without disconnecting an available one", async () => {
    const codexPath = process.env.OPENBOT_CODEX_PATH;
    if (!codexPath) throw new Error("The fake Codex path is missing.");
    process.env.OPENBOT_CODEX_PATH = join(root, "missing-codex");
    const workingDirectory = process.cwd();
    process.chdir(root);
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    try {
      await service.initialize();
      expect(service.getStatus()).toMatchObject({
        phase: "blocked",
        providers: [
          { id: "codex", state: "error", message: expect.stringContaining("included ChatGPT runtime") },
          { id: "claude", state: "error", message: expect.stringContaining("included Claude runtime") },
          { id: "grok", state: "not-installed" },
        ],
      });

      process.env.OPENBOT_CODEX_PATH = codexPath;
      await expect(service.refreshProviders()).resolves.toMatchObject({
        phase: "ready",
        providers: [
          { id: "codex", state: "available" },
          { id: "claude", state: "error", message: expect.stringContaining("included Claude runtime") },
          { id: "grok", state: "not-installed" },
        ],
      });
      const codexClient = clients.get("codex");
      expect(codexClient?.running).toBe(true);

      await service.refreshProviders();

      expect(clients.get("codex")).toBe(codexClient);
      expect(codexClient?.running).toBe(true);
      expect(service.getStatus().providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "codex", state: "available" }),
          expect.objectContaining({ id: "claude", state: "error" }),
          expect.objectContaining({ id: "grok", state: "not-installed" }),
        ]),
      );
    } finally {
      process.chdir(workingDirectory);
    }
  });

  it("returns a provider refresh before runtime metadata finishes loading", async () => {
    const { store, mailbox } = stores();
    let holdMetadata = false;
    let releaseMetadata: (() => void) | undefined;
    const metadataReleased = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) =>
        new FakeAgentClient(provider, "DONE", true, true, {}, async (method) => {
          if (holdMetadata && (method === "model/list" || method === "plugin/list")) await metadataReleased;
        }),
    );
    await service.initialize();
    holdMetadata = true;

    const outcome = await Promise.race([
      service.refreshProviders().then(() => "resolved" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]);
    releaseMetadata?.();

    expect(outcome).toBe("resolved");
    expect(service.getStatus().phase).toBe("ready");
  });

  it("keeps a connected provider and surfaces its account refresh warning", async () => {
    const { store, mailbox } = stores();
    let accountReads = 0;
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) =>
        new FakeAgentClient(provider, "DONE", true, true, {}, async (method) => {
          if (method === "account/read" && ++accountReads === 2) throw new Error("Temporary account API failure");
        }),
    );
    await service.initialize();

    await service.refreshProviders();

    expect(service.getStatus().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "codex",
          state: "available",
          checkError: "Could not verify ChatGPT. Keeping the existing connection.",
        }),
      ]),
    );
  });

  it("removes a new Bot and its workspace when the first message cannot enter the queue", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    vi.spyOn(mailbox, "enqueue").mockRejectedValueOnce(new Error("Queue write failed."));

    await expect(service.createBot(CREATE_BOT_INPUT)).rejects.toThrow("Queue write failed.");

    expect(service.listBots()).toEqual([]);
    expect(store.database.listAgents()).toEqual([]);
    await expect(readdir(join(root, "home", "OpenBot", "Bots"))).resolves.toEqual([]);
  });

  it("keeps the agent model and thread when a lazy provider cannot start", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await store.getOrCreate("chief");
    const threadId = await store.ensureThreadId("chief");

    await expect(service.updateBot({ botId: "chief", provider: "claude", model: "claude-sonnet-5" })).rejects.toThrow(
      "included Claude runtime",
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
      service.updateBot({
        botId: "chief",
        provider: "claude",
        model: "claude-sonnet-5",
        reasoningEffort: "high",
      }),
    ).resolves.toMatchObject({ model: "claude-sonnet-5", reasoningEffort: "high" });
    expect(service.getStatus().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex", state: "available" }),
        expect.objectContaining({ id: "claude", state: "available" }),
      ]),
    );
  });

  it("hands one SQLite conversation across Codex, Grok, and Claude provider sessions", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    process.env.OPENBOT_GROK_PATH = await createFakeGrok(root);
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "First request" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "completed");
    const publicThreadId = service.listBots().find((bot) => bot.id === "chief")?.threadId;

    await service.updateBot({ botId: "chief", provider: "grok", model: "grok-4.5" });
    expect(service.listBots().find((bot) => bot.id === "chief")?.threadId).toBe(publicThreadId);
    await service.sendMessage({ botId: "chief", text: "Second request" });
    await waitFor(() => service?.listQueue("chief").deliveries[1]?.status === "completed");

    const grokInput = clients.get("grok")?.requests.find((request) => request.method === "turn/start")?.params;
    expect(firstInputText(grokInput)).toContain("CODEX_DONE");
    expect(firstInputText(grokInput)).toContain("Second request");

    await service.updateBot({ botId: "chief", provider: "claude", model: "claude-sonnet-5" });
    await service.sendMessage({ botId: "chief", text: "Third request" });
    await waitFor(() => service?.listQueue("chief").deliveries[2]?.status === "completed");
    const claudeInput = clients.get("claude")?.requests.find((request) => request.method === "turn/start")?.params;
    expect(firstInputText(claudeInput)).toContain("GROK_DONE");

    const conversation = await service.readConversation("chief");
    expect(conversation.threadId).toBe(publicThreadId);
    expect(conversation.messages.map((message) => message.text)).toEqual(
      expect.arrayContaining(["CODEX_DONE", "GROK_DONE", "CLAUDE_DONE"]),
    );
    if (!publicThreadId) throw new Error("The public thread was not created.");
    expect(store.database.listProviderSessions(publicThreadId)).toMatchObject([
      { provider: "codex", state: "inactive" },
      { provider: "grok", state: "inactive" },
      { provider: "claude", state: "active" },
    ]);
  });

  it("stores a visible summary when a provider handoff exceeds its budget", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const output = provider === "codex" ? "X".repeat(250_000) : "CLAUDE_DONE";
      const client = new FakeAgentClient(provider, output);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Create a long result" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "completed");
    const publicThreadId = service.listBots().find((bot) => bot.id === "chief")?.threadId;

    await service.updateBot({ botId: "chief", provider: "claude", model: "claude-sonnet-5" });
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
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
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
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
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
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
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
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
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
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
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
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
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
    process.env.OPENBOT_FAKE_TURN_START_RESPONSE_DELAY = "100";
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
      chiefMessages.findIndex((message) => message.author === "assistant" && message.itemType !== "commentary"),
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

    await waitFor(async () =>
      (await protocolMessages()).some(
        (message) => message.method === "turn/start" && getString(message.params, "cwd")?.endsWith("/sales-outbound"),
      ),
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

  it("lets an agent manage routines for itself and another agent", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    await store.getOrCreate("design", "Design Studio", "Product design");
    await service.sendMessage({ botId: "chief", text: "Manage our routines." });
    await waitFor(() => Boolean(store.activeProviderSession("chief")));

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    if (!client || !threadId) throw new Error("The routine tool test thread did not start.");

    const ownCreate = await callOpenBotTool(client, threadId, "create_routine", {
      name: "Morning brief",
      instruction: "Prepare the daily brief.",
      schedule: { kind: "daily", time: "09:00" },
    });
    expect(ownCreate.error).toBeUndefined();
    const ownRoutine = openBotToolPayload(ownCreate.result);
    expect(ownRoutine).toMatchObject({
      botId: "chief",
      name: "Morning brief",
      active: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });

    const otherCreate = await callOpenBotTool(client, threadId, "create_routine", {
      botId: "design",
      name: "Weekly review",
      instruction: "Review the current design work.",
      active: false,
      timezone: "UTC",
      schedule: { kind: "weekly", weekday: 1, time: "10:30" },
    });
    expect(otherCreate.error).toBeUndefined();
    const otherRoutine = openBotToolPayload(otherCreate.result);
    expect(otherRoutine).toMatchObject({ botId: "design", active: false, timezone: "UTC" });

    const listResult = await callOpenBotTool(client, threadId, "list_routines", { botId: "design" });
    expect(openBotToolPayload(listResult.result).routines).toEqual([
      expect.objectContaining({ id: otherRoutine.id, name: "Weekly review" }),
    ]);

    const updated = await callOpenBotTool(client, threadId, "update_routine", {
      botId: "design",
      routineId: otherRoutine.id,
      active: true,
      schedule: { kind: "weekdays", time: "08:15" },
    });
    expect(openBotToolPayload(updated.result)).toMatchObject({
      id: otherRoutine.id,
      active: true,
      trigger: { schedule: { kind: "weekdays", time: "08:15" } },
    });

    const testRun = await callOpenBotTool(client, threadId, "test_routine", {
      botId: "design",
      routineId: otherRoutine.id,
    });
    expect(openBotToolPayload(testRun.result)).toMatchObject({
      routineId: otherRoutine.id,
      botId: "design",
      kind: "manual",
      status: "queued",
    });

    const deleted = await callOpenBotTool(client, threadId, "delete_routine", { routineId: ownRoutine.id });
    expect(openBotToolPayload(deleted.result)).toEqual({
      deleted: true,
      botId: "chief",
      routineId: ownRoutine.id,
    });
    expect(service.listRoutines("chief")).toEqual([]);
    expect(service.listRoutines("design")).toEqual([expect.objectContaining({ id: otherRoutine.id, active: true })]);
    const ownEvents = (await service.readConversation("chief")).messages.flatMap((message) => {
      const event = routineConversationEvent(message);
      return event ? [{ ...event, turnId: message.turnId }] : [];
    });
    expect(ownEvents).toEqual([
      expect.objectContaining({ action: "created", routineId: ownRoutine.id, turnId: expect.any(String) }),
      expect.objectContaining({ action: "deleted", routineId: ownRoutine.id, turnId: expect.any(String) }),
    ]);
    const otherEvents = (await service.readConversation("design")).messages.flatMap((message) => {
      const event = routineConversationEvent(message);
      return event ? [{ ...event, turnId: message.turnId }] : [];
    });
    expect(otherEvents).toEqual([
      expect.objectContaining({ action: "created", routineId: otherRoutine.id, turnId: undefined }),
      expect.objectContaining({ action: "updated", routineId: otherRoutine.id, turnId: undefined }),
    ]);
  });

  it("persists routine lifecycle markers without adding unread or search results", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    const bot = await store.getOrCreate("chief");

    const created = service.createRoutine({
      botId: bot.id,
      name: "Morning brief",
      instruction: "Prepare the daily brief.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    const updated = service.updateRoutine({
      botId: bot.id,
      routineId: created.id,
      name: "Updated morning brief",
    });
    await service.deleteRoutine({ botId: bot.id, routineId: created.id });

    const conversation = await service.readConversation(bot.id);
    expect(conversation.messages.flatMap((message) => routineConversationEvent(message) ?? [])).toEqual([
      { action: "created", routineId: created.id, routineName: "Morning brief" },
      { action: "updated", routineId: updated.id, routineName: "Updated morning brief" },
      { action: "deleted", routineId: updated.id, routineName: "Updated morning brief" },
    ]);
    expect((await service.readConversationPageFor(bot.id, "member-1")).readState?.unreadCount).toBe(0);
    expect(service.searchConversationMessages("morning brief", bot.id).total).toBe(0);

    await service.stop();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    expect(
      (await service.readConversation(bot.id)).messages.flatMap((message) => routineConversationEvent(message) ?? []),
    ).toHaveLength(3);
  });

  it("appends a cancellation marker before deleting an active routine run", async () => {
    const { store, mailbox } = stores();
    let client: FakeAgentClient | undefined;
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      client = new FakeAgentClient(provider, "", false);
      return client;
    });
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      botId: bot.id,
      name: "Active routine",
      instruction: "Remain active until deletion.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    const run = await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await waitFor(() =>
      service
        ?.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .some((candidate) => candidate.id === run.id && candidate.status === "running"),
    );
    const runningDelivery = service.listQueue(bot.id).deliveries.find((delivery) => delivery.status === "running");
    if (!runningDelivery?.turnId || !client) throw new Error("The active routine turn did not start.");

    await service.deleteRoutine({ botId: bot.id, routineId: routine.id });

    expect(client.requests).toContainEqual(
      expect.objectContaining({
        method: "turn/interrupt",
        params: expect.objectContaining({ turnId: runningDelivery.turnId }),
      }),
    );
    const events = (await service.readConversation(bot.id)).messages.flatMap(
      (message) => routineRunConversationEvent(message) ?? [],
    );
    expect(events).toContainEqual(
      expect.objectContaining({ routineId: routine.id, runId: run.id, status: "cancelled" }),
    );
  });

  it("keeps a started routine delivery running while its transition marker retries", async () => {
    const { store, mailbox } = stores();
    let client: FakeAgentClient | undefined;
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      client = new FakeAgentClient(provider, "", false);
      return client;
    });
    const emitted: AgentEvent[] = [];
    service.on("event", (event: AgentEvent) => emitted.push(event));
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      botId: bot.id,
      name: "Retry running marker",
      instruction: "Keep the provider turn active while marker persistence retries.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    const appendConversationMessage = store.database.appendConversationMessage.bind(store.database);
    let rejectRunningMarker = true;
    vi.spyOn(store.database, "appendConversationMessage").mockImplementation((input) => {
      if (rejectRunningMarker && input.eventType === "routine.run-running") {
        rejectRunningMarker = false;
        throw new Error("running marker persistence failed");
      }
      return appendConversationMessage(input);
    });

    const run = await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await waitFor(() => {
      const currentRun = service?.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })[0];
      return currentRun?.id === run.id && currentRun.status === "running";
    });

    expect(service.listQueue(bot.id).deliveries).toContainEqual(expect.objectContaining({ status: "running" }));
    expect(client?.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: "error", code: "delivery_reconciliation_pending", botId: bot.id }),
    );
    const runningMarkers = (await service.readConversation(bot.id)).messages.filter(
      (message) => routineRunConversationEvent(message)?.status === "running",
    );
    expect(runningMarkers).toHaveLength(1);
  });

  it("keeps routine approvals interactive while attention markers retry", async () => {
    const { store, mailbox } = stores();
    let client: FakeAgentClient | undefined;
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      client = new FakeAgentClient(provider, "", false);
      return client;
    });
    const emitted: AgentEvent[] = [];
    service.on("event", (event: AgentEvent) => emitted.push(event));
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      botId: bot.id,
      name: "Approval marker retry",
      instruction: "Request approval and continue after the response.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    const run = await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await waitFor(() =>
      service
        ?.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .some((candidate) => candidate.id === run.id && candidate.status === "running"),
    );
    const delivery = service.listQueue(bot.id).deliveries.find((candidate) => candidate.status === "running");
    const threadId = store.activeProviderSession(bot.id)?.externalSessionId;
    if (!delivery?.turnId || !client || !threadId) throw new Error("The routine turn did not start.");

    const appendConversationMessage = store.database.appendConversationMessage.bind(store.database);
    let rejectNeedsAttentionMarker = true;
    let rejectResumedRunningMarker = false;
    vi.spyOn(store.database, "appendConversationMessage").mockImplementation((input) => {
      if (rejectNeedsAttentionMarker && input.eventType === "routine.run-needs-attention") {
        rejectNeedsAttentionMarker = false;
        throw new Error("attention marker persistence failed");
      }
      if (rejectResumedRunningMarker && input.eventType === "routine.run-running") {
        rejectResumedRunningMarker = false;
        throw new Error("resumed marker persistence failed");
      }
      return appendConversationMessage(input);
    });

    client.emit("request", {
      id: "retry-routine-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId, turnId: delivery.turnId, command: "echo routine" },
    });

    await waitFor(() => emitted.some((event) => event.type === "approval"));
    await waitFor(() =>
      service
        ?.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .some((candidate) => candidate.id === run.id && candidate.status === "needs-attention"),
    );
    expect(client.responses).toEqual([]);

    rejectResumedRunningMarker = true;
    await service.respondToApproval({ requestId: "retry-routine-approval", decision: "accept" });
    expect(client.responses).toContainEqual(
      expect.objectContaining({ id: "retry-routine-approval", result: { decision: "accept" } }),
    );
    await waitFor(() =>
      service
        ?.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .some((candidate) => candidate.id === run.id && candidate.status === "running"),
    );

    expect(
      emitted.filter(
        (event) => event.type === "error" && event.code === "delivery_reconciliation_pending" && event.botId === bot.id,
      ),
    ).toHaveLength(2);
    const transitions = (await service.readConversation(bot.id)).messages.flatMap(
      (message) => routineRunConversationEvent(message) ?? [],
    );
    expect(transitions.filter((event) => event.runId === run.id && event.status === "needs-attention")).toHaveLength(1);
    expect(transitions.filter((event) => event.runId === run.id && event.status === "running")).toHaveLength(2);
  });

  it("continues turn completion while a terminal routine marker retries", async () => {
    const { store, mailbox } = stores();
    let client: FakeAgentClient | undefined;
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      client = new FakeAgentClient(provider, "", false);
      return client;
    });
    const emitted: AgentEvent[] = [];
    service.on("event", (event: AgentEvent) => emitted.push(event));
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      botId: bot.id,
      name: "Retry terminal marker",
      instruction: "Continue queued work after terminal marker persistence retries.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    const firstRun = await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await waitFor(() => {
      const deliveries = service?.listQueue(bot.id).deliveries ?? [];
      return (
        deliveries.some((delivery) => delivery.status === "running") &&
        deliveries.some((delivery) => delivery.status === "queued")
      );
    });
    const firstDelivery = service.listQueue(bot.id).deliveries.find((delivery) => delivery.status === "running");
    const threadId = store.activeProviderSession(bot.id)?.externalSessionId;
    if (!firstDelivery?.turnId || !client || !threadId) throw new Error("The first routine turn did not start.");
    const appendConversationMessage = store.database.appendConversationMessage.bind(store.database);
    let rejectTerminalMarker = true;
    vi.spyOn(store.database, "appendConversationMessage").mockImplementation((input) => {
      if (rejectTerminalMarker && input.eventType === "routine.run-succeeded") {
        rejectTerminalMarker = false;
        throw new Error("terminal marker persistence failed");
      }
      return appendConversationMessage(input);
    });

    client.emit(
      "notification",
      notification("turn/completed", {
        threadId,
        turn: { id: firstDelivery.turnId, status: "completed" },
      }),
    );

    await waitFor(() =>
      emitted.some(
        (event) => event.type === "turn-completed" && event.botId === bot.id && event.turnId === firstDelivery.turnId,
      ),
    );
    await waitFor(() =>
      service
        ?.listQueue(bot.id)
        .deliveries.some((delivery) => delivery.id !== firstDelivery.id && delivery.status === "running"),
    );
    expect(
      service
        .listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .find((run) => run.id === firstRun.id),
    ).toMatchObject({ status: "succeeded" });
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: "error", code: "delivery_reconciliation_pending", botId: bot.id }),
    );
    const terminalMarkers = (await service.readConversation(bot.id)).messages.filter((message) => {
      const event = routineRunConversationEvent(message);
      return event?.runId === firstRun.id && event.status === "succeeded";
    });
    expect(terminalMarkers).toHaveLength(1);
  });

  it("rolls back a routine mutation when its transcript marker cannot persist", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    const initialBot = store.list().find((candidate) => candidate.id === bot.id);
    vi.spyOn(store.database, "persistConversation").mockImplementationOnce(() => {
      throw new Error("conversation persistence failed");
    });

    expect(() =>
      service?.createRoutine({
        botId: bot.id,
        name: "Atomic routine",
        instruction: "Do not persist half of this change.",
        active: true,
        timezone: "UTC",
        schedule: { kind: "daily", time: "09:00" },
      }),
    ).toThrow("conversation persistence failed");
    expect(service.listRoutines(bot.id)).toEqual([]);
    expect((await service.readConversation(bot.id)).messages).toEqual([]);
    expect(store.list().find((candidate) => candidate.id === bot.id)).toMatchObject({
      threadId: initialBot?.threadId ?? null,
      updatedAt: initialBot?.updatedAt ?? null,
    });
  });

  it("restores queued routine work when a delete marker cannot persist", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      botId: bot.id,
      name: "Queued routine",
      instruction: "Keep this queued when deletion fails.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await waitFor(() => service?.listQueue(bot.id).deliveries.some((delivery) => delivery.status === "queued"));
    const queuedDelivery = service.listQueue(bot.id).deliveries.find((delivery) => delivery.status === "queued");
    if (!queuedDelivery) throw new Error("The queued routine delivery is missing.");
    const queuedRun = service
      .listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
      .find((run) => run.deliveryId === queuedDelivery.id);
    if (!queuedRun) throw new Error("The queued routine run is missing.");
    const persistConversation = store.database.persistConversation.bind(store.database);
    vi.spyOn(store.database, "persistConversation").mockImplementation((...args) => {
      if (args[1] === "routine.deleted") throw new Error("delete marker persistence failed");
      return persistConversation(...args);
    });

    await expect(service.deleteRoutine({ botId: bot.id, routineId: routine.id })).rejects.toThrow(
      "delete marker persistence failed",
    );
    expect(service.listRoutines(bot.id)).toEqual([expect.objectContaining({ id: routine.id })]);
    const restoredDelivery = service.listQueue(bot.id).deliveries.find((delivery) => delivery.id === queuedDelivery.id);
    expect(restoredDelivery).toBeDefined();
    expect(["queued", "starting", "running"]).toContain(restoredDelivery?.status);
    const restoredRun = service
      .listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
      .find((run) => run.id === queuedRun.id);
    expect(restoredRun).toBeDefined();
    expect(["queued", "running"]).toContain(restoredRun?.status);
    await waitFor(() =>
      service
        ?.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .some((run) => run.status === "interrupted"),
    );
    expect(service.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "interrupted" })]),
    );
  });

  it("rolls back a routine transition and retries without a duplicate marker", async () => {
    const { store, mailbox } = stores();
    const createService = () =>
      new AgentService(
        store,
        mailbox,
        fakeBrowser(),
        30_000,
        "codex",
        (provider) => new FakeAgentClient(provider, "", false),
      );
    service = createService();
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      botId: bot.id,
      name: "Atomic run",
      instruction: "Keep run state and history together.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await waitFor(() => service?.listQueue(bot.id).deliveries.some((delivery) => delivery.status === "queued"));
    const queued = service.listQueue(bot.id).deliveries.find((delivery) => delivery.status === "queued");
    if (!queued) throw new Error("The queued routine delivery is missing.");
    const queuedRun = service
      .listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
      .find((run) => run.deliveryId === queued.id);
    if (!queuedRun) throw new Error("The queued routine run is missing.");
    const appendConversationMessage = store.database.appendConversationMessage.bind(store.database);
    let rejectCancellationMarker = true;
    vi.spyOn(store.database, "appendConversationMessage").mockImplementation((input) => {
      if (rejectCancellationMarker && input.eventType === "routine.run-cancelled") {
        rejectCancellationMarker = false;
        throw new Error("transition marker persistence failed");
      }
      return appendConversationMessage(input);
    });

    await expect(service.cancelQueuedMessage(bot.id, queued.id)).rejects.toThrow(
      "transition marker persistence failed",
    );
    expect(
      service
        .listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .find((run) => run.deliveryId === queued.id),
    ).toMatchObject({ status: "queued" });
    const cancelledMarkers = async () =>
      (await service?.readConversation(bot.id))?.messages.filter((message) => {
        const event = routineRunConversationEvent(message);
        return event?.runId === queuedRun.id && event.status === "cancelled";
      }) ?? [];

    await service.stop();
    service = createService();
    await service.initialize();

    expect(
      service
        .listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .find((run) => run.deliveryId === queued.id),
    ).toMatchObject({ status: "cancelled" });
    expect(await cancelledMarkers()).toHaveLength(1);
  });

  it("rejects invalid or cross-agent routine tool mutations", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    await store.getOrCreate("design", "Design Studio", "Product design");
    await service.sendMessage({ botId: "chief", text: "Validate routine requests." });
    await waitFor(() => Boolean(store.activeProviderSession("chief")));

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    if (!client || !threadId) throw new Error("The routine validation test thread did not start.");

    await expectOpenBotToolError(client, threadId, "list_routines", { botId: "missing" }, "Unknown bot");
    await expectOpenBotToolError(
      client,
      threadId,
      "create_routine",
      {
        name: "Invalid",
        instruction: "This must not be saved.",
        schedule: { kind: "daily", time: "25:00" },
      },
      "schedule is invalid",
    );
    await expectOpenBotToolError(
      client,
      threadId,
      "create_routine",
      {
        name: "Invalid active state",
        instruction: "This must not be saved.",
        active: null,
        schedule: { kind: "daily", time: "09:00" },
      },
      "active must be a boolean",
    );

    const routine = service.createRoutine({
      botId: "chief",
      name: "Owned routine",
      instruction: "Remain owned by Chief.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    await expectOpenBotToolError(
      client,
      threadId,
      "update_routine",
      { routineId: routine.id },
      "At least one routine update is required",
    );
    await expectOpenBotToolError(
      client,
      threadId,
      "update_routine",
      { botId: "design", routineId: routine.id, active: false },
      "routine no longer exists",
    );
  });

  it("lets an agent react to the current user message without replacing the user's reaction", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    const receipt = await service.sendMessage({ botId: "chief", text: "The launch is approved." });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = service.listQueue("chief").deliveries[0]?.turnId;
    const messageId = receipt.deliveries[0]?.id;
    if (!client || !threadId || !turnId || !messageId) throw new Error("The reaction test turn did not start.");

    await service.setMessageReaction({ botId: "chief", messageId, emoji: "❤️" });
    const first = await callOpenBotTool(client, threadId, "react_to_user_message", { emoji: "🎉" }, turnId);
    expect(openBotToolPayload(first.result)).toMatchObject({ status: "reacted", messageId, emoji: "🎉" });
    const second = await callOpenBotTool(client, threadId, "react_to_user_message", { emoji: "👨‍👩‍👧‍👦" }, turnId);
    expect(openBotToolPayload(second.result)).toMatchObject({ emoji: "👨‍👩‍👧‍👦" });

    const message = (await service.readConversation("chief")).messages.find((candidate) => candidate.id === messageId);
    expect(message).toMatchObject({
      reaction: "❤️",
      reactions: [
        { emoji: "❤️", actor: { kind: "user" } },
        { emoji: "👨‍👩‍👧‍👦", actor: { kind: "bot", botId: "chief" } },
      ],
    });
    await expectOpenBotToolError(
      client,
      threadId,
      "react_to_user_message",
      { emoji: "🎉🎉" },
      "exactly one complete Unicode emoji",
      turnId,
    );
  });

  it("rejects an agent reaction when the current turn was not started by the user", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    await store.initialize();
    await mailbox.initialize();
    await store.getOrCreate("chief");
    await store.getOrCreate("research");
    await mailbox.enqueue({
      sender: { kind: "bot", botId: "research" },
      recipientBotIds: ["chief"],
      text: "Teammate update.",
    });
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = service.listQueue("chief").deliveries[0]?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The teammate reaction test turn did not start.");
    await expectOpenBotToolError(
      client,
      threadId,
      "react_to_user_message",
      { emoji: "👍" },
      "Only the current user message",
      turnId,
    );
  });

  it("attaches an agent-created screenshot to the current user response", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    const screenshotPath = join(store.sharedRoot, "desktop-screenshot.png");
    const screenshot = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    await writeFile(screenshotPath, screenshot);
    await service.sendMessage({ botId: "chief", text: "Send me a screenshot." });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = service.listQueue("chief").deliveries[0]?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The screenshot attachment turn did not start.");

    const result = await callOpenBotTool(
      client,
      threadId,
      "attach_files_to_response",
      { paths: [screenshotPath] },
      turnId,
    );
    expect(openBotToolPayload(result.result)).toMatchObject({
      status: "attached",
      attachments: [{ name: "desktop-screenshot.png" }],
    });

    const message = (await service.readConversation("chief")).messages.find(
      (candidate) => candidate.itemType === "agent_attachment" && candidate.turnId === turnId,
    );
    expect(message).toMatchObject({
      author: "assistant",
      status: "completed",
      text: "",
      attachments: [
        {
          name: "desktop-screenshot.png",
          kind: "image",
          mimeType: "image/png",
          previewKind: "image",
        },
      ],
    });
    expect(service.getRuntimeSnapshot().latestMessages).not.toContainEqual(
      expect.objectContaining({ id: message?.id }),
    );
    const managed = await mailbox.resolveAttachment(message?.attachments?.[0]?.id ?? "");
    expect(managed?.path).not.toBe(screenshotPath);
    await expect(readFile(managed?.path ?? "")).resolves.toEqual(screenshot);

    const outsidePath = join(root, "outside.png");
    await writeFile(outsidePath, screenshot);
    await expectOpenBotToolError(
      client,
      threadId,
      "attach_files_to_response",
      { paths: [outsidePath] },
      "inside this agent's workspace or the OpenBot shared directory",
      turnId,
    );
    const linkedPath = join(store.sharedRoot, "linked-outside.png");
    await symlink(outsidePath, linkedPath);
    await expectOpenBotToolError(
      client,
      threadId,
      "attach_files_to_response",
      { paths: [linkedPath] },
      "inside this agent's workspace or the OpenBot shared directory",
      turnId,
    );

    const publishedPath = join(store.sharedRoot, "published-screenshot.png");
    await writeFile(publishedPath, screenshot);
    const publicationFailure = (event: AgentEvent) => {
      if (
        event.type === "conversation" &&
        event.snapshot.messages.some((candidate) =>
          candidate.attachments?.some((attachment) => attachment.name === "published-screenshot.png"),
        )
      ) {
        throw new Error("conversation listener failed");
      }
    };
    const publicationEvents: AgentEvent[] = [];
    const recordPublicationEvent = (event: AgentEvent) => publicationEvents.push(event);
    service.on("event", publicationFailure);
    service.on("event", recordPublicationEvent);
    const publicationCallId = "publication-failure-call";
    const publicationResult = await callOpenBotTool(
      client,
      threadId,
      "attach_files_to_response",
      { paths: [publishedPath] },
      turnId,
      publicationCallId,
    );
    service.off("event", publicationFailure);
    service.off("event", recordPublicationEvent);
    expect(openBotToolPayload(publicationResult.result)).toMatchObject({
      status: "attached",
      attachments: [{ name: "published-screenshot.png" }],
    });
    expect(publicationEvents).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "conversation_publication_failed",
        message: "conversation listener failed",
      }),
    );
    const publishedMessage = (await service.readConversation("chief")).messages.find((candidate) =>
      candidate.attachments?.some((attachment) => attachment.name === "published-screenshot.png"),
    );
    await expect(mailbox.resolveAttachment(publishedMessage?.attachments?.[0]?.id ?? "")).resolves.not.toBeNull();
  });

  it("shares one attachment operation between concurrent retries", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    const screenshotPath = join(store.sharedRoot, "concurrent-screenshot.png");
    await writeFile(screenshotPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await service.sendMessage({ botId: "chief", text: "Send the screenshot once." });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = service.listQueue("chief").deliveries[0]?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The concurrent attachment turn did not start.");

    const originalStore = mailbox.stageGeneratedAttachments.bind(mailbox);
    let releaseStore: (() => void) | undefined;
    const storeGate = new Promise<void>((resolve) => {
      releaseStore = resolve;
    });
    let markStoreStarted: (() => void) | undefined;
    const storeStarted = new Promise<void>((resolve) => {
      markStoreStarted = resolve;
    });
    const storage = vi.spyOn(mailbox, "stageGeneratedAttachments").mockImplementation(async (input) => {
      markStoreStarted?.();
      await storeGate;
      return originalStore(input);
    });
    const callId = "concurrent-attachment-call";
    const first = callOpenBotTool(
      client,
      threadId,
      "attach_files_to_response",
      { paths: [screenshotPath] },
      turnId,
      callId,
    );
    await storeStarted;
    const second = callOpenBotTool(
      client,
      threadId,
      "attach_files_to_response",
      { paths: [screenshotPath] },
      turnId,
      callId,
    );
    let stopCompleted = false;
    const stopping = service.stop().then(() => {
      stopCompleted = true;
    });
    await Promise.resolve();
    expect(stopCompleted).toBe(false);
    releaseStore?.();

    const [firstResult, secondResult] = await Promise.all([first, second, stopping]);
    expect(stopCompleted).toBe(true);
    expect(openBotToolPayload(firstResult.result)).toEqual(openBotToolPayload(secondResult.result));
    expect(storage).toHaveBeenCalledTimes(1);
    expect(
      (await service.readConversation("chief")).messages.filter(
        (message) => message.itemType === "agent_attachment" && message.turnId === turnId,
      ),
    ).toHaveLength(1);
    await expect(mailbox.listExportAttachments()).resolves.toHaveLength(1);
  });

  it("rolls back response attachments when conversation persistence fails and permits retry", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    const screenshotPath = join(store.sharedRoot, "retry-screenshot.png");
    await writeFile(screenshotPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await service.sendMessage({ botId: "chief", text: "Send the screenshot safely." });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = service.listQueue("chief").deliveries[0]?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The attachment rollback turn did not start.");

    const callId = "stable-attachment-call";
    const persistence = vi.spyOn(mailbox, "persistGeneratedAttachmentsWithConversation").mockImplementationOnce(() => {
      throw new Error("conversation write failed");
    });
    const failed = await callOpenBotTool(
      client,
      threadId,
      "attach_files_to_response",
      { paths: [screenshotPath] },
      turnId,
      callId,
    );
    expect(failed.error?.message).toContain("conversation write failed");
    expect((await service.readConversation("chief")).messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ itemType: "agent_attachment", turnId })]),
    );
    await expect(mailbox.listExportAttachments()).resolves.toEqual([]);

    persistence.mockRestore();
    const retried = await callOpenBotTool(
      client,
      threadId,
      "attach_files_to_response",
      { paths: [screenshotPath] },
      turnId,
      callId,
    );
    expect(openBotToolPayload(retried.result)).toMatchObject({
      status: "attached",
      attachments: [{ name: "retry-screenshot.png" }],
    });
    await expect(mailbox.listExportAttachments()).resolves.toHaveLength(1);
    expect(
      (await service.readConversation("chief")).messages.filter(
        (message) => message.itemType === "agent_attachment" && message.turnId === turnId,
      ),
    ).toHaveLength(1);
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
    process.env.OPENBOT_FAKE_TURN_START_RESPONSE_DELAY = "250";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 75);
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

  it("keeps a completed turn idle when its start response arrives after lifecycle events", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "Finished before the start response";
    process.env.OPENBOT_FAKE_TURN_START_RESPONSE_DELAY = "100";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "Run exactly once" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "completed");
    await new Promise((resolve) => setTimeout(resolve, 150));

    const delivery = service.listQueue("chief").deliveries[0];
    if (!delivery?.turnId) throw new Error("The completed delivery did not have a turn.");
    expect((await service.readConversation("chief")).activeTurnId).toBeNull();
    expect(
      store.database.connection
        .prepare("SELECT status, completed_at FROM projection_turns WHERE turn_id = ?")
        .get(delivery.turnId),
    ).toMatchObject({ status: "completed", completed_at: expect.any(String) });
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

  it("expires a persisted question prompt after restart", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Start a recoverable turn" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");
    const bot = await store.getOrCreate("chief");
    await service.stop();
    const snapshot = store.database.readConversation("chief", bot.threadId);
    snapshot.activeTurnId = "turn-with-question";
    snapshot.messages.push({
      id: "question-prompt:turn-with-question:request-1",
      turnId: "turn-with-question",
      author: "assistant",
      source: "assistant",
      text: "",
      createdAt: "2026-08-28T12:00:00.000Z",
      status: "completed",
      itemType: "question_prompt",
      questionPrompt: {
        requestId: "request-1",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "How broad should the change be?",
            isSecret: false,
            options: null,
          },
        ],
        resolution: null,
      },
    });
    store.database.persistConversation(snapshot, "test.question-prompt-pending");

    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    const recovered = await service.readConversation("chief");
    expect(recovered.activeTurnId).toBeNull();
    expect(recovered.messages.find((message) => message.questionPrompt)?.questionPrompt?.resolution).toEqual({
      status: "expired",
    });
  });

  it("does not persist unchanged provider history after repeated restarts", async () => {
    const clients: FakeAgentClient[] = [];
    const { store, mailbox } = stores();
    const createService = () =>
      new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
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
      const client = clients.filter((candidate) => candidate.provider === "codex").at(-1);
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

    const deletedBot = await store.getOrCreate("sales-outbound");
    store.ensureThreadIdNow(deletedBot.id);
    store.database.recordPendingHostedSiteTerminalEvent({
      botId: deletedBot.id,
      threadId: "provider-thread-sales-outbound",
      turnId: "turn-delete-agent",
      operationId: "operation-delete-agent",
      action: "replace",
      status: "succeeded",
      details: {
        siteId: "site-delete-agent",
        title: "Deleted agent site",
        hostname: null,
        url: null,
      },
      markerCommandId: `hosted-site-event:${deletedBot.id}:operation-delete-agent:succeeded`,
      createdAt: "2026-09-01T12:00:00.000Z",
    });
    expect(store.database.pendingHostedSiteTerminalEvents()).toHaveLength(1);
    await service.deleteBot("sales-outbound");
    expect(service.listBots().some((bot) => bot.id === "sales-outbound")).toBe(false);
    expect(store.database.pendingHostedSiteTerminalEvents()).toEqual([]);
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
  it("queues independent manual routine runs and renders routine metadata", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "", false);
      clients.set(provider, client);
      return client;
    });
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      botId: bot.id,
      name: "Queue health",
      instruction: "Check the current queue health.",
      active: true,
      timezone: "Europe/Warsaw",
      schedule: { kind: "daily", time: "09:00" },
    });

    await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await waitFor(() => service?.listQueue(bot.id).deliveries.some((delivery) => delivery.status === "running"));

    const queue = service.listQueue(bot.id);
    expect(queue.deliveries.map((delivery) => delivery.status)).toEqual(["running", "queued"]);
    expect(queue.deliveries.every((delivery) => delivery.sender.kind === "routine")).toBe(true);
    const conversation = await service.readConversation(bot.id);
    expect(conversation.messages.filter((message) => message.routine?.name === "Queue health")).toHaveLength(2);

    const running = queue.deliveries.find((delivery) => delivery.status === "running");
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(bot.id)?.externalSessionId;
    if (!running?.turnId || !client || !threadId) throw new Error("The routine turn did not start.");
    const routineInput = firstInputText(client.requests.find((request) => request.method === "turn/start")?.params);
    expect(routineInput).toContain("Execute one run of an existing OpenBot routine now.");
    expect(routineInput).toContain("Run type: manual Test run");
    expect(routineInput).toContain("Do not create, update, delete, list, or test routines during this run.");
    expect(routineInput).toContain("Report the action and result");
    expect(routineInput).toContain("Check the current queue health.");
    client.emit("request", {
      id: "routine-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId, turnId: running.turnId, command: "echo routine" },
    });
    await waitFor(() =>
      service
        ?.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .some((run) => run.status === "needs-attention"),
    );
    expect(client.responses).toEqual([]);
    await service.respondToApproval({ requestId: "routine-approval", decision: "accept" });
    expect(service.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "running" })]),
    );
    expect(client.responses).toEqual([
      expect.objectContaining({ id: "routine-approval", result: { decision: "accept" } }),
    ]);

    const queued = queue.deliveries.find((delivery) => delivery.status === "queued");
    if (!queued) throw new Error("The second routine run was not queued.");
    await service.cancelQueuedMessage(bot.id, queued.id);
    expect(
      service.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 }).map((run) => run.status),
    ).toEqual(expect.arrayContaining(["running", "cancelled"]));
    expect(client.requests.some((request) => request.method === "turn/start")).toBe(true);

    client.emit(
      "notification",
      notification("turn/completed", {
        threadId,
        turn: { id: running.turnId, status: "failed" },
      }),
    );
    await waitFor(() =>
      service
        ?.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .some((run) => run.status === "failed"),
    );
    const failedRuntime = service.getRuntimeSnapshot();
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot: failedRuntime })).toBe(true);
    expect(failedRuntime.failedTurns).toEqual([{ botId: bot.id, turnId: running.turnId }]);
    expect(failedRuntime.work).toEqual([
      expect.objectContaining({ id: running.id, botId: bot.id, status: "failed", turnId: running.turnId }),
    ]);
    service.acknowledgeFailedTurn(bot.id, running.turnId);
    expect(service.getRuntimeSnapshot().failedTurns).toEqual([]);
    expect(service.getRuntimeSnapshot().work).toEqual([]);

    await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await waitFor(
      () => service?.listQueue(bot.id).deliveries.filter((delivery) => delivery.status === "running").length === 1,
    );
    const interruptedDelivery = service.listQueue(bot.id).deliveries.find((delivery) => delivery.status === "running");
    if (!interruptedDelivery?.turnId) throw new Error("The interrupted routine turn did not start.");
    client.emit(
      "notification",
      notification("turn/completed", {
        threadId,
        turn: { id: interruptedDelivery.turnId, status: "interrupted" },
      }),
    );
    await waitFor(() =>
      service
        ?.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })
        .some((run) => run.status === "interrupted"),
    );
    const transitionStatuses = (await service.readConversation(bot.id)).messages.flatMap(
      (message) => routineRunConversationEvent(message)?.status ?? [],
    );
    expect(transitionStatuses).toEqual(
      expect.arrayContaining(["running", "needs-attention", "cancelled", "failed", "interrupted"]),
    );
    expect(transitionStatuses.filter((status) => status === "running")).toHaveLength(3);
  });

  it("persists a completed routine turn as terminal", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => new FakeAgentClient(provider),
    );
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      botId: bot.id,
      name: "Queue health",
      instruction: "Check the current queue health.",
      active: true,
      timezone: "Europe/Warsaw",
      schedule: { kind: "daily", time: "09:00" },
    });

    await service.testRoutine({ botId: bot.id, routineId: routine.id });
    await waitFor(() => service?.listQueue(bot.id).deliveries[0]?.status === "completed");

    const turnId = service.listQueue(bot.id).deliveries[0]?.turnId;
    if (!turnId) throw new Error("The completed routine turn did not start.");
    expect(
      store.database.connection
        .prepare("SELECT status, completed_at FROM projection_turns WHERE turn_id = ?")
        .get(turnId),
    ).toMatchObject({ status: "completed", completed_at: expect.any(String) });
    expect((await service.readConversation(bot.id)).activeTurnId).toBeNull();
    expect(
      (await service.readConversation(bot.id)).messages.flatMap(
        (message) => routineRunConversationEvent(message)?.status ?? [],
      ),
    ).toContain("succeeded");
  });

  it("queues only the last missed run after sleep and does not duplicate it after restart", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => new FakeAgentClient(provider),
    );
    await service.initialize();
    const bot = await store.getOrCreate("chief");
    vi.useFakeTimers({ now: new Date("2026-08-25T11:07:00.000Z") });
    const routine = service.createRoutine({
      botId: bot.id,
      name: "Quarter-hour check",
      instruction: "Check the current queue.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "interval", amount: 15, unit: "minutes", anchorAt: "2026-08-25T10:00:00.000Z" },
    });
    store.database.connection
      .prepare("UPDATE projection_routine_triggers SET next_run_at = ? WHERE trigger_id = ?")
      .run("2026-08-25T10:15:00.000Z", routine.trigger.id);
    service.updateRoutine({ botId: bot.id, routineId: routine.id, name: routine.name });
    const routineChanged = nextRoutinesChanged(service, bot.id);

    await vi.advanceTimersByTimeAsync(0);
    await routineChanged;

    expect(service.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })).toEqual([
      expect.objectContaining({ kind: "scheduled", scheduledFor: "2026-08-25T11:00:00.000Z" }),
    ]);
    expect(service.listRoutines(bot.id)[0]?.trigger.nextRunAt).toBe("2026-08-25T11:15:00.000Z");

    await service.stop();
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => new FakeAgentClient(provider),
    );
    await service.initialize();

    expect(service.listRoutineRuns({ botId: bot.id, routineId: routine.id, limit: 10 })).toHaveLength(1);
  });
});

class FakeAgentClient extends EventEmitter implements AgentClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: RequestId; result: unknown }> = [];
  readonly errors: Array<{ id: RequestId; error: RpcError }> = [];
  #threadCounter = 0;
  running = false;
  responseError: Error | null = null;

  constructor(
    readonly provider: AgentProvider,
    readonly output = provider === "codex" ? "CODEX_DONE" : provider === "grok" ? "GROK_DONE" : "CLAUDE_DONE",
    readonly autoComplete = true,
    private accountSignedIn = true,
    private readonly requestDelays: Readonly<Record<string, number>> = {},
    private readonly requestHook?: (method: string, provider: AgentProvider) => Promise<void>,
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
    await this.requestHook?.(method, this.provider);
    const delayMs = this.requestDelays[method] ?? 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let result: unknown;
    if (method === "initialize") result = {};
    if (method === "account/read") {
      result = {
        account: this.accountSignedIn
          ? {
              type: this.provider === "codex" ? "chatgpt" : this.provider,
              email: `${this.provider}@example.com`,
            }
          : null,
        requiresOpenaiAuth: false,
      };
    }
    if (method === "account/login/start") {
      result = { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.test/connect" };
    }
    if (method === "account/login/cancel") result = { status: "cancelled" };
    if (method === "account/rateLimits/read") {
      result = { rateLimits: null, rateLimitsByLimitId: null };
    }
    if (method === "model/list") {
      result = {
        data:
          this.provider === "codex"
            ? ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].map((model) => ({ model }))
            : this.provider === "grok"
              ? ["grok-4.5", "grok-fast"].map((model) => ({ model }))
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

  completeLogin(success: boolean): void {
    this.accountSignedIn = success;
    this.emit(
      "notification",
      notification("account/login/completed", { loginId: "login-1", success, error: success ? null : "denied" }),
    );
  }

  respond(id: RequestId, result: unknown): void {
    if (this.responseError) throw this.responseError;
    this.responses.push({ id, result: structuredClone(result) });
  }

  respondError(id: RequestId, error: RpcError): void {
    this.errors.push({ id, error: structuredClone(error) });
  }
}

async function callOpenBotTool(
  client: FakeAgentClient,
  threadId: string,
  tool: string,
  args: unknown,
  turnId = "routine-tool-turn",
  callId: string = randomUUID(),
): Promise<{ result?: unknown; error?: RpcError }> {
  const id = `openbot-tool-${randomUUID()}`;
  client.emit("request", {
    id,
    method: "item/tool/call",
    params: {
      threadId,
      turnId,
      callId,
      namespace: "openbot",
      tool,
      arguments: args,
    },
  });
  await waitFor(
    () =>
      client.responses.some((response) => response.id === id) || client.errors.some((response) => response.id === id),
  );
  const response = client.responses.find((item) => item.id === id);
  if (response) return { result: response.result };
  return { error: client.errors.find((item) => item.id === id)?.error };
}

function openBotToolPayload(result: unknown): DynamicRecord {
  const contentItems = paramsRecord(result)?.contentItems;
  const text = Array.isArray(contentItems) ? getString(contentItems[0], "text") : null;
  if (!text) throw new Error("The OpenBot tool response has no text payload.");
  const payload = JSON.parse(text);
  if (!isDynamicRecord(payload)) throw new Error("The OpenBot tool response payload is invalid.");
  return payload;
}

async function expectOpenBotToolError(
  client: FakeAgentClient,
  threadId: string,
  tool: string,
  args: unknown,
  message: string,
  turnId?: string,
): Promise<void> {
  const result = await callOpenBotTool(client, threadId, tool, args, turnId);
  expect(result.result).toBeUndefined();
  expect(result.error?.message).toContain(message);
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
  return { store, mailbox: new MailboxStore(join(root, "user-data"), store.sharedRoot, store.database) };
}

function fakeBrowser(tabs: BrowserTab[] = []) {
  return {
    onChanged: (_listener: (tabs: BrowserTab[], activeTabId: string | null) => void) => () => undefined,
    onControlChanged: (_listener: (state: BrowserControlState) => void) => () => undefined,
    clearControls: () => undefined,
    endControl: () => undefined,
    listTabs: () => tabs,
    handleDynamicTool: async (_params: DynamicToolCallParams) => ({ success: true, contentItems: [] }),
  };
}

function nextRoutinesChanged(agentService: AgentService, botId: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (event: AgentEvent) => {
      if (event.type !== "routines-changed" || event.botId !== botId) return;
      agentService.off("event", listener);
      resolve();
    };
    agentService.on("event", listener);
  });
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
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
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
        { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
        { model: "gpt-5.5", displayName: "GPT-5.5" },
        { model: "gpt-5.4", displayName: "GPT-5.4" },
        { model: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
        { model: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark" }
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
  printf '%s\\n' '2.1.246 (Claude Code)'
elif [ "$1" = "auth" ]; then
  printf '%s' '{"loggedIn":true,"email":"claude@example.com","subscriptionType":"max"}'
fi
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function createPendingFakeClaude(directory: string): Promise<string> {
  const executable = join(directory, "claude-pending");
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.246 (Claude Code)'
elif [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  printf '%s\\n' 'started' >> "$OPENBOT_FAKE_CLAUDE_LOGIN_LOG"
  trap 'printf "%s\\n" "stopped" >> "$OPENBOT_FAKE_CLAUDE_LOGIN_LOG"; exit 143' TERM INT
  while :; do sleep 0.1; done
elif [ "$1" = "auth" ]; then
  printf '%s' '{"loggedIn":false}'
fi
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function createFakeGrok(directory: string): Promise<string> {
  const executable = join(directory, "grok");
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'grok 1.0.5'
fi
`,
  );
  await chmod(executable, 0o755);
  return executable;
}
