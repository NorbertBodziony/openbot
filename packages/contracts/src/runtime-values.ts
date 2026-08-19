export interface DynamicRecord {
  readonly [key: string]: unknown;
}

function runtimeTag(value: unknown): string {
  return Object.prototype.toString.call(value);
}

function isUnboxedPrimitive(value: unknown): boolean {
  return Object(value) !== value;
}

export function isString(value: unknown): value is string {
  return isUnboxedPrimitive(value) && runtimeTag(value) === "[object String]";
}

export function isNumber(value: unknown): value is number {
  return isUnboxedPrimitive(value) && runtimeTag(value) === "[object Number]";
}

export function isBoolean(value: unknown): value is boolean {
  return isUnboxedPrimitive(value) && runtimeTag(value) === "[object Boolean]";
}

export function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return value instanceof Function;
}

export function isObjectValue(value: unknown): value is object | null {
  return value === null || (Object(value) === value && !isFunction(value));
}

export function isDynamicRecord(value: unknown): value is DynamicRecord {
  return value !== null && isObjectValue(value) && !Array.isArray(value);
}

export function isOneOf<T extends string | number>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => candidate === value);
}
