import { describe, expect, it } from "vitest";
import {
  isBoolean,
  isDynamicRecord,
  isFunction,
  isNumber,
  isObjectValue,
  isString,
} from "./runtime-values";

describe("runtime values", () => {
  it("accepts only unboxed primitives", () => {
    expect(isString("value")).toBe(true);
    expect(isString(new String("value"))).toBe(false);
    expect(isNumber(1)).toBe(true);
    expect(isNumber(new Number(1))).toBe(false);
    expect(isBoolean(false)).toBe(true);
    expect(isBoolean(new Boolean(false))).toBe(false);
  });

  it("separates functions, objects, and records", () => {
    expect(isFunction(() => undefined)).toBe(true);
    expect(isObjectValue(null)).toBe(true);
    expect(isObjectValue([])).toBe(true);
    expect(isDynamicRecord({ value: 1 })).toBe(true);
    expect(isDynamicRecord([])).toBe(false);
    expect(isDynamicRecord(null)).toBe(false);
  });
});
