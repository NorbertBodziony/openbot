// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRoutineStore } from "./agent-routine-store";
import { BotStore } from "./agent-store";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentRoutineStore", () => {
  it("persists a routine, its trigger, and immutable run snapshots", async () => {
    const { database, routines } = await setup();
    const routine = routines.create(
      {
        botId: "chief",
        name: "Morning brief",
        instruction: "Prepare the daily brief.",
        active: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "weekdays", time: "07:00" },
      },
      new Date("2026-08-25T10:00:00.000Z"),
    );
    expect(routine.trigger.schedule).toEqual({ kind: "weekdays", time: "07:00" });

    const run = routines.createRun(routine, routine.trigger.id, "scheduled", "2026-08-26T05:00:00.000Z");
    routines.update({ botId: "chief", routineId: routine.id, name: "Changed name", instruction: "New text" });
    expect(routines.listRuns("chief", routine.id, 10)[0]).toMatchObject({
      id: run.id,
      routineName: "Morning brief",
      instruction: "Prepare the daily brief.",
    });
    database.close();

    const reopened = new OpenBotDatabase(database.userDataPath);
    await reopened.initialize();
    expect(new AgentRoutineStore(reopened).list("chief")).toHaveLength(1);
    reopened.close();
  });

  it("does not create a duplicate scheduled run", async () => {
    const { database, routines } = await setup();
    const routine = routines.create({
      botId: "chief",
      name: "Check queue",
      instruction: "Check the queue.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "hourly", minute: 0 },
    });
    const triggerId = routine.trigger.id;
    const first = routines.createRun(routine, triggerId, "scheduled", "2026-08-25T12:00:00.000Z");
    const second = routines.createRun(routine, triggerId, "scheduled", "2026-08-25T12:00:00.000Z");
    expect(second.id).toBe(first.id);
    expect(routines.listRuns("chief", routine.id, 10)).toHaveLength(1);
    database.close();
  });

  it("skips missed times after a cold start", async () => {
    const { database, routines } = await setup();
    const routine = routines.create(
      {
        botId: "chief",
        name: "Quarter hour",
        instruction: "Run the check.",
        active: true,
        timezone: "UTC",
        schedule: { kind: "interval", amount: 15, unit: "minutes", anchorAt: "2026-08-25T10:00:00.000Z" },
      },
      new Date("2026-08-25T10:00:00.000Z"),
    );
    routines.skipMissed(new Date("2026-08-25T12:07:00.000Z"));
    expect(routines.get("chief", routine.id)?.trigger.nextRunAt).toBe("2026-08-25T12:15:00.000Z");
    expect(routines.listRuns("chief", routine.id, 10)).toEqual([]);
    database.close();
  });

  it("excludes pending agents from due and next-due routine queries", async () => {
    const { database, routines } = await setup();
    const now = new Date("2026-08-25T10:00:00.000Z");
    routines.create(
      {
        botId: "chief",
        name: "Quarter hour",
        instruction: "Run every quarter hour.",
        active: true,
        timezone: "UTC",
        schedule: { kind: "interval", amount: 15, unit: "minutes", anchorAt: now.toISOString() },
      },
      now,
    );
    routines.create(
      {
        botId: "research",
        name: "Half hour",
        instruction: "Run every half hour.",
        active: true,
        timezone: "UTC",
        schedule: { kind: "interval", amount: 30, unit: "minutes", anchorAt: now.toISOString() },
      },
      now,
    );
    const excluded = new Set(["chief"]);

    expect(routines.nextDueAt(excluded)).toBe("2026-08-25T10:30:00.000Z");
    expect(routines.due(new Date("2026-08-25T10:31:00.000Z"), excluded).map((due) => due.routine.botId)).toEqual([
      "research",
    ]);
    database.close();
  });

  it("reschedules a paused routine from the activation time without creating a run", async () => {
    const { database, routines } = await setup();
    const routine = routines.create(
      {
        botId: "chief",
        name: "Morning brief",
        instruction: "Prepare the brief.",
        active: true,
        timezone: "UTC",
        schedule: { kind: "daily", time: "09:00" },
      },
      new Date("2026-08-25T08:00:00.000Z"),
    );
    routines.update({ botId: "chief", routineId: routine.id, active: false }, new Date("2026-08-25T08:30:00.000Z"));

    const resumed = routines.update(
      { botId: "chief", routineId: routine.id, active: true },
      new Date("2026-08-27T10:00:00.000Z"),
    );

    expect(resumed.trigger.id).toBe(routine.trigger.id);
    expect(resumed.trigger.nextRunAt).toBe("2026-08-28T09:00:00.000Z");
    expect(routines.listRuns("chief", routine.id, 10)).toEqual([]);
    database.close();
  });

  it("creates one future trigger when a paused routine is resumed with a new schedule", async () => {
    const { database, routines } = await setup();
    const routine = routines.create(
      {
        botId: "chief",
        name: "Morning brief",
        instruction: "Prepare the brief.",
        active: false,
        timezone: "Europe/Warsaw",
        schedule: { kind: "daily", time: "07:00" },
      },
      new Date("2026-08-25T08:00:00.000Z"),
    );

    const resumed = routines.update(
      {
        botId: "chief",
        routineId: routine.id,
        active: true,
        schedule: { kind: "weekdays", time: "08:15" },
      },
      new Date("2026-08-28T10:00:00.000Z"),
    );

    expect(resumed.trigger.id).not.toBe(routine.trigger.id);
    expect(resumed.trigger.schedule).toEqual({ kind: "weekdays", time: "08:15" });
    expect(resumed.trigger.nextRunAt).toBe("2026-08-31T06:15:00.000Z");
    expect(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM projection_routine_triggers WHERE routine_id = ?")
        .get(routine.id),
    ).toMatchObject({ count: 1 });
    expect(routines.listRuns("chief", routine.id, 10)).toEqual([]);
    database.close();
  });

  it("removes routines when the agent is deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-routine-agent-delete-"));
    roots.push(root);
    const bots = new BotStore(join(root, "data"), join(root, "home"));
    await bots.initialize();
    const bot = await bots.getOrCreate("chief");
    const routines = new AgentRoutineStore(bots.database);
    routines.create({
      botId: bot.id,
      name: "Temporary",
      instruction: "Remove this routine.",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
    });
    await bots.deleteBot(bot.id);
    expect(routines.list(bot.id)).toEqual([]);
    bots.database.close();
  });
});

async function setup(): Promise<{ database: OpenBotDatabase; routines: AgentRoutineStore }> {
  const root = await mkdtemp(join(tmpdir(), "openbot-routine-store-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await database.initialize();
  return { database, routines: new AgentRoutineStore(database) };
}
