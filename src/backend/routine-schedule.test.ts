// @vitest-environment node

import { describe, expect, it } from "vitest";
import { nextRoutineOccurrence, validateRoutineSchedule } from "./routine-schedule";

describe("routine schedules", () => {
  it("calculates presets in Europe/Warsaw", () => {
    expect(
      nextRoutineOccurrence(
        { kind: "weekdays", time: "07:00" },
        "Europe/Warsaw",
        new Date("2026-08-28T08:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-08-31T05:00:00.000Z");

    expect(
      nextRoutineOccurrence(
        { kind: "monthly", day: 31, time: "09:00" },
        "Europe/Warsaw",
        new Date("2026-04-01T00:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-05-31T07:00:00.000Z");
  });

  it("skips a missing DST time and supports the repeated time", () => {
    expect(
      nextRoutineOccurrence(
        { kind: "daily", time: "02:30" },
        "Europe/Warsaw",
        new Date("2026-03-28T23:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-03-30T00:30:00.000Z");

    expect(
      nextRoutineOccurrence(
        { kind: "daily", time: "02:30" },
        "Europe/Warsaw",
        new Date("2026-10-25T00:45:00.000Z"),
      ).toISOString(),
    ).toBe("2026-10-25T01:30:00.000Z");
  });

  it("enforces the 15 minute limit", () => {
    expect(() =>
      validateRoutineSchedule(
        { kind: "interval", amount: 14, unit: "minutes", anchorAt: "2026-01-01T00:00:00.000Z" },
        "Europe/Warsaw",
      ),
    ).toThrow("at least 15 minutes");
    expect(() => validateRoutineSchedule({ kind: "custom", expression: "0,10 * * * *" }, "Europe/Warsaw")).toThrow(
      "no more often than every 15 minutes",
    );
    expect(() =>
      validateRoutineSchedule(
        {
          kind: "advanced",
          months: [1],
          days: { kind: "every-day" },
          time: { kind: "every", amount: 10, unit: "minutes" },
        },
        "Europe/Warsaw",
      ),
    ).toThrow("at least 15 minutes");
  });

  it("validates five-field cron and accepts Sunday as 7", () => {
    expect(() => validateRoutineSchedule({ kind: "custom", expression: "0 9 * *" }, "UTC")).toThrow("five cron fields");
    expect(() => validateRoutineSchedule({ kind: "custom", expression: "0 9 * * 5-7" }, "UTC")).not.toThrow();
    expect(
      nextRoutineOccurrence(
        { kind: "custom", expression: "0 9 * * 7" },
        "UTC",
        new Date("2026-08-29T10:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-08-30T09:00:00.000Z");
  });

  it("rejects invalid calendar values, dates, and time zones", () => {
    expect(() => validateRoutineSchedule({ kind: "daily", time: "24:00" }, "UTC")).toThrow("schedule is invalid");
    expect(() => validateRoutineSchedule({ kind: "monthly", day: 32, time: "09:00" }, "UTC")).toThrow(
      "schedule is invalid",
    );
    expect(() =>
      validateRoutineSchedule({ kind: "interval", amount: 15, unit: "minutes", anchorAt: "not-a-date" }, "UTC"),
    ).toThrow("schedule is invalid");
    expect(() => validateRoutineSchedule({ kind: "daily", time: "09:00" }, "Invalid/Timezone")).toThrow(
      "timezone is invalid",
    );
  });

  it("calculates each trigger independently", () => {
    const after = new Date("2026-08-25T08:05:00.000Z");
    expect(
      [
        nextRoutineOccurrence({ kind: "hourly", minute: 15 }, "UTC", after),
        nextRoutineOccurrence({ kind: "daily", time: "17:00" }, "UTC", after),
      ].map((date) => date.toISOString()),
    ).toEqual(["2026-08-25T08:15:00.000Z", "2026-08-25T17:00:00.000Z"]);
  });
});
