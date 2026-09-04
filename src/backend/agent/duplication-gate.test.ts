// @vitest-environment node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMemoryStore } from "../agent-memory-store";
import { AgentRoutineStore } from "../agent-routine-store";
import { AgentService } from "../agent-service";
import {
  EMPTY_LAYOUT,
  FakeAgentClient,
  fakeBrowser,
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

describe.sequential("DuplicationGate: copying an agent and the pending window", () => {
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

  it("holds the source queue for the length of the copy, then answers what waited", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      return new FakeAgentClient(provider);
    });
    await service.initialize();
    const source = await store.getOrCreate("chief");
    await writeFile(join(source.workspacePath, "research.md"), "source workspace\n");
    const duplicateInStore = store.duplicateBot.bind(store);
    vi.spyOn(store, "duplicateBot").mockImplementationOnce(async (botId, operationId) => {
      const duplicate = await duplicateInStore(botId, operationId);
      // A message landing while the workspace is still being copied. The source is muted, so
      // nothing schedules a drain for it and only the mute lifting can start this turn.
      await service?.sendMessage({ botId: source.id, text: "Anything on the sources?" });
      expect(service?.listQueue(source.id).deliveries[0]?.status).toBe("queued");
      return duplicate;
    });

    const duplicate = await service.duplicateBot(source.id);
    await service.commitBotDuplication(duplicate.id, EMPTY_LAYOUT);

    await waitFor(() => service?.listQueue(source.id).deliveries[0]?.status === "completed");
    await expect(readFile(join(duplicate.workspacePath, "research.md"), "utf8")).resolves.toBe("source workspace\n");
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
