// @vitest-environment node
import { routineConversationEvent, routineRunConversationEvent } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "../agent-client";
import { AgentService } from "../agent-service";
import {
  callOpenBotTool,
  expectOpenBotToolError,
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

describe.sequential("RoutineScheduler: routine mutations, runs and tools", () => {
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
    await service.sendMessage({ agentId: "chief", text: "Manage our routines." });
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
      agentId: "chief",
      name: "Morning brief",
      active: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });

    const otherCreate = await callOpenBotTool(client, threadId, "create_routine", {
      agentId: "design",
      name: "Weekly review",
      instruction: "Review the current design work.",
      active: false,
      timezone: "UTC",
      schedule: { kind: "weekly", weekday: 1, time: "10:30" },
    });
    expect(otherCreate.error).toBeUndefined();
    const otherRoutine = openBotToolPayload(otherCreate.result);
    expect(otherRoutine).toMatchObject({ agentId: "design", active: false, timezone: "UTC" });

    const listResult = await callOpenBotTool(client, threadId, "list_routines", { agentId: "design" });
    expect(openBotToolPayload(listResult.result).routines).toEqual([
      expect.objectContaining({ id: otherRoutine.id, name: "Weekly review" }),
    ]);

    const updated = await callOpenBotTool(client, threadId, "update_routine", {
      agentId: "design",
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
      agentId: "design",
      routineId: otherRoutine.id,
    });
    expect(openBotToolPayload(testRun.result)).toMatchObject({
      routineId: otherRoutine.id,
      agentId: "design",
      kind: "manual",
      status: "queued",
    });

    const deleted = await callOpenBotTool(client, threadId, "delete_routine", { routineId: ownRoutine.id });
    expect(openBotToolPayload(deleted.result)).toEqual({
      deleted: true,
      agentId: "chief",
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
  it("appends a cancellation marker before deleting an active routine run", async () => {
    const { store, mailbox } = stores(root);
    let client: FakeAgentClient | undefined;
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      client = new FakeAgentClient(provider, "", false);
      return client;
    });
    await service.initialize();
    const agent = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      agentId: agent.id,
      name: "Active routine",
      instruction: "Remain active until deletion.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    const run = await service.testRoutine({ agentId: agent.id, routineId: routine.id });
    await waitFor(() =>
      service
        ?.listRoutineRuns({ agentId: agent.id, routineId: routine.id, limit: 10 })
        .some((candidate) => candidate.id === run.id && candidate.status === "running"),
    );
    const runningDelivery = service.listQueue(agent.id).deliveries.find((delivery) => delivery.status === "running");
    if (!runningDelivery?.turnId || !client) throw new Error("The active routine turn did not start.");

    await service.deleteRoutine({ agentId: agent.id, routineId: routine.id });

    expect(client.requests).toContainEqual(
      expect.objectContaining({
        method: "turn/interrupt",
        params: expect.objectContaining({ turnId: runningDelivery.turnId }),
      }),
    );
    const events = (await service.readConversation(agent.id)).messages.flatMap(
      (message) => routineRunConversationEvent(message) ?? [],
    );
    expect(events).toContainEqual(
      expect.objectContaining({ routineId: routine.id, runId: run.id, status: "cancelled" }),
    );
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
    const agent = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      agentId: agent.id,
      name: "Atomic run",
      instruction: "Keep run state and history together.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    await service.testRoutine({ agentId: agent.id, routineId: routine.id });
    await service.testRoutine({ agentId: agent.id, routineId: routine.id });
    await waitFor(() => service?.listQueue(agent.id).deliveries.some((delivery) => delivery.status === "queued"));
    const queued = service.listQueue(agent.id).deliveries.find((delivery) => delivery.status === "queued");
    if (!queued) throw new Error("The queued routine delivery is missing.");
    const queuedRun = service
      .listRoutineRuns({ agentId: agent.id, routineId: routine.id, limit: 10 })
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

    await expect(service.cancelQueuedMessage(agent.id, queued.id)).rejects.toThrow(
      "transition marker persistence failed",
    );
    expect(
      service
        .listRoutineRuns({ agentId: agent.id, routineId: routine.id, limit: 10 })
        .find((run) => run.deliveryId === queued.id),
    ).toMatchObject({ status: "queued" });
    const cancelledMarkers = async () =>
      (await service?.readConversation(agent.id))?.messages.filter((message) => {
        const event = routineRunConversationEvent(message);
        return event?.runId === queuedRun.id && event.status === "cancelled";
      }) ?? [];

    await service.stop();
    service = createService();
    await service.initialize();

    expect(
      service
        .listRoutineRuns({ agentId: agent.id, routineId: routine.id, limit: 10 })
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
    await service.sendMessage({ agentId: "chief", text: "Validate routine requests." });
    await waitFor(() => Boolean(store.activeProviderSession("chief")));

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    if (!client || !threadId) throw new Error("The routine validation test thread did not start.");

    await expectOpenBotToolError(client, threadId, "list_routines", { agentId: "missing" }, "Unknown agent");
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
      agentId: "chief",
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
      { agentId: "design", routineId: routine.id, active: false },
      "routine no longer exists",
    );
  });
  it("rolls back a routine mutation when its transcript marker cannot persist", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    const agent = await store.getOrCreate("chief");
    const initialAgent = store.list().find((candidate) => candidate.id === agent.id);
    vi.spyOn(store.database, "persistConversation").mockImplementationOnce(() => {
      throw new Error("conversation persistence failed");
    });

    expect(() =>
      service?.createRoutine({
        agentId: agent.id,
        name: "Atomic routine",
        instruction: "Do not persist half of this change.",
        active: true,
        timezone: "UTC",
        schedule: { kind: "daily", time: "09:00" },
      }),
    ).toThrow("conversation persistence failed");
    expect(service.listRoutines(agent.id)).toEqual([]);
    expect((await service.readConversation(agent.id)).messages).toEqual([]);
    expect(store.list().find((candidate) => candidate.id === agent.id)).toMatchObject({
      threadId: initialAgent?.threadId ?? null,
      updatedAt: initialAgent?.updatedAt ?? null,
    });
  });
  it("restores queued routine work when a delete marker cannot persist", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    const agent = await store.getOrCreate("chief");
    const routine = service.createRoutine({
      agentId: agent.id,
      name: "Queued routine",
      instruction: "Keep this queued when deletion fails.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    await service.testRoutine({ agentId: agent.id, routineId: routine.id });
    await service.testRoutine({ agentId: agent.id, routineId: routine.id });
    await waitFor(() => service?.listQueue(agent.id).deliveries.some((delivery) => delivery.status === "queued"));
    const queuedDelivery = service.listQueue(agent.id).deliveries.find((delivery) => delivery.status === "queued");
    if (!queuedDelivery) throw new Error("The queued routine delivery is missing.");
    const queuedRun = service
      .listRoutineRuns({ agentId: agent.id, routineId: routine.id, limit: 10 })
      .find((run) => run.deliveryId === queuedDelivery.id);
    if (!queuedRun) throw new Error("The queued routine run is missing.");
    const persistConversation = store.database.persistConversation.bind(store.database);
    vi.spyOn(store.database, "persistConversation").mockImplementation((...args) => {
      if (args[1] === "routine.deleted") throw new Error("delete marker persistence failed");
      return persistConversation(...args);
    });

    await expect(service.deleteRoutine({ agentId: agent.id, routineId: routine.id })).rejects.toThrow(
      "delete marker persistence failed",
    );
    expect(service.listRoutines(agent.id)).toEqual([expect.objectContaining({ id: routine.id })]);
    const restoredDelivery = service
      .listQueue(agent.id)
      .deliveries.find((delivery) => delivery.id === queuedDelivery.id);
    expect(restoredDelivery).toBeDefined();
    expect(["queued", "starting", "running"]).toContain(restoredDelivery?.status);
    const restoredRun = service
      .listRoutineRuns({ agentId: agent.id, routineId: routine.id, limit: 10 })
      .find((run) => run.id === queuedRun.id);
    expect(restoredRun).toBeDefined();
    expect(["queued", "running"]).toContain(restoredRun?.status);
    await waitFor(() =>
      service
        ?.listRoutineRuns({ agentId: agent.id, routineId: routine.id, limit: 10 })
        .some((run) => run.status === "interrupted"),
    );
    expect(service.listRoutineRuns({ agentId: agent.id, routineId: routine.id, limit: 10 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "interrupted" })]),
    );
  });
});
