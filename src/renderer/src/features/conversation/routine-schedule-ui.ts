import type { RoutineSchedule } from "@openbot/contracts/ipc";

export interface RoutineSelectOption {
  value: string;
  label: string;
}

export const ROUTINE_SCHEDULE_KINDS: RoutineSelectOption[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "interval", label: "Interval" },
  { value: "advanced", label: "Advanced" },
  { value: "custom", label: "Custom" },
];

export const ROUTINE_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const ROUTINE_WEEKDAY_OPTIONS = ROUTINE_WEEKDAYS.map((label, value) => ({
  value: String(value),
  label,
}));

export const ROUTINE_INTERVAL_UNIT_OPTIONS: RoutineSelectOption[] = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
];

export const ROUTINE_SHORT_INTERVAL_UNIT_OPTIONS = ROUTINE_INTERVAL_UNIT_OPTIONS.slice(0, 2);

export const ROUTINE_DAY_KIND_OPTIONS: RoutineSelectOption[] = [
  { value: "every-day", label: "Every day" },
  { value: "days-of-week", label: "Days of week" },
  { value: "days-of-month", label: "Days of month" },
];

export const ROUTINE_TIME_MODE_OPTIONS: RoutineSelectOption[] = [
  { value: "at-time", label: "At time" },
  { value: "every", label: "Every" },
];

export const ROUTINE_HOUR_MINUTE_OPTIONS: RoutineSelectOption[] = [0, 15, 30, 45].map((minute) => ({
  value: String(minute),
  label: `:${String(minute).padStart(2, "0")}`,
}));

export const ROUTINE_TIME_OPTIONS: RoutineSelectOption[] = Array.from({ length: 96 }, (_, index) => {
  const hour = Math.floor(index / 4);
  const minute = (index % 4) * 15;
  const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { value, label: formatRoutineClock(value) };
});

export function defaultRoutineSchedule(kind: RoutineSchedule["kind"]): RoutineSchedule {
  switch (kind) {
    case "hourly":
      return { kind, minute: 0 };
    case "daily":
    case "weekdays":
      return { kind, time: "09:00" };
    case "weekly":
      return { kind, weekday: 1, time: "09:00" };
    case "monthly":
      return { kind, day: 1, time: "09:00" };
    case "interval":
      return { kind, amount: 15, unit: "minutes", anchorAt: new Date().toISOString() };
    case "advanced":
      return {
        kind,
        months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        days: { kind: "every-day" },
        time: { kind: "at-time", time: "09:00" },
      };
    case "custom":
      return { kind, expression: "0 9 * * 1-5" };
  }
}

export function routineScheduleSummary(schedule: RoutineSchedule, sentence = false): string {
  const prefix = sentence ? "On " : "";
  switch (schedule.kind) {
    case "hourly":
      return `Every hour at :${String(schedule.minute).padStart(2, "0")}`;
    case "daily":
      return `${sentence ? "On every" : "Every"} day at ${formatRoutineClock(schedule.time)}`;
    case "weekdays":
      return `${sentence ? "On weekdays" : "Weekdays"} at ${formatRoutineClock(schedule.time)}`;
    case "weekly":
      return `${prefix}${ROUTINE_WEEKDAYS[schedule.weekday]} at ${formatRoutineClock(schedule.time)}`;
    case "monthly":
      return `${prefix}day ${schedule.day} of every month at ${formatRoutineClock(schedule.time)}`;
    case "interval":
      return `Every ${schedule.amount} ${schedule.unit}`;
    case "advanced":
      return "Advanced schedule";
    case "custom":
      return `Cron ${schedule.expression}`;
  }
}

export function formatRoutineClock(value: string): string {
  const [hourText = "0", minuteText = "0"] = value.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

export function routineTimeMinutes(value: string): number {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function routineScheduleKind(value: string): RoutineSchedule["kind"] {
  if (
    value === "hourly" ||
    value === "daily" ||
    value === "weekdays" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "interval" ||
    value === "advanced" ||
    value === "custom"
  ) {
    return value;
  }
  return "daily";
}

export function scheduleOfKind(
  value: RoutineSchedule,
  kind: "hourly",
): Extract<RoutineSchedule, { kind: "hourly" }> | null;
export function scheduleOfKind(
  value: RoutineSchedule,
  kind: "weekly",
): Extract<RoutineSchedule, { kind: "weekly" }> | null;
export function scheduleOfKind(
  value: RoutineSchedule,
  kind: "monthly",
): Extract<RoutineSchedule, { kind: "monthly" }> | null;
export function scheduleOfKind(
  value: RoutineSchedule,
  kind: "interval",
): Extract<RoutineSchedule, { kind: "interval" }> | null;
export function scheduleOfKind(
  value: RoutineSchedule,
  kind: "custom",
): Extract<RoutineSchedule, { kind: "custom" }> | null;
export function scheduleOfKind(
  value: RoutineSchedule,
  kind: "advanced",
): Extract<RoutineSchedule, { kind: "advanced" }> | null;
export function scheduleOfKind(value: RoutineSchedule, kind: RoutineSchedule["kind"]): RoutineSchedule | null {
  return value.kind === kind ? value : null;
}

export function dailyRoutineSchedule(
  value: RoutineSchedule,
): Extract<RoutineSchedule, { kind: "daily" | "weekdays" }> | null {
  return value.kind === "daily" || value.kind === "weekdays" ? value : null;
}

export function routineAtTime(
  value: Extract<RoutineSchedule, { kind: "advanced" }>["time"],
): Extract<Extract<RoutineSchedule, { kind: "advanced" }>["time"], { kind: "at-time" }> | null {
  return value.kind === "at-time" ? value : null;
}

export function routineIntervalUnit(value: string): "minutes" | "hours" | "days" {
  return value === "hours" || value === "days" ? value : "minutes";
}

export function routineShortIntervalUnit(value: string): "minutes" | "hours" {
  return value === "hours" ? "hours" : "minutes";
}

export function routineDayKind(value: string): "every-day" | "days-of-week" | "days-of-month" {
  return value === "days-of-week" || value === "days-of-month" ? value : "every-day";
}

export function routineIntegerValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function routineNumberList(value: string): number[] {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item));
}
