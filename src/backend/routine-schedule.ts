import type { RoutineIntervalUnit, RoutineSchedule } from "@openbot/contracts/ipc";
import { isRoutineSchedule } from "@openbot/contracts/ipc";

const MINIMUM_INTERVAL_MS = 15 * 60_000;
const MAX_SEARCH_DAYS = 366 * 5;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

interface CronField {
  values: number[];
  wildcard: boolean;
}

interface CronSpec {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
  exactTimes?: Set<string>;
}

export function validateRoutineSchedule(schedule: RoutineSchedule, timezone: string): void {
  if (!isRoutineSchedule(schedule)) throw new Error("The routine schedule is invalid.");
  validateTimezone(timezone);
  if (schedule.kind === "interval") {
    if (intervalMilliseconds(schedule.amount, schedule.unit) < MINIMUM_INTERVAL_MS) {
      throw new Error("Routine intervals must be at least 15 minutes.");
    }
    return;
  }
  if (schedule.kind === "advanced" && schedule.time.kind === "every") {
    if (intervalMilliseconds(schedule.time.amount, schedule.time.unit) < MINIMUM_INTERVAL_MS) {
      throw new Error("Routine intervals must be at least 15 minutes.");
    }
  }
  if (schedule.kind !== "custom") return;
  const spec = parseCron(schedule.expression);
  const reference = new Date("2026-01-01T00:00:00.000Z");
  let previous = nextCronOccurrence(spec, timezone, reference);
  for (let index = 0; index < 200; index += 1) {
    const next = nextCronOccurrence(spec, timezone, previous);
    if (next.getTime() - previous.getTime() < MINIMUM_INTERVAL_MS) {
      throw new Error("Custom schedules must run no more often than every 15 minutes.");
    }
    previous = next;
  }
}

export function nextRoutineOccurrence(schedule: RoutineSchedule, timezone: string, after: Date): Date {
  validateRoutineSchedule(schedule, timezone);
  if (schedule.kind === "interval") {
    const duration = intervalMilliseconds(schedule.amount, schedule.unit);
    const anchor = Date.parse(schedule.anchorAt);
    if (!Number.isFinite(anchor)) throw new Error("The routine interval anchor is invalid.");
    if (after.getTime() < anchor) return new Date(anchor);
    const elapsed = after.getTime() - anchor;
    return new Date(anchor + (Math.floor(elapsed / duration) + 1) * duration);
  }
  return nextCronOccurrence(scheduleCronSpec(schedule), timezone, after);
}

export function normalizeRoutineSchedule(schedule: RoutineSchedule, now = new Date()): RoutineSchedule {
  if (schedule.kind !== "interval") return structuredClone(schedule);
  const anchor = Number.isNaN(Date.parse(schedule.anchorAt)) ? now.toISOString() : schedule.anchorAt;
  return { ...schedule, anchorAt: anchor };
}

export function routineScheduleSummary(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case "hourly":
      return schedule.minute === 0 ? "Every hour" : `Every hour at :${String(schedule.minute).padStart(2, "0")}`;
    case "daily":
      return `Every day at ${displayTime(schedule.time)}`;
    case "weekdays":
      return `Weekdays at ${displayTime(schedule.time)}`;
    case "weekly":
      return `Every ${WEEKDAYS[schedule.weekday]} at ${displayTime(schedule.time)}`;
    case "monthly":
      return `Monthly on day ${schedule.day} at ${displayTime(schedule.time)}`;
    case "interval":
      return `Every ${schedule.amount} ${schedule.unit}`;
    case "advanced":
      return "Advanced schedule";
    case "custom":
      return schedule.expression;
  }
}

function scheduleCronSpec(schedule: Exclude<RoutineSchedule, { kind: "interval" }>): CronSpec {
  switch (schedule.kind) {
    case "hourly":
      return cronSpec(
        field([schedule.minute]),
        wildcardField(0, 23),
        wildcardField(1, 31),
        wildcardField(1, 12),
        wildcardField(0, 6),
      );
    case "daily": {
      const [hour, minute] = parseTime(schedule.time);
      return cronSpec(field([minute]), field([hour]), wildcardField(1, 31), wildcardField(1, 12), wildcardField(0, 6));
    }
    case "weekdays": {
      const [hour, minute] = parseTime(schedule.time);
      return cronSpec(
        field([minute]),
        field([hour]),
        wildcardField(1, 31),
        wildcardField(1, 12),
        field([1, 2, 3, 4, 5]),
      );
    }
    case "weekly": {
      const [hour, minute] = parseTime(schedule.time);
      return cronSpec(
        field([minute]),
        field([hour]),
        wildcardField(1, 31),
        wildcardField(1, 12),
        field([schedule.weekday]),
      );
    }
    case "monthly": {
      const [hour, minute] = parseTime(schedule.time);
      return cronSpec(field([minute]), field([hour]), field([schedule.day]), wildcardField(1, 12), wildcardField(0, 6));
    }
    case "advanced": {
      const day = schedule.days.kind === "days-of-month" ? field(schedule.days.days) : wildcardField(1, 31);
      const weekday = schedule.days.kind === "days-of-week" ? field(schedule.days.days) : wildcardField(0, 6);
      if (schedule.time.kind === "every") {
        const minutes = schedule.time.unit === "minutes" ? steppedValues(0, 59, schedule.time.amount) : [0];
        const hours =
          schedule.time.unit === "hours" ? steppedValues(0, 23, schedule.time.amount) : steppedValues(0, 23, 1);
        return cronSpec(field(minutes), field(hours), day, field(schedule.months), weekday);
      }
      const parsed = [parseTime(schedule.time.time)];
      return cronSpec(
        field([...new Set(parsed.map(([, minute]) => minute))]),
        field([...new Set(parsed.map(([hour]) => hour))]),
        day,
        field(schedule.months),
        weekday,
        new Set(parsed.map(([hour, minute]) => `${hour}:${minute}`)),
      );
    }
    case "custom":
      return parseCron(schedule.expression);
  }
}

function cronSpec(
  minute: CronField,
  hour: CronField,
  day: CronField,
  month: CronField,
  weekday: CronField,
  exactTimes?: Set<string>,
): CronSpec {
  const result: CronSpec = { minute, hour, day, month, weekday };
  if (exactTimes) result.exactTimes = exactTimes;
  return result;
}

function nextCronOccurrence(spec: CronSpec, timezone: string, after: Date): Date {
  const start = zonedParts(after, timezone);
  const calendar = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const exactTimes = spec.exactTimes;
  const repeatedStartHour =
    zonedDateTimeCandidates({ ...start, minute: 0 }, timezone).length > 1 ||
    zonedDateTimeCandidates({ ...start, minute: 30 }, timezone).length > 1;
  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset += 1) {
    const current = new Date(calendar.getTime() + offset * 86_400_000);
    const year = current.getUTCFullYear();
    const month = current.getUTCMonth() + 1;
    const day = current.getUTCDate();
    const weekday = current.getUTCDay();
    if (!spec.month.values.includes(month)) continue;
    const dayMatches = spec.day.values.includes(day);
    const weekdayMatches = spec.weekday.values.includes(weekday);
    const calendarMatches =
      spec.day.wildcard && spec.weekday.wildcard
        ? true
        : spec.day.wildcard
          ? weekdayMatches
          : spec.weekday.wildcard
            ? dayMatches
            : dayMatches || weekdayMatches;
    if (!calendarMatches) continue;

    for (const hour of spec.hour.values) {
      for (const minute of spec.minute.values) {
        if (exactTimes && !exactTimes.has(`${hour}:${minute}`)) continue;
        if (
          offset === 0 &&
          (hour < start.hour || (hour === start.hour && minute < start.minute)) &&
          !(repeatedStartHour && hour === start.hour)
        ) {
          continue;
        }
        for (const candidate of zonedDateTimeCandidates({ year, month, day, weekday, hour, minute }, timezone)) {
          if (candidate.getTime() <= after.getTime()) continue;
          return candidate;
        }
      }
    }
  }
  throw new Error("The schedule has no occurrence within the next five years.");
}

function zonedDateTimeCandidates(parts: CalendarParts, timezone: string): Date[] {
  const approximate = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const result: Date[] = [];
  for (let offset = -18 * 60; offset <= 18 * 60; offset += 15) {
    const candidate = new Date(approximate + offset * 60_000);
    const value = zonedParts(candidate, timezone);
    if (
      value.year === parts.year &&
      value.month === parts.month &&
      value.day === parts.day &&
      value.hour === parts.hour &&
      value.minute === parts.minute
    ) {
      result.push(candidate);
    }
  }
  return result.sort((left, right) => left.getTime() - right.getTime());
}

function zonedParts(date: Date, timezone: string): CalendarParts {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday: WEEKDAY_INDEX[values.weekday ?? "Sun"] ?? 0,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error("The routine timezone is invalid.");
  }
}

function parseCron(expression: string): CronSpec {
  const values = expression.trim().split(/\s+/);
  if (values.length !== 5) throw new Error("Custom schedules must use five cron fields.");
  return cronSpec(
    parseCronField(values[0], 0, 59, "minute"),
    parseCronField(values[1], 0, 23, "hour"),
    parseCronField(values[2], 1, 31, "day"),
    parseCronField(values[3], 1, 12, "month"),
    parseCronField(values[4], 0, 6, "weekday", true),
  );
}

function parseCronField(
  source: string,
  minimum: number,
  maximum: number,
  label: string,
  sundayAlias = false,
): CronField {
  const wildcard = source === "*";
  const result = new Set<number>();
  for (const segment of source.split(",")) {
    const [rangeSource, stepSource] = segment.split("/");
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (!Number.isInteger(step) || step < 1) throw new Error(`The cron ${label} step is invalid.`);
    let start: number;
    let end: number;
    if (rangeSource === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeSource.includes("-")) {
      const pieces = rangeSource.split("-").map(Number);
      if (pieces.length !== 2) throw new Error(`The cron ${label} range is invalid.`);
      [start, end] = pieces;
    } else {
      start = Number(rangeSource);
      end = start;
    }
    const allowedMaximum = sundayAlias ? 7 : maximum;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < minimum || end > allowedMaximum || end < start) {
      throw new Error(`The cron ${label} value is invalid.`);
    }
    for (let value = start; value <= end; value += step) result.add(sundayAlias && value === 7 ? 0 : value);
  }
  if (result.size === 0) throw new Error(`The cron ${label} field is empty.`);
  return { values: [...result].sort((left, right) => left - right), wildcard };
}

function parseTime(value: string): [number, number] {
  const [hour, minute] = value.split(":").map(Number);
  return [hour, minute];
}

function field(values: number[]): CronField {
  return { values: [...new Set(values)].sort((left, right) => left - right), wildcard: false };
}

function wildcardField(minimum: number, maximum: number): CronField {
  return { values: steppedValues(minimum, maximum, 1), wildcard: true };
}

function steppedValues(minimum: number, maximum: number, step: number): number[] {
  const result: number[] = [];
  for (let value = minimum; value <= maximum; value += step) result.push(value);
  return result;
}

function intervalMilliseconds(amount: number, unit: RoutineIntervalUnit): number {
  const unitMs = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
  return amount * unitMs;
}

function displayTime(time: string): string {
  const [hour, minute] = parseTime(time);
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
