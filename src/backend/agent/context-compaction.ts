import type { BotStore } from "../agent-store";
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
  store: BotStore;
  providers: ProviderPort;
  emitError(code: string, error: unknown, botId?: string): void;
  scheduleDrain(botId: string): void;
}

/**
 * Decides when a provider thread is close enough to its context window to compact, and drives the
 * compaction turn.
 *
 * A compaction is a real provider turn, so it arrives on the same notification stream as the
 * agent's own work and has to be told apart from it: `claimTurn` swallows the `turn/started` that
 * belongs to the compaction, and `isCompactionTurn` recognizes its completion. The budget is keyed
 * by *external* provider thread id, `compactingBots` by bot id, because a bot only ever compacts one
 * thread at a time and the drain guard asks the question by bot.
 */
export class ContextCompaction {
  readonly #store: BotStore;
  readonly #providers: ProviderPort;
  readonly #emitError: (code: string, error: unknown, botId?: string) => void;
  readonly #scheduleDrain: (botId: string) => void;
  readonly #budgets = new Map<string, ThreadContextBudget>();
  readonly #compactingBots = new Set<string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(options: ContextCompactionOptions) {
    this.#store = options.store;
    this.#providers = options.providers;
    this.#emitError = options.emitError;
    this.#scheduleDrain = options.scheduleDrain;
  }

  /** One clause of the drain guard the queue engine composes. False means "hold this bot's queue". */
  mayDrain(botId: string): boolean {
    return !this.#compactingBots.has(botId);
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

  reserve(botId: string, threadId: string): boolean {
    const budget = this.#budgets.get(threadId);
    if (!budget?.pending || budget.phase !== "idle" || this.#compactingBots.has(botId)) {
      return false;
    }
    budget.phase = "requested";
    this.#compactingBots.add(botId);
    return true;
  }

  async request(botId: string, threadId: string): Promise<void> {
    const budget = this.#budgets.get(threadId);
    const bot = this.#store.list().find((candidate) => candidate.id === botId);
    const client = bot ? this.#providers.clientForBot(bot) : null;
    if (budget?.phase !== "requested" || !client || !this.#providers.isReady()) {
      this.#release(botId, threadId);
      return;
    }

    this.#clearTimer(threadId);
    const timer = setTimeout(() => {
      this.#emitError(
        "context_compaction_timeout",
        "Codex context compaction timed out; queued work will continue.",
        botId,
      );
      this.#release(botId, threadId);
      this.#scheduleDrain(botId);
    }, CONTEXT_COMPACTION_TIMEOUT_MS);
    timer.unref?.();
    this.#timers.set(threadId, timer);

    try {
      await client.request("thread/compact/start", { threadId }, decodeRecordResponse);
    } catch (error) {
      budget.lastCompactedTokens = budget.usedTokens;
      this.#emitError("context_compaction_failed", error, botId);
      this.#release(botId, threadId);
      this.#scheduleDrain(botId);
    }
  }

  /**
   * Takes ownership of a `turn/started` that belongs to a compaction we asked for. True means the
   * router must stop: this turn is not the agent's, so it gets no active turn and no event.
   */
  claimTurn(botId: string, threadId: string, turnId: string): boolean {
    const budget = this.#budgets.get(threadId);
    if (budget?.phase !== "requested" || !this.#compactingBots.has(botId)) return false;
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

  finish(botId: string, threadId: string, status: string): void {
    const budget = this.#budgets.get(threadId);
    if (budget && status !== "completed") {
      budget.lastCompactedTokens = budget.usedTokens;
      this.#emitError("context_compaction_failed", `Codex context compaction ended with status ${status}.`, botId);
    }
    this.#release(botId, threadId);
    this.#scheduleDrain(botId);
  }

  /** Drops a retired provider thread's budget. The bot keeps compacting until `forgetBot`. */
  forgetThread(threadId: string): void {
    this.#budgets.delete(threadId);
    this.#clearTimer(threadId);
  }

  forgetBot(botId: string): void {
    this.#compactingBots.delete(botId);
  }

  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#compactingBots.clear();
    this.#budgets.clear();
  }

  #release(botId: string, threadId: string): void {
    this.#clearTimer(threadId);
    const budget = this.#budgets.get(threadId);
    if (budget) {
      budget.pending = false;
      budget.phase = "idle";
      budget.compactionTurnId = null;
    }
    this.#compactingBots.delete(botId);
  }

  #clearTimer(threadId: string): void {
    const timer = this.#timers.get(threadId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(threadId);
  }
}
