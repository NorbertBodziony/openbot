// @vitest-environment node
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentEvent, routineConversationEvent, routineRunConversationEvent } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "./agent-client";
import { AgentService } from "./agent-service";
import {
  callOpenBotTool,
  expectOpenBotToolError,
  FakeAgentClient,
  fakeBrowser,
  notification,
  openBotToolPayload,
  protocolMessages,
  startAgentTestFixture,
  stopAgentTestFixture,
  stores,
  waitFor,
} from "./agent-service-test-harness";

let root: string;
let logPath: string;
let service: AgentService | null = null;

beforeEach(async () => {
  ({ root, logPath } = await startAgentTestFixture());
});

afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});

describe.sequential("AgentService: routines", () => {
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

  it("keeps routine approvals interactive while attention markers retry", async () => {
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

  it("persists a completed routine turn as terminal", async () => {
    const { store, mailbox } = stores(root);
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
    await expectOpenBotToolError(
      client,
      threadId,
      "attach_files_to_response",
      { paths: [screenshotPath, screenshotPath] },
      "Duplicate attachment paths are not allowed.",
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
    const deliveryId = service.listQueue("chief").deliveries[0]?.id;

    // The fake answers `turn/start` on a delay, so a second completed turn is the
    // barrier proving the first turn's late start response was already written and
    // processed: both responses travel the same pipe, in order.
    await service.sendMessage({ botId: "chief", text: "Run once more" });
    await waitFor(
      () => service?.listQueue("chief").deliveries.filter((entry) => entry.status === "completed").length === 2,
    );

    const delivery = service.listQueue("chief").deliveries.find((entry) => entry.id === deliveryId);
    if (!delivery?.turnId) throw new Error("The completed delivery did not have a turn.");
    expect((await service.readConversation("chief")).activeTurnId).toBeNull();
    expect(
      store.database.connection
        .prepare("SELECT status, completed_at FROM projection_turns WHERE turn_id = ?")
        .get(delivery.turnId),
    ).toMatchObject({ status: "completed", completed_at: expect.any(String) });
  });
});
