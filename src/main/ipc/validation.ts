import { INPUT_LIMITS } from "@openbot/contracts/input-limits";

export function requireString(
  value: unknown,
  field: string,
  maxLength: number = INPUT_LIMITS.identifier,
): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  if (value.length > maxLength) throw new Error(`${field} is too long.`);
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
