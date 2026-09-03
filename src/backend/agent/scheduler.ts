export interface AgentClock {
  now(): number;
  setTimeout(handler: () => void, timeoutMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout | null | undefined): void;
}

export const MAX_TIMER_MS = 2_147_000_000;
export const DELTA_FLUSH_MS = 100;
export const HOSTED_SITE_TERMINAL_RETRY_MS = 1_000;
export const RESTART_BASE_DELAY_MS = 500;
export const MAX_RESTART_ATTEMPTS = 3;

export const realAgentClock: AgentClock = {
  now: () => Date.now(),
  setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
  clearTimeout: (timer) => {
    if (timer) clearTimeout(timer);
  },
};

export function computeRoutineDelayMs(nextDueAt: string | null | undefined, nowMs = Date.now()): number | null {
  if (!nextDueAt) return null;
  const dueMs = new Date(nextDueAt).getTime();
  if (!Number.isFinite(dueMs)) return null;
  return clampTimerMs(dueMs - nowMs);
}

export function computeRestartDelayMs(attempts: number): number {
  if (attempts < 0) return RESTART_BASE_DELAY_MS;
  return RESTART_BASE_DELAY_MS * 2 ** attempts;
}

export function clampTimerMs(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return 0;
  if (delayMs < 0) return 0;
  if (delayMs > MAX_TIMER_MS) return MAX_TIMER_MS;
  return delayMs;
}
