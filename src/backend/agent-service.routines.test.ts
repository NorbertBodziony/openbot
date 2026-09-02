// @vitest-environment node
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, routineConversationEvent, routineRunConversationEvent } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "./agent-client";
import { AgentService } from "./agent-service";
import {
  callOpenBotTool,
  createFakeCodex,
  expectOpenBotToolError,
  FakeAgentClient,
  fakeBrowser,
  openBotToolPayload,
  protocolMessages,
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

describe.sequential("AgentService: routines", () => {
  it("lets an agent manage routines for itself and another agent", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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

  it("rolls back a routine transition and retries without a duplicate marker", async () => {
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
    expect((await protocolMessages(logPath)).filter((message) => message.method === "thread/read")).toHaveLength(0);
  });

  it("does not fail or replay a turn whose start response times out after lifecycle events", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "Finished despite the late response";
    process.env.OPENBOT_FAKE_TURN_START_RESPONSE_DELAY = "250";
    const { store, mailbox } = stores(root);
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
    expect((await protocolMessages(logPath)).filter((message) => message.method === "turn/start")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "delivery_start_unconfirmed" }));
  });

  it("keeps a completed turn idle when its start response arrives after lifecycle events", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "Finished before the start response";
    process.env.OPENBOT_FAKE_TURN_START_RESPONSE_DELAY = "100";
    const { store, mailbox } = stores(root);
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

  it("rolls back a routine mutation when its transcript marker cannot persist", async () => {
    const { store, mailbox } = stores(root);
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
    const { store, mailbox } = stores(root);
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
});
