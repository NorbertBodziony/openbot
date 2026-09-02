// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, isAgentEvent, routineRunConversationEvent } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "./agent-client";
import { AgentService } from "./agent-service";
import {
  createFakeCodex,
  FakeAgentClient,
  fakeBrowser,
  firstInputText,
  notification,
  protocolMessages,
  stores,
  waitFor,
} from "./agent-service-test-harness";
import { getString } from "./protocol";

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

describe.sequential("AgentService: restart", () => {
  it("resumes stored threads and does not replay an uncertain running delivery", async () => {
    const { store, mailbox } = stores(root);
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
    await waitFor(async () => (await protocolMessages(logPath)).some((message) => message.method === "thread/resume"));
    const resume = (await protocolMessages(logPath)).find((message) => message.method === "thread/resume");
    expect(resume?.params).toMatchObject({
      dynamicTools: expect.arrayContaining([
        expect.objectContaining({ type: "namespace", name: "openbot_browser" }),
        expect.objectContaining({ type: "namespace", name: "openbot" }),
      ]),
    });
    expect((await store.getOrCreate("chief")).threadId).toBe(threadId);
  });

  it("expires a persisted question prompt after restart", async () => {
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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

    const requests = await protocolMessages(logPath);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
});
