import { randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  CreateRoutineInput,
  Routine,
  RoutineRun,
  RoutineRunStatus,
  RoutineSchedule,
  UpdateRoutineInput,
} from "@openbot/contracts/ipc";
import { isRoutineSchedule } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { OpenBotDatabase } from "./openbot-database";
import { nextRoutineOccurrence, normalizeRoutineSchedule, validateRoutineSchedule } from "./routine-schedule";

export interface DueRoutineTrigger {
  routine: Routine;
  triggerId: string;
  nextRunAt: string;
  schedule: RoutineSchedule;
}

export class AgentRoutineStore {
  constructor(private readonly database: OpenBotDatabase) {}

  list(agentId: string): Routine[] {
    return rows(
      this.database.connection
        .prepare(
          `SELECT routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at
           FROM projection_agent_routines WHERE agent_id = ? ORDER BY updated_at DESC, routine_id`,
        )
        .all(agentId),
    ).map((row) => this.#routine(row));
  }

  get(agentId: string, routineId: string): Routine | null {
    const row = this.database.connection
      .prepare(
        `SELECT routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at
         FROM projection_agent_routines WHERE routine_id = ? AND agent_id = ?`,
      )
      .get(routineId, agentId);
    return isDynamicRecord(row) ? this.#routine(row) : null;
  }

  duplicate(sourceAgentId: string, targetAgentId: string, now = new Date()): Map<string, Routine> {
    const duplicated = new Map<string, Routine>();
    for (const routine of this.list(sourceAgentId)) {
      duplicated.set(
        routine.id,
        this.create(
          {
            agentId: targetAgentId,
            name: routine.name,
            instruction: routine.instruction,
            active: routine.active,
            timezone: routine.timezone,
            schedule: routine.trigger.schedule,
          },
          now,
        ),
      );
    }
    return duplicated;
  }

  create(input: CreateRoutineInput, now = new Date()): Routine {
    this.#validateInput(input.name, input.instruction, input.timezone, input.schedule);
    if (this.list(input.agentId).length >= INPUT_LIMITS.agentRoutines) {
      throw new Error(`An agent can have at most ${INPUT_LIMITS.agentRoutines} routines.`);
    }
    const routineId = randomUUID();
    const createdAt = now.toISOString();
    const schedule = normalizeRoutineSchedule(input.schedule, now);
    return this.database.dispatch(
      `routine:create:${routineId}`,
      [{ aggregateType: "agent-routine", aggregateId: routineId, eventType: "routine.created", payload: input }],
      (db, sequences) => {
        const sequence = sequences[0] ?? 0;
        db.prepare(
          `INSERT INTO projection_agent_routines (
             routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at, last_event_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          routineId,
          input.agentId,
          input.name.trim(),
          input.instruction.trim(),
          input.active ? 1 : 0,
          input.timezone,
          createdAt,
          createdAt,
          sequence,
        );
        this.#insertTrigger(db, routineId, input.timezone, schedule, createdAt, sequence, now);
        return this.#require(routineId, input.agentId);
      },
    );
  }

  update(input: UpdateRoutineInput, now = new Date()): Routine {
    const current = this.get(input.agentId, input.routineId);
    if (!current) throw new Error("This routine no longer exists.");
    const name = input.name ?? current.name;
    const instruction = input.instruction ?? current.instruction;
    const schedule = normalizeRoutineSchedule(input.schedule ?? current.trigger.schedule, now);
    this.#validateInput(name, instruction, current.timezone, schedule);
    const active = input.active ?? current.active;
    const reactivating = !current.active && active;
    const updatedAt = now.toISOString();
    return this.database.dispatch(
      `routine:update:${input.routineId}:${randomUUID()}`,
      [
        {
          aggregateType: "agent-routine",
          aggregateId: input.routineId,
          eventType: "routine.updated",
          payload: input,
        },
      ],
      (db, sequences) => {
        const sequence = sequences[0] ?? 0;
        db.prepare(
          `UPDATE projection_agent_routines
           SET name = ?, instruction = ?, active = ?, updated_at = ?, last_event_sequence = ?
           WHERE routine_id = ? AND agent_id = ?`,
        ).run(name.trim(), instruction.trim(), active ? 1 : 0, updatedAt, sequence, input.routineId, input.agentId);
        if (input.schedule) {
          db.prepare("DELETE FROM projection_routine_triggers WHERE routine_id = ?").run(input.routineId);
          this.#insertTrigger(db, input.routineId, current.timezone, schedule, updatedAt, sequence, now);
        } else if (reactivating) {
          db.prepare(
            `UPDATE projection_routine_triggers
             SET next_run_at = ?, updated_at = ?, last_event_sequence = ?
             WHERE trigger_id = ? AND routine_id = ?`,
          ).run(
            nextRoutineOccurrence(schedule, current.timezone, now).toISOString(),
            updatedAt,
            sequence,
            current.trigger.id,
            input.routineId,
          );
        }
        return this.#require(input.routineId, input.agentId);
      },
    );
  }

  delete(agentId: string, routineId: string): void {
    if (!this.get(agentId, routineId)) throw new Error("This routine no longer exists.");
    this.database.dispatch(
      `routine:delete:${routineId}:${randomUUID()}`,
      [{ aggregateType: "agent-routine", aggregateId: routineId, eventType: "routine.deleted", payload: { agentId } }],
      (db) => {
        db.prepare("DELETE FROM projection_agent_routines WHERE routine_id = ? AND agent_id = ?").run(
          routineId,
          agentId,
        );
        return null;
      },
    );
  }

  listRuns(agentId: string, routineId: string, limit = 50): RoutineRun[] {
    const safeLimit = Math.max(1, Math.min(INPUT_LIMITS.routineRunsPage, limit));
    return rows(
      this.database.connection
        .prepare(
          `SELECT run_id, routine_id, agent_id, trigger_id, run_kind, scheduled_for, routine_name,
                  instruction, delivery_id, status, error, created_at, updated_at
           FROM projection_routine_runs
           WHERE routine_id = ? AND agent_id = ?
           ORDER BY created_at DESC, run_id DESC LIMIT ?`,
        )
        .all(routineId, agentId, safeLimit),
    ).map(decodeRun);
  }

  pendingRuns(): RoutineRun[] {
    return rows(
      this.database.connection
        .prepare(
          `SELECT run_id, routine_id, agent_id, trigger_id, run_kind, scheduled_for, routine_name,
                  instruction, delivery_id, status, error, created_at, updated_at
           FROM projection_routine_runs WHERE status = 'queued' AND delivery_id IS NULL
           ORDER BY created_at, run_id`,
        )
        .all(),
    ).map(decodeRun);
  }

  activeRuns(agentId: string, routineId: string): RoutineRun[] {
    return rows(
      this.database.connection
        .prepare(
          `SELECT run_id, routine_id, agent_id, trigger_id, run_kind, scheduled_for, routine_name,
                  instruction, delivery_id, status, error, created_at, updated_at
           FROM projection_routine_runs
           WHERE routine_id = ? AND agent_id = ? AND status IN ('queued', 'running', 'needs-attention')
           ORDER BY created_at, run_id`,
        )
        .all(routineId, agentId),
    ).map(decodeRun);
  }

  due(now = new Date(), excludedAgentIds: ReadonlySet<string> = new Set()): DueRoutineTrigger[] {
    return rows(
      this.database.connection
        .prepare(
          `SELECT trigger.trigger_id, trigger.next_run_at, trigger.schedule_json, routine.routine_id,
                  routine.agent_id, routine.name, routine.instruction, routine.active, routine.timezone,
                  routine.created_at, routine.updated_at
           FROM projection_routine_triggers trigger
           JOIN projection_agent_routines routine ON routine.routine_id = trigger.routine_id
           WHERE routine.active = 1 AND trigger.next_run_at <= ?
           ORDER BY trigger.next_run_at, trigger.trigger_id`,
        )
        .all(now.toISOString()),
    )
      .map((row) => {
        const routine = this.#routine(row);
        const schedule = scheduleColumn(row);
        return {
          routine,
          triggerId: stringColumn(row, "trigger_id"),
          nextRunAt: stringColumn(row, "next_run_at"),
          schedule,
        };
      })
      .filter((due) => !excludedAgentIds.has(due.routine.agentId));
  }

  nextDueAt(excludedAgentIds: ReadonlySet<string> = new Set()): string | null {
    const row = rows(
      this.database.connection
        .prepare(
          `SELECT trigger.next_run_at, routine.agent_id
         FROM projection_routine_triggers trigger
         JOIN projection_agent_routines routine ON routine.routine_id = trigger.routine_id
         WHERE routine.active = 1
         ORDER BY trigger.next_run_at, trigger.trigger_id`,
        )
        .all(),
    ).find((candidate) => !excludedAgentIds.has(stringColumn(candidate, "agent_id")));
    return row && isString(row.next_run_at) ? row.next_run_at : null;
  }

  advanceTrigger(routineId: string, triggerId: string, nextRunAt: string): void {
    this.database.dispatch(
      `routine-trigger:advance:${triggerId}:${nextRunAt}`,
      [
        {
          aggregateType: "agent-routine",
          aggregateId: routineId,
          eventType: "routine.trigger-advanced",
          payload: { triggerId, nextRunAt },
        },
      ],
      (db, sequences) => {
        db.prepare(
          `UPDATE projection_routine_triggers SET next_run_at = ?, updated_at = ?, last_event_sequence = ?
           WHERE trigger_id = ? AND routine_id = ?`,
        ).run(nextRunAt, new Date().toISOString(), sequences[0] ?? 0, triggerId, routineId);
        return null;
      },
    );
  }

  skipMissed(now = new Date()): void {
    for (const routine of this.#allActive()) {
      const next = nextRoutineOccurrence(routine.trigger.schedule, routine.timezone, now).toISOString();
      this.advanceTrigger(routine.id, routine.trigger.id, next);
    }
  }

  createRun(routine: Routine, triggerId: string | null, kind: RoutineRun["kind"], scheduledFor: string): RoutineRun {
    const commandId = triggerId
      ? `routine-run:scheduled:${triggerId}:${scheduledFor}`
      : `routine-run:manual:${routine.id}:${randomUUID()}`;
    const runId = randomUUID();
    const createdAt = new Date().toISOString();
    return this.database.dispatch(
      commandId,
      [
        {
          aggregateType: "routine-run",
          aggregateId: routine.id,
          eventType: "routine.run-created",
          payload: { runId, triggerId, kind, scheduledFor },
        },
      ],
      (db, sequences) => {
        db.prepare(
          `INSERT INTO projection_routine_runs (
             run_id, routine_id, agent_id, trigger_id, run_kind, scheduled_for, routine_name, instruction,
             delivery_id, status, error, created_at, updated_at, last_event_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', NULL, ?, ?, ?)`,
        ).run(
          runId,
          routine.id,
          routine.agentId,
          triggerId,
          kind,
          scheduledFor,
          routine.name,
          routine.instruction,
          createdAt,
          createdAt,
          sequences[0] ?? 0,
        );
        return this.#requireRun(runId);
      },
    );
  }

  attachDelivery(runId: string, deliveryId: string): RoutineRun {
    return this.#mutateRun(runId, "routine.run-queued", (db, sequence, now) => {
      db.prepare(
        `UPDATE projection_routine_runs SET delivery_id = ?, status = 'queued', error = NULL,
                updated_at = ?, last_event_sequence = ? WHERE run_id = ?`,
      ).run(deliveryId, now, sequence, runId);
    });
  }

  updateRunStatus(runId: string, status: RoutineRunStatus, error: string | null = null): RoutineRun {
    const current = this.#requireRun(runId);
    if (current.status === status && current.error === error) return current;
    return this.#mutateRun(runId, `routine.run-${status}`, (db, sequence, now) => {
      db.prepare(
        `UPDATE projection_routine_runs SET status = ?, error = ?, updated_at = ?, last_event_sequence = ?
         WHERE run_id = ?`,
      ).run(status, error, now, sequence, runId);
    });
  }

  runForDelivery(deliveryId: string): RoutineRun | null {
    const row = this.database.connection
      .prepare(
        `SELECT run_id, routine_id, agent_id, trigger_id, run_kind, scheduled_for, routine_name,
                instruction, delivery_id, status, error, created_at, updated_at
         FROM projection_routine_runs WHERE delivery_id = ?`,
      )
      .get(deliveryId);
    return isDynamicRecord(row) ? decodeRun(row) : null;
  }

  #allActive(): Routine[] {
    return rows(
      this.database.connection
        .prepare(
          `SELECT routine_id, agent_id, name, instruction, active, timezone, created_at, updated_at
           FROM projection_agent_routines WHERE active = 1`,
        )
        .all(),
    ).map((row) => this.#routine(row));
  }

  #routine(row: DynamicRecord): Routine {
    const routineId = stringColumn(row, "routine_id");
    return {
      id: routineId,
      agentId: stringColumn(row, "agent_id"),
      name: stringColumn(row, "name"),
      instruction: stringColumn(row, "instruction"),
      active: numberColumn(row, "active") === 1,
      timezone: stringColumn(row, "timezone"),
      trigger: (() => {
        const trigger = this.database.connection
          .prepare(
            `SELECT trigger_id, routine_id, schedule_json, next_run_at, created_at, updated_at
             FROM projection_routine_triggers WHERE routine_id = ?`,
          )
          .get(routineId);
        if (!isDynamicRecord(trigger)) throw new Error("The routine trigger projection could not be read.");
        return {
          id: stringColumn(trigger, "trigger_id"),
          routineId,
          schedule: scheduleColumn(trigger),
          nextRunAt: stringColumn(trigger, "next_run_at"),
          createdAt: stringColumn(trigger, "created_at"),
          updatedAt: stringColumn(trigger, "updated_at"),
        };
      })(),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
    };
  }

  #require(routineId: string, agentId: string): Routine {
    const routine = this.get(agentId, routineId);
    if (!routine) throw new Error("The routine projection could not be read.");
    return routine;
  }

  #requireRun(runId: string): RoutineRun {
    const row = this.database.connection
      .prepare(
        `SELECT run_id, routine_id, agent_id, trigger_id, run_kind, scheduled_for, routine_name,
                instruction, delivery_id, status, error, created_at, updated_at
         FROM projection_routine_runs WHERE run_id = ?`,
      )
      .get(runId);
    if (!isDynamicRecord(row)) throw new Error("The routine run no longer exists.");
    return decodeRun(row);
  }

  #mutateRun(
    runId: string,
    eventType: string,
    mutate: (db: OpenBotDatabase["connection"], sequence: number, now: string) => void,
  ): RoutineRun {
    const current = this.#requireRun(runId);
    return this.database.dispatch(
      `routine-run:update:${runId}:${randomUUID()}`,
      [{ aggregateType: "routine-run", aggregateId: current.routineId, eventType, payload: { runId } }],
      (db, sequences) => {
        mutate(db, sequences[0] ?? 0, new Date().toISOString());
        return this.#requireRun(runId);
      },
    );
  }

  #insertTrigger(
    db: OpenBotDatabase["connection"],
    routineId: string,
    timezone: string,
    schedule: RoutineSchedule,
    timestamp: string,
    sequence: number,
    now: Date,
  ): void {
    db.prepare(
      `INSERT INTO projection_routine_triggers (
         trigger_id, routine_id, schedule_json, next_run_at, created_at, updated_at, last_event_sequence
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      routineId,
      JSON.stringify(schedule),
      nextRoutineOccurrence(schedule, timezone, now).toISOString(),
      timestamp,
      timestamp,
      sequence,
    );
  }

  #validateInput(name: string, instruction: string, timezone: string, schedule: RoutineSchedule): void {
    const normalizedName = name.trim();
    const normalizedInstruction = instruction.trim();
    if (!normalizedName) throw new Error("A routine name is required.");
    if (name.length > INPUT_LIMITS.routineName) throw new Error("The routine name is too long.");
    if (!normalizedInstruction) throw new Error("A routine instruction is required.");
    if (instruction.length > INPUT_LIMITS.routineInstruction) throw new Error("The routine instruction is too long.");
    validateRoutineSchedule(schedule, timezone);
  }
}

function decodeRun(row: DynamicRecord): RoutineRun {
  const status = stringColumn(row, "status");
  if (!isRoutineRunStatus(status)) throw new Error("The stored routine run status is invalid.");
  const kind = stringColumn(row, "run_kind");
  if (kind !== "scheduled" && kind !== "manual") throw new Error("The stored routine run kind is invalid.");
  return {
    id: stringColumn(row, "run_id"),
    routineId: stringColumn(row, "routine_id"),
    agentId: stringColumn(row, "agent_id"),
    triggerId: nullableStringColumn(row, "trigger_id"),
    kind,
    scheduledFor: stringColumn(row, "scheduled_for"),
    routineName: stringColumn(row, "routine_name"),
    instruction: stringColumn(row, "instruction"),
    deliveryId: nullableStringColumn(row, "delivery_id"),
    status,
    error: nullableStringColumn(row, "error"),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

function scheduleColumn(row: DynamicRecord): RoutineSchedule {
  const value = JSON.parse(stringColumn(row, "schedule_json"));
  if (!isRoutineSchedule(value)) throw new Error("The stored routine schedule is invalid.");
  return value;
}

function rows(values: unknown[]): DynamicRecord[] {
  return values.map((value) => {
    if (!isDynamicRecord(value)) throw new Error("A routine database row is invalid.");
    return value;
  });
}

function stringColumn(row: DynamicRecord, key: string): string {
  const value = row[key];
  if (!isString(value)) throw new Error(`The routine ${key} column is invalid.`);
  return value;
}

function nullableStringColumn(row: DynamicRecord, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return stringColumn(row, key);
}

function numberColumn(row: DynamicRecord, key: string): number {
  const value = row[key];
  if (!isNumber(value)) throw new Error(`The routine ${key} column is invalid.`);
  return value;
}

function isRoutineRunStatus(value: string): value is RoutineRunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "needs-attention" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "cancelled"
  );
}
