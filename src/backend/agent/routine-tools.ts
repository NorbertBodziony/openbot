import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isRoutineSchedule, type RoutineSchedule } from "@openbot/contracts/ipc";
import { type DynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { isRecord } from "../protocol";

export function routineToolArguments(value: unknown, allowedKeys: readonly string[]): DynamicRecord {
  if (!isRecord(value)) throw new Error("Routine tool arguments are required.");
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Unexpected routine argument: ${unexpected}.`);
  return value;
}

export function routineToolBotId(args: DynamicRecord, senderBotId: string): string {
  if (args.botId === undefined) return senderBotId;
  return routineToolString(args.botId, "botId", INPUT_LIMITS.identifier, "botId is required.");
}

export function routineToolString(value: unknown, field: string, limit: number, requiredMessage: string): string {
  if (!isString(value) || !value.trim()) throw new Error(requiredMessage);
  if (value.length > limit) throw new Error(`${field} is too long.`);
  return value;
}

export function siteToolString(value: unknown, field: string, limit: number): string {
  if (!isString(value) || !value.trim()) throw new Error(`${field} is required.`);
  if (value.length > limit) throw new Error(`${field} is too long.`);
  return value.trim();
}

export function routineToolSchedule(value: unknown): RoutineSchedule {
  if (!isRoutineSchedule(value)) throw new Error("The routine schedule is invalid.");
  return structuredClone(value);
}

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function openBotToolResult(value: unknown): {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
} {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}
