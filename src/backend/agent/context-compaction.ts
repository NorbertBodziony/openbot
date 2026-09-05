import type { AgentStore } from "../agent-store";
import { decodeRecordResponse, getRecord } from "../protocol";
import { finiteNumberOrNull } from "./account-usage";
import type { ProviderPort } from "./provider-runtime";

interface ThreadContextBudget {
  usedTokens: number;
  contextWindow: number;
  pending: boolean;
  phase: "idle" | "requested" | "running";
  compactionTurnId: string | null;
  lastCompactedTokens: number | null;
}

const CONTEXT_COMPACTION_THRESHOLD = 0.8;
const CONTEXT_COMPACTION_TIMEOUT_MS = 120_000;

export interface ContextCompactionOptions {
  store: AgentStore;
  providers: ProviderPort;
  emitError(code: string, error: unknown, agentId?: string): void;
  scheduleDrain(agentId: string): void;
}

/**
 * Decides when a provider thread is close enough to its context window to compact, and drives the
 * compaction turn.
 *
 * A compaction is a real provider turn, so it arrives on the same notification stream as the
 * agent's own work and has to be told apart from it: `claimTurn` swallows the `turn/started` that
 * belongs to the compaction, and `isCompactionTurn` recognizes its completion. The budget is keyed
 * by *external* provider thread id, `compactingAgents` by agent id, because an agent only ever compacts one
 * thread at a time and the drain guard asks the question by agent.
 */
export class ContextCompaction {
  readonly #store: AgentStore;
  readonly #providers: ProviderPort;
  readonly #emitError: (code: string, error: unknown, agentId?: string) => void;
  readonly #scheduleDrain: (agentId: string) => void;
  readonly #budgets = new Map<string, ThreadContextBudget>();
  readonly #compactingAgents = new Set<string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(options: ContextCompactionOptions) {
    this.#store = options.store;
    this.#providers = options.providers;
    this.#emitError = options.emitError;
    this.#scheduleDrain = options.scheduleDrain;
  }

  /** One clause of the drain guard the queue engine composes. False means "hold this agent's queue". */
  mayDrain(agentId: string): boolean {
    return !this.#compactingAgents.has(agentId);
  }

  updateBudget(threadId: string, params: unknown): void {
    const usage = getRecord(params, "tokenUsage");
    const last = getRecord(usage, "last");
    const usedTokens = finiteNumberOrNull(last?.totalTokens);
    const contextWindow = finiteNumberOrNull(usage?.modelContextWindow);
    if (usedTokens === null || contextWindow === null || contextWindow <= 0) return;

    const budget = this.#budgets.get(threadId) ?? {
      usedTokens,
      contextWindow,
      pending: false,
      phase: "idle" as const,
      compactionTurnId: null,
      lastCompactedTokens: null,
    };
    budget.usedTokens = usedTokens;
    budget.contextWindow = contextWindow;
    this.#budgets.set(threadId, budget);

    const pressured = usedTokens / contextWindow >= CONTEXT_COMPACTION_THRESHOLD;
    if (!pressured) {
      budget.pending = false;
      budget.lastCompactedTokens = null;
      return;
    }
    if (budget.phase !== "idle") return;

    const minimumGrowth = Math.max(1_024, Math.floor(contextWindow * 0.05));
    if (budget.lastCompactedTokens !== null && usedTokens < budget.lastCompactedTokens + minimumGrowth) {
      return;
    }
    budget.pending = true;
  }

  reserve(agentId: string, threadId: string): boolean {
    const budget = this.#budgets.get(threadId);
    if (!budget?.pending || budget.phase !== "idle" || this.#compactingAgents.has(agentId)) {
      return false;
    }
    budget.phase = "requested";
    this.#compactingAgents.add(agentId);
    return true;
  }

  async request(agentId: string, threadId: string): Promise<void> {
    const budget = this.#budgets.get(threadId);
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    const client = agent ? this.#providers.clientForAgent(agent) : null;
    if (budget?.phase !== "requested" || !client || !this.#providers.isReady()) {
      this.#release(agentId, threadId);
      return;
    }

    this.#clearTimer(threadId);
    const timer = setTimeout(() => {
      this.#emitError(
        "context_compaction_timeout",
        "Codex context compaction timed out; queued work will continue.",
        agentId,
      );
      this.#release(agentId, threadId);
      this.#scheduleDrain(agentId);
    }, CONTEXT_COMPACTION_TIMEOUT_MS);
    timer.unref?.();
    this.#timers.set(threadId, timer);

    try {
      await client.request("thread/compact/start", { threadId }, decodeRecordResponse);
    } catch (error) {
      budget.lastCompactedTokens = budget.usedTokens;
      this.#emitError("context_compaction_failed", error, agentId);
      this.#release(agentId, threadId);
      this.#scheduleDrain(agentId);
    }
  }

  /**
   * Takes ownership of a `turn/started` that belongs to a compaction we asked for. True means the
   * router must stop: this turn is not the agent's, so it gets no active turn and no event.
   */
  claimTurn(agentId: string, threadId: string, turnId: string): boolean {
    const budget = this.#budgets.get(threadId);
    if (budget?.phase !== "requested" || !this.#compactingAgents.has(agentId)) return false;
    budget.phase = "running";
    budget.compactionTurnId = turnId;
    return true;
  }

  isCompactionTurn(threadId: string, turnId: string): boolean {
    return this.#budgets.get(threadId)?.compactionTurnId === turnId;
  }

  markCompacted(threadId: string): void {
    const budget = this.#budgets.get(threadId);
    if (!budget) return;
    budget.pending = false;
    budget.lastCompactedTokens = budget.usedTokens;
  }

  finish(agentId: string, threadId: string, status: string): void {
    const budget = this.#budgets.get(threadId);
    if (budget && status !== "completed") {
      budget.lastCompactedTokens = budget.usedTokens;
      this.#emitError("context_compaction_failed", `Codex context compaction ended with status ${status}.`, agentId);
    }
    this.#release(agentId, threadId);
    this.#scheduleDrain(agentId);
  }

  /** Drops a retired provider thread's budget. The agent keeps compacting until `forgetAgent`. */
  forgetThread(threadId: string): void {
    this.#budgets.delete(threadId);
    this.#clearTimer(threadId);
  }

  forgetAgent(agentId: string): void {
    this.#compactingAgents.delete(agentId);
  }

  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#compactingAgents.clear();
    this.#budgets.clear();
  }

  #release(agentId: string, threadId: string): void {
    this.#clearTimer(threadId);
    const budget = this.#budgets.get(threadId);
    if (budget) {
      budget.pending = false;
      budget.phase = "idle";
      budget.compactionTurnId = null;
    }
    this.#compactingAgents.delete(agentId);
  }

  #clearTimer(threadId: string): void {
    const timer = this.#timers.get(threadId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(threadId);
  }
}
