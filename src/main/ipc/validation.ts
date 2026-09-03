import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { type DynamicRecord, isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

export function requireString(value: unknown, field: string, maxLength: number = INPUT_LIMITS.identifier): string {
  if (!isString(value) || !value.trim()) throw new Error(`${field} is required.`);
  if (value.length > maxLength) throw new Error(`${field} is too long.`);
  return value;
}

/**
 * `requireString` bound to one field name, for the many channels whose whole payload is a single
 * identifier. `handleTrusted` takes a `(value: unknown) => Payload`, and `requireString` takes three
 * arguments, so without this each of those channels would need its own one-line named decoder.
 */
export function stringPayload(field: string, maxLength: number = INPUT_LIMITS.identifier): (value: unknown) => string {
  return (value) => requireString(value, field, maxLength);
}

/**
 * Wraps a decoder for a channel whose payload may legitimately be absent, so an omitted payload
 * stays `undefined` rather than being rejected as malformed.
 */
export function optionalPayload<Payload>(decode: (value: unknown) => Payload): (value: unknown) => Payload | undefined {
  return (value) => (value === null || value === undefined ? undefined : decode(value));
}

export function isObject(value: unknown): value is DynamicRecord {
  return isDynamicRecord(value);
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (!isBoolean(value)) throw new Error(`${field} must be a boolean.`);
  return value;
}
