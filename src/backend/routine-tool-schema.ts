import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { z } from "zod";

const ROUTINE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const ROUTINE_TIME_JSON_SCHEMA = {
  type: "string",
  pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
  description: "Local time in HH:mm format.",
} as const;

const ROUTINE_DAY_SELECTION_JSON_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "every-day" } },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "days-of-week" },
        days: { type: "array", minItems: 1, items: { type: "integer", minimum: 0, maximum: 6 } },
      },
      required: ["kind", "days"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "days-of-month" },
        days: { type: "array", minItems: 1, items: { type: "integer", minimum: 1, maximum: 31 } },
      },
      required: ["kind", "days"],
      additionalProperties: false,
    },
  ],
} as const;

const ROUTINE_TIME_SELECTION_JSON_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "at-time" }, time: ROUTINE_TIME_JSON_SCHEMA },
      required: ["kind", "time"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "every" },
        amount: { type: "integer", minimum: 1, maximum: 100_000 },
        unit: { type: "string", enum: ["minutes", "hours"] },
      },
      required: ["kind", "amount", "unit"],
      additionalProperties: false,
    },
  ],
} as const;

export const ROUTINE_SCHEDULE_JSON_SCHEMA = {
  description: "Routine schedule. Weekdays use 0 for Sunday through 6 for Saturday; clock values use HH:mm local time.",
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "hourly" }, minute: { type: "integer", minimum: 0, maximum: 59 } },
      required: ["kind", "minute"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "daily" }, time: ROUTINE_TIME_JSON_SCHEMA },
      required: ["kind", "time"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "weekdays" }, time: ROUTINE_TIME_JSON_SCHEMA },
      required: ["kind", "time"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "weekly" },
        weekday: { type: "integer", minimum: 0, maximum: 6 },
        time: ROUTINE_TIME_JSON_SCHEMA,
      },
      required: ["kind", "weekday", "time"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "monthly" },
        day: { type: "integer", minimum: 1, maximum: 31 },
        time: ROUTINE_TIME_JSON_SCHEMA,
      },
      required: ["kind", "day", "time"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "interval" },
        amount: { type: "integer", minimum: 1, maximum: 100_000 },
        unit: { type: "string", enum: ["minutes", "hours", "days"] },
        anchorAt: { type: "string", description: "An ISO 8601 date-time anchoring the interval." },
      },
      required: ["kind", "amount", "unit", "anchorAt"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "advanced" },
        months: {
          type: "array",
          minItems: 1,
          items: { type: "integer", minimum: 1, maximum: 12 },
        },
        days: ROUTINE_DAY_SELECTION_JSON_SCHEMA,
        time: ROUTINE_TIME_SELECTION_JSON_SCHEMA,
      },
      required: ["kind", "months", "days", "time"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "custom" },
        expression: { type: "string", minLength: 1, maxLength: INPUT_LIMITS.routineCron },
      },
      required: ["kind", "expression"],
      additionalProperties: false,
    },
  ],
} as const;

const routineTimeSchema = z.string().regex(ROUTINE_TIME_PATTERN);
const routineDaySelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("every-day") }).strict(),
  z.object({ kind: z.literal("days-of-week"), days: z.array(z.number().int().min(0).max(6)).min(1) }).strict(),
  z.object({ kind: z.literal("days-of-month"), days: z.array(z.number().int().min(1).max(31)).min(1) }).strict(),
]);
const routineTimeSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at-time"), time: routineTimeSchema }).strict(),
  z
    .object({
      kind: z.literal("every"),
      amount: z.number().int().min(1).max(100_000),
      unit: z.enum(["minutes", "hours"]),
    })
    .strict(),
]);

export const routineScheduleZodSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hourly"), minute: z.number().int().min(0).max(59) }).strict(),
  z.object({ kind: z.literal("daily"), time: routineTimeSchema }).strict(),
  z.object({ kind: z.literal("weekdays"), time: routineTimeSchema }).strict(),
  z.object({ kind: z.literal("weekly"), weekday: z.number().int().min(0).max(6), time: routineTimeSchema }).strict(),
  z.object({ kind: z.literal("monthly"), day: z.number().int().min(1).max(31), time: routineTimeSchema }).strict(),
  z
    .object({
      kind: z.literal("interval"),
      amount: z.number().int().min(1).max(100_000),
      unit: z.enum(["minutes", "hours", "days"]),
      anchorAt: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("advanced"),
      months: z.array(z.number().int().min(1).max(12)).min(1),
      days: routineDaySelectionSchema,
      time: routineTimeSelectionSchema,
    })
    .strict(),
  z.object({ kind: z.literal("custom"), expression: z.string().min(1).max(INPUT_LIMITS.routineCron) }).strict(),
]);
