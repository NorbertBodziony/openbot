import { randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentEvent,
  AgentSummary,
  ConversationMessage,
  ConversationSnapshot,
  CreateRoutineInput,
  DeleteRoutineInput,
  ListRoutineRunsInput,
  QueueDelivery,
  Routine,
  RoutineConversationEventAction,
  RoutineRun,
  RoutineRunConversationEventStatus,
  TestRoutineInput,
  UpdateRoutineInput,
} from "@openbot/contracts/ipc";
import { routineConversationEventItemType, routineRunConversationEventItemType } from "@openbot/contracts/ipc";
import { isBoolean } from "@openbot/contracts/runtime-values";
import { AgentRoutineStore } from "../agent-routine-store";
import type { AgentStore } from "../agent-store";
import { sortConversationMessages } from "../conversation-snapshots";
import type { MailboxStore } from "../mailbox-store";
import type { DynamicToolCallParams } from "../protocol";
import { nextRoutineOccurrence } from "../routine-schedule";
import { type ConversationRuntime, withDatabaseTransaction } from "./conversation-runtime";
import { routineStatusForDelivery } from "./delivery-content";
import {
  localTimezone,
  type OpenBotToolResponse,
  openBotToolResult,
  routineToolAgentId,
  routineToolArguments,
  routineToolSchedule,
  routineToolString,
} from "./routine-tools";

export interface RoutineMutationOptions {
  recordConversationEvent?: boolean;
  turnId?: string;
}

/**
 * What the scheduler needs from the rest of the service. Every one of these is a *write* back into
 * a domain the scheduler does not own — the read side goes through `store`, `mailbox` and
 * `conversation` directly.
 */
export interface RoutineHooks {
  emit(event: AgentEvent): void;
  emitError(code: string, error: unknown, agentId?: string): void;
  emitQueue(agentId: string): void;
  scheduleDrain(agentId: string): void;
  interrupt(agentId: string, turnId: string): Promise<void>;
  /** The in-flight drain for a agent, so a deletion can wait for a run that is still starting. */
  awaitDrain(agentId: string): Promise<void> | undefined;
  syncMailboxMessages(snapshot: ConversationSnapshot): void;
  listAgents(): AgentSummary[];
  /**
   * Agents mid-duplication, which never fire: a half-copied agent is not yet a running one, and its
   * routines would otherwise start against a workspace that is still being written.
   */
  pendingDuplicateAgents(): ReadonlySet<string>;
  /** The timer only arms while the service is initialized and not stopping. */
  isRunning(): boolean;
}

export interface RoutineSchedulerOptions {
  store: AgentStore;
  mailbox: MailboxStore;
  conversation: ConversationRuntime;
  hooks: RoutineHooks;
}

/**
 * Owns standing instructions attached to an agent: the routine rows, their runs, and the single
 * timer that fires the next due one.
 *
 * One timer, not one per routine, is the whole design: `nextDueAt` asks the store for the earliest
 * due time across every routine and arms once, so adding, editing, deleting or duplicating a
 * routine all end in `arm()` re-deriving that time rather than in per-routine bookkeeping that can
 * drift from the rows.
 *
 * It also implements the `RoutineAttention` port that `AttentionRegistry` declares: a routine run
 * blocked on a question is `needs-attention`, and answering returns it to `running`. That is why a
 * user can tell a stalled routine from a working one.
 */
export class RoutineScheduler {
  readonly #store: AgentStore;
  readonly #mailbox: MailboxStore;
  readonly #conversation: ConversationRuntime;
  readonly #hooks: RoutineHooks;
  readonly #routines: AgentRoutineStore;
  /**
   * A deletion has to interrupt live runs before it can remove their routine, so it holds the agent
   * out of the drain loop while it does — otherwise the queue starts the next delivery for a
   * routine that is halfway deleted.
   */
  readonly #deletionAgents = new Set<string>();
  #timer: NodeJS.Timeout | null = null;

  constructor(options: RoutineSchedulerOptions) {
    this.#store = options.store;
    this.#mailbox = options.mailbox;
    this.#conversation = options.conversation;
    this.#hooks = options.hooks;
    this.#routines = new AgentRoutineStore(options.store.database);
  }

  /** The scheduler's clause in the drain mute registry. */
  mayDrain(agentId: string): boolean {
    return !this.#deletionAgents.has(agentId);
  }

  list(agentId: string): Routine[] {
    this.#conversation.requireKnownAgent(agentId);
    return this.#routines.list(agentId);
  }

  /** Unchecked read for callers that already hold the agent, such as the duplication signature. */
  listFor(agentId: string): Routine[] {
    return this.#routines.list(agentId);
  }

  runForDelivery(deliveryId: string): RoutineRun | null {
    return this.#routines.runForDelivery(deliveryId);
  }

  duplicate(sourceAgentId: string, targetAgentId: string, now: Date): Map<string, Routine> {
    return this.#routines.duplicate(sourceAgentId, targetAgentId, now);
  }

  skipMissed(now: Date): void {
    this.#routines.skipMissed(now);
  }

  create(input: CreateRoutineInput, options: RoutineMutationOptions = {}): Routine {
    this.#conversation.requireKnownAgent(input.agentId);
    const routine =
      options.recordConversationEvent === false
        ? this.#routines.create(input)
        : this.#mutateWithConversation(
            input.agentId,
            "created",
            () => this.#routines.create(input),
            (created) => created,
            options.turnId,
          );
    this.stateChanged(input.agentId);
    this.arm();
    return routine;
  }

  update(input: UpdateRoutineInput, options: RoutineMutationOptions = {}): Routine {
    this.#conversation.requireKnownAgent(input.agentId);
    const routine =
      options.recordConversationEvent === false
        ? this.#routines.update(input)
        : this.#mutateWithConversation(
            input.agentId,
            "updated",
            () => this.#routines.update(input),
            (updated) => updated,
            options.turnId,
          );
    this.stateChanged(input.agentId);
    this.arm();
    return routine;
  }

  async delete(input: DeleteRoutineInput, options: RoutineMutationOptions = {}): Promise<void> {
    this.#conversation.requireKnownAgent(input.agentId);
    const routine = this.#routines.get(input.agentId, input.routineId);
    if (!routine) throw new Error("This routine no longer exists.");
    if (this.#deletionAgents.has(input.agentId)) {
      throw new Error("Another routine deletion is already in progress for this agent.");
    }
    this.#deletionAgents.add(input.agentId);
    try {
      const activeRuns = await this.#interruptRunsBeforeDeletion(
        input.agentId,
        this.#routines.activeRuns(input.agentId, input.routineId),
      );
      if (options.recordConversationEvent === false) {
        withDatabaseTransaction(
          this.#store.database,
          () => {
            for (const run of activeRuns) {
              if (run.status === "queued" && run.deliveryId) {
                if (this.#mailbox.getDelivery(run.deliveryId)?.delivery.status === "queued") {
                  this.#mailbox.cancelNow(input.agentId, run.deliveryId);
                }
              }
              this.#routines.updateRunStatus(run.id, "cancelled");
            }
            this.#routines.delete(input.agentId, input.routineId);
          },
          // Deliberately narrower than the conversation variants: this branch records no
          // conversation event, so there is no snapshot to restore — only the mailbox.
          () => this.#mailbox.restorePersistedState(),
        );
      } else {
        this.#mutateWithConversation(
          input.agentId,
          "deleted",
          () => this.#routines.delete(input.agentId, input.routineId),
          () => routine,
          options.turnId,
          {
            beforeMutate: (snapshot) => {
              for (const run of activeRuns) {
                if (run.status === "queued" && run.deliveryId) {
                  if (this.#mailbox.getDelivery(run.deliveryId)?.delivery.status === "queued") {
                    this.#mailbox.cancelNow(input.agentId, run.deliveryId);
                  }
                }
                this.#appendRunTransition(snapshot, run, "cancelled");
              }
            },
            onRollback: () => this.#mailbox.restorePersistedState(),
          },
        );
      }
      this.#hooks.emitQueue(input.agentId);
      this.stateChanged(input.agentId);
      this.arm();
    } finally {
      this.#deletionAgents.delete(input.agentId);
      if (this.#mailbox.nextQueued(input.agentId)) this.#hooks.scheduleDrain(input.agentId);
    }
  }

  async test(input: TestRoutineInput): Promise<RoutineRun> {
    this.#conversation.requireKnownAgent(input.agentId);
    const routine = this.#routines.get(input.agentId, input.routineId);
    if (!routine) throw new Error("This routine no longer exists.");
    const run = this.#routines.createRun(routine, null, "manual", new Date().toISOString());
    await this.#enqueueRun(run);
    this.stateChanged(input.agentId);
    return this.#routines.listRuns(input.agentId, input.routineId, 1)[0] ?? run;
  }

  listRuns(input: ListRoutineRunsInput): RoutineRun[] {
    this.#conversation.requireKnownAgent(input.agentId);
    if (!this.#routines.get(input.agentId, input.routineId)) throw new Error("This routine no longer exists.");
    return this.#routines.listRuns(input.agentId, input.routineId, input.limit);
  }

  /** The six `openbot` routine tools. Returns null when `tool` is not one of them. */
  async handleTool(params: DynamicToolCallParams, senderAgentId: string): Promise<OpenBotToolResponse | null> {
    if (params.tool === "list_routines") {
      const args = routineToolArguments(params.arguments, ["agentId"]);
      const agentId = routineToolAgentId(args, senderAgentId);
      return openBotToolResult({ routines: this.list(agentId) });
    }

    if (params.tool === "create_routine") {
      const args = routineToolArguments(params.arguments, [
        "agentId",
        "name",
        "instruction",
        "schedule",
        "active",
        "timezone",
      ]);
      const agentId = routineToolAgentId(args, senderAgentId);
      const active = args.active === undefined ? true : args.active;
      if (!isBoolean(active)) throw new Error("active must be a boolean.");
      const timezone =
        args.timezone === undefined
          ? localTimezone()
          : routineToolString(args.timezone, "timezone", 128, "A routine timezone is required.");
      const routine = this.create(
        {
          agentId,
          name: routineToolString(args.name, "name", INPUT_LIMITS.routineName, "A routine name is required."),
          instruction: routineToolString(
            args.instruction,
            "instruction",
            INPUT_LIMITS.routineInstruction,
            "A routine instruction is required.",
          ),
          active,
          timezone,
          schedule: routineToolSchedule(args.schedule),
        },
        { turnId: agentId === senderAgentId ? params.turnId : undefined },
      );
      return openBotToolResult(routine);
    }

    if (params.tool === "update_routine") {
      const args = routineToolArguments(params.arguments, [
        "agentId",
        "routineId",
        "name",
        "instruction",
        "schedule",
        "active",
      ]);
      const input: UpdateRoutineInput = {
        agentId: routineToolAgentId(args, senderAgentId),
        routineId: routineToolString(args.routineId, "routineId", INPUT_LIMITS.identifier, "routineId is required."),
      };
      let hasUpdate = false;
      if (args.name !== undefined) {
        input.name = routineToolString(args.name, "name", INPUT_LIMITS.routineName, "A routine name is required.");
        hasUpdate = true;
      }
      if (args.instruction !== undefined) {
        input.instruction = routineToolString(
          args.instruction,
          "instruction",
          INPUT_LIMITS.routineInstruction,
          "A routine instruction is required.",
        );
        hasUpdate = true;
      }
      if (args.active !== undefined) {
        if (!isBoolean(args.active)) throw new Error("active must be a boolean.");
        input.active = args.active;
        hasUpdate = true;
      }
      if (args.schedule !== undefined) {
        input.schedule = routineToolSchedule(args.schedule);
        hasUpdate = true;
      }
      if (!hasUpdate) throw new Error("At least one routine update is required.");
      return openBotToolResult(
        this.update(input, { turnId: input.agentId === senderAgentId ? params.turnId : undefined }),
      );
    }

    if (params.tool === "delete_routine") {
      const args = routineToolArguments(params.arguments, ["agentId", "routineId"]);
      const agentId = routineToolAgentId(args, senderAgentId);
      const routineId = routineToolString(
        args.routineId,
        "routineId",
        INPUT_LIMITS.identifier,
        "routineId is required.",
      );
      await this.delete({ agentId, routineId }, { turnId: agentId === senderAgentId ? params.turnId : undefined });
      return openBotToolResult({ deleted: true, agentId, routineId });
    }

    if (params.tool === "test_routine") {
      const args = routineToolArguments(params.arguments, ["agentId", "routineId"]);
      const agentId = routineToolAgentId(args, senderAgentId);
      const routineId = routineToolString(
        args.routineId,
        "routineId",
        INPUT_LIMITS.identifier,
        "routineId is required.",
      );
      return openBotToolResult(await this.test({ agentId, routineId }));
    }

    return null;
  }

  async resumePendingRuns(): Promise<void> {
    for (const run of this.#routines.pendingRuns()) {
      await this.#enqueueRun(run).catch((error) => {
        this.#hooks.emitError("routine_delivery_recovery_failed", error, run.agentId);
      });
    }
  }

  /**
   * Reconciles one queue delivery with the run it belongs to. Returns whether anything changed, so
   * the queue emitter can raise a single `routines-changed` for the agent rather than one per
   * delivery. This dependency is the one the plan accepts: the queue engine stays in the service,
   * and it is the queue that knows a delivery's status changed.
   */
  reconcileDelivery(delivery: QueueDelivery): boolean {
    if (delivery.sender.kind !== "routine") return false;
    const run = this.#routines.runForDelivery(delivery.id);
    if (!run) return false;
    const status = routineStatusForDelivery(delivery.status);
    if (run.status === "needs-attention" && ["starting", "running"].includes(delivery.status)) return false;
    if (run.status === status && run.error === delivery.error) return false;
    if (status === "queued") this.#routines.updateRunStatus(run.id, status, delivery.error);
    else this.#transitionRunWithConversation(run, status, delivery.error);
    return true;
  }

  markNeedsAttention(turnId: string | null): void {
    if (!turnId) return;
    const delivery = this.#mailbox.findDeliveryByTurn(turnId);
    if (delivery?.delivery.sender.kind !== "routine") return;
    const run = this.#routines.runForDelivery(delivery.delivery.id);
    if (!run || run.status === "needs-attention") return;
    this.#transitionInteractionWithReconciliation(run, "needs-attention");
  }

  markRunningForTurn(turnId: string | null): void {
    if (!turnId) return;
    const delivery = this.#mailbox.findDeliveryByTurn(turnId);
    if (delivery?.delivery.sender.kind !== "routine") return;
    const run = this.#routines.runForDelivery(delivery.delivery.id);
    if (run?.status !== "needs-attention") return;
    this.#transitionInteractionWithReconciliation(run, "running");
  }

  stateChanged(agentId: string): void {
    this.#hooks.emit({ type: "routines-changed", agentId });
  }

  /** Re-derives the next due time across every routine and arms the single timer for it. */
  arm(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#hooks.isRunning()) return;
    const nextDueAt = this.#routines.nextDueAt(this.#hooks.pendingDuplicateAgents());
    if (!nextDueAt) return;
    const delay = Math.max(0, Math.min(new Date(nextDueAt).getTime() - Date.now(), 2_147_000_000));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#processDue();
    }, delay);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #processDue(now = new Date()): Promise<void> {
    const changedAgents = new Set<string>();
    try {
      for (const due of this.#routines.due(now, this.#hooks.pendingDuplicateAgents())) {
        let scheduledFor = new Date(due.nextRunAt);
        let nextRunAt = nextRoutineOccurrence(due.schedule, due.routine.timezone, scheduledFor);
        while (nextRunAt.getTime() <= now.getTime()) {
          scheduledFor = nextRunAt;
          nextRunAt = nextRoutineOccurrence(due.schedule, due.routine.timezone, scheduledFor);
        }
        const run = this.#routines.createRun(due.routine, due.triggerId, "scheduled", scheduledFor.toISOString());
        this.#routines.advanceTrigger(due.routine.id, due.triggerId, nextRunAt.toISOString());
        changedAgents.add(due.routine.agentId);
        if (!run.deliveryId) {
          await this.#enqueueRun(run).catch((error) => {
            this.#hooks.emitError("routine_delivery_failed", error, due.routine.agentId);
          });
        }
      }
    } catch (error) {
      this.#hooks.emitError("routine_scheduler_failed", error);
    } finally {
      for (const agentId of changedAgents) this.stateChanged(agentId);
      this.arm();
    }
  }

  async #enqueueRun(run: RoutineRun): Promise<void> {
    const agent = await this.#store.getOrCreate(run.agentId);
    try {
      const receipt = await this.#mailbox.enqueue({
        sender: {
          kind: "routine",
          routineId: run.routineId,
          runId: run.id,
          routineName: run.routineName,
          scheduledFor: run.scheduledFor,
        },
        recipientAgentIds: [agent.id],
        text: run.instruction,
        draftIds: [],
        replyToMessageId: null,
        idempotencyKey: run.triggerId ? `routine:${run.triggerId}:${run.scheduledFor}` : `routine:manual:${run.id}`,
      });
      const deliveryId = receipt.deliveries[0]?.id;
      if (!deliveryId) throw new Error("Unable to create the routine delivery.");
      this.#routines.attachDelivery(run.id, deliveryId);
      const snapshot = this.#conversation.ensureSnapshot(agent.id, agent.threadId);
      this.#hooks.syncMailboxMessages(snapshot);
      await this.#store.updatePreview(agent.id, run.instruction);
      this.#hooks.emit({ type: "agents-changed", agents: this.#hooks.listAgents() });
      this.#conversation.emitConversation(snapshot, "routine.run-queued", { routineId: run.routineId, runId: run.id });
      this.#hooks.emitQueue(agent.id);
      this.#hooks.scheduleDrain(agent.id);
    } catch (error) {
      this.#transitionRunWithConversation(run, "failed", error instanceof Error ? error.message : String(error));
      this.stateChanged(run.agentId);
      throw error;
    }
  }

  async #interruptRunsBeforeDeletion(agentId: string, runs: RoutineRun[]): Promise<RoutineRun[]> {
    const startingRun = runs.find((run) => {
      if (!run.deliveryId) return false;
      const delivery = this.#mailbox.getDelivery(run.deliveryId)?.delivery;
      return delivery?.status === "starting" && !delivery.turnId;
    });
    if (startingRun) await this.#hooks.awaitDrain(agentId);

    const cancellableRuns: RoutineRun[] = [];
    const activeTurnIds = new Set<string>();
    for (const run of runs) {
      if (!run.deliveryId) {
        cancellableRuns.push(run);
        continue;
      }
      const delivery = this.#mailbox.getDelivery(run.deliveryId)?.delivery;
      if (!delivery) continue;
      if (delivery.status === "queued") {
        cancellableRuns.push(run);
        continue;
      }
      if (delivery.status !== "starting" && delivery.status !== "running") continue;
      if (!delivery.turnId) {
        throw new Error("This routine run is still starting. Try again after its turn starts.");
      }
      cancellableRuns.push(run);
      activeTurnIds.add(delivery.turnId);
    }
    if (activeTurnIds.size === 0) return cancellableRuns;
    if (!this.#store.activeProviderSession(agentId)) {
      throw new Error("OpenBot cannot interrupt the active routine run because its provider session is unavailable.");
    }
    for (const turnId of activeTurnIds) await this.#hooks.interrupt(agentId, turnId);
    return cancellableRuns;
  }

  #transitionInteractionWithReconciliation(run: RoutineRun, status: "needs-attention" | "running"): void {
    try {
      this.#transitionRunWithConversation(run, status);
      this.stateChanged(run.agentId);
    } catch (error) {
      this.#hooks.emitError("delivery_reconciliation_pending", error, run.agentId);
      queueMicrotask(() => {
        if (!run.deliveryId) return;
        const current = this.#routines.runForDelivery(run.deliveryId);
        if (!current || current.status === status) return;
        if (status === "running" && current.status !== "needs-attention") return;
        if (status === "needs-attention" && current.status !== "running") return;
        try {
          this.#transitionRunWithConversation(current, status);
          this.stateChanged(current.agentId);
        } catch (retryError) {
          this.#hooks.emitError("delivery_reconciliation_pending", retryError, current.agentId);
        }
      });
    }
  }

  #transitionRunWithConversation(
    run: RoutineRun,
    status: RoutineRunConversationEventStatus,
    error: string | null = null,
  ): RoutineRun {
    if (run.status === status && run.error === error) return run;
    const database = this.#store.database;
    return this.#conversation.withConversationTransaction(run.agentId, ({ threadId, snapshot: nextSnapshot }) => {
      const transition = this.#appendRunTransition(nextSnapshot, run, status, error);
      sortConversationMessages(nextSnapshot.messages);
      nextSnapshot.revision = database.appendConversationMessage({
        agentId: run.agentId,
        threadId,
        activeTurnId: nextSnapshot.activeTurnId,
        message: transition.message,
        eventType: `routine.run-${status}`,
        detail: { routineId: run.routineId, runId: run.id, status },
      });
      return { result: transition.run, snapshot: nextSnapshot };
    });
  }

  #appendRunTransition(
    snapshot: ConversationSnapshot,
    run: RoutineRun,
    status: RoutineRunConversationEventStatus,
    error: string | null = null,
  ): { run: RoutineRun; message: ConversationMessage } {
    const updated = this.#routines.updateRunStatus(run.id, status, error);
    const message: ConversationMessage = {
      id: randomUUID(),
      author: "system",
      source: "system",
      text: run.routineName,
      createdAt: updated.updatedAt,
      status: "completed",
      itemType: routineRunConversationEventItemType(status, run.routineId, run.id),
    };
    snapshot.messages.push(message);
    return { run: updated, message };
  }

  #mutateWithConversation<T>(
    agentId: string,
    action: RoutineConversationEventAction,
    mutate: () => T,
    eventRoutine: (result: T) => Pick<Routine, "id" | "name">,
    turnId?: string,
    transactionHooks?: { beforeMutate?: (snapshot: ConversationSnapshot) => void; onRollback?: () => void },
  ): T {
    const database = this.#store.database;
    return this.#conversation.withConversationTransaction(
      agentId,
      ({ snapshot: nextSnapshot }) => {
        transactionHooks?.beforeMutate?.(nextSnapshot);
        const result = mutate();
        const routine = eventRoutine(result);
        const createdAt = new Date().toISOString();
        const message: ConversationMessage = {
          id: randomUUID(),
          ...(turnId ? { turnId } : {}),
          author: "system",
          source: "system",
          text: routine.name,
          createdAt,
          status: "completed",
          itemType: routineConversationEventItemType(action, routine.id),
        };
        nextSnapshot.messages.push(message);
        sortConversationMessages(nextSnapshot.messages);
        // persistConversation returns a fresh snapshot, so the published one is not `nextSnapshot`.
        const persisted = database.persistConversation(nextSnapshot, `routine.${action}`, {
          action,
          routineId: routine.id,
          routineName: routine.name,
          messageId: message.id,
        });
        return { result, snapshot: persisted };
      },
      transactionHooks?.onRollback,
    );
  }
}
