import type { AccountUsage, AccountUsageLimit, AccountUsageWindow } from "@openbot/contracts/ipc";
import { isNumber } from "@openbot/contracts/runtime-values";
import type { AccountRateLimitResult, AccountRateLimitsReadResult } from "../protocol";

export function normalizeAccountUsage(rateLimits: AccountRateLimitsReadResult | null, model?: string): AccountUsage {
  const entries = rateLimits?.rateLimitsByLimitId
    ? Object.entries(rateLimits.rateLimitsByLimitId).filter((entry): entry is [string, AccountRateLimitResult] =>
        Boolean(entry[1]),
      )
    : [];
  const fallback: [string, AccountRateLimitResult] | null = rateLimits?.rateLimits
    ? [rateLimits.rateLimits.limitId ?? "codex", rateLimits.rateLimits]
    : null;
  const selectedEntries = model
    ? selectModelRateLimits(entries, model, fallback)
    : entries.length > 0
      ? entries
      : fallback
        ? [fallback]
        : [];
  const limits = selectedEntries.map(([id, limit]) => normalizeAccountLimit(id, limit));

  return { limits };
}

function selectModelRateLimits(
  entries: Array<[string, AccountRateLimitResult]>,
  model: string,
  fallback: [string, AccountRateLimitResult] | null,
): Array<[string, AccountRateLimitResult]> {
  const normalizedModel = model.trim().toLowerCase();
  const modelSpecific = entries.filter(([, limit]) =>
    [limit.limitName, limit.normalModelSlug].some((candidate) => candidate?.trim().toLowerCase() === normalizedModel),
  );
  if (modelSpecific.length > 0) return modelSpecific;
  if (fallback) return [fallback];
  return entries.filter(([id, limit]) => id === "codex" || limit.limitId === "codex");
}

export function normalizeAccountLimit(id: string, limit: AccountRateLimitResult): AccountUsageLimit {
  return {
    id: limit.limitId ?? id,
    primary: normalizeUsageWindow(limit.primary),
    secondary: normalizeUsageWindow(limit.secondary),
  };
}

export function normalizeUsageWindow(window: AccountRateLimitResult["primary"]): AccountUsageWindow | null {
  const usedPercent = finiteNumberOrNull(window?.usedPercent);
  if (usedPercent === null) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowDurationMins: finiteNumberOrNull(window?.windowDurationMins),
    resetsAt: finiteNumberOrNull(window?.resetsAt),
  };
}

export function finiteNumberOrNull(value: unknown): number | null {
  return isNumber(value) && Number.isFinite(value) ? value : null;
}
