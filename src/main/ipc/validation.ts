import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

export function requireString(
  value: unknown,
  field: string,
  maxLength: number = INPUT_LIMITS.identifier,
): string {
  if (!isString(value) || !value.trim()) throw new Error(`${field} is required.`);
  if (value.length > maxLength) throw new Error(`${field} is too long.`);
  return value;
}

export function isObject(value: unknown): value is DynamicRecord {
  return isDynamicRecord(value);
}
