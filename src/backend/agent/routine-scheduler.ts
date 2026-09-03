import { computeRoutineDelayMs } from "./scheduler";

export function routineTimerDelayMs(nextDueAt: string | null | undefined, nowMs = Date.now()): number | null {
  return computeRoutineDelayMs(nextDueAt, nowMs);
}
