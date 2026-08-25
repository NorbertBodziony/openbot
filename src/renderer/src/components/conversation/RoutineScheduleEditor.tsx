import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { RoutineSchedule } from "@openbot/contracts/ipc";
import { Clock3 } from "lucide-solid";
import { Show } from "solid-js";
import { Button, Input } from "../ui";
import { RoutineSelect, TimeSelect } from "./RoutineSelect";
import {
  dailyRoutineSchedule,
  defaultRoutineSchedule,
  ROUTINE_DAY_KIND_OPTIONS,
  ROUTINE_HOUR_MINUTE_OPTIONS,
  ROUTINE_INTERVAL_UNIT_OPTIONS,
  ROUTINE_SCHEDULE_KINDS,
  ROUTINE_SHORT_INTERVAL_UNIT_OPTIONS,
  ROUTINE_TIME_MODE_OPTIONS,
  ROUTINE_WEEKDAY_OPTIONS,
  routineAtTime,
  routineDayKind,
  routineIntegerValue,
  routineIntervalUnit,
  routineNumberList,
  routineScheduleKind,
  routineScheduleSummary,
  routineShortIntervalUnit,
  scheduleOfKind,
} from "./routine-schedule-ui";

interface RoutineScheduleEditorProps {
  schedule: RoutineSchedule;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onChange: (schedule: RoutineSchedule) => void;
}

export function RoutineScheduleEditor(props: RoutineScheduleEditorProps) {
  return (
    <section class="agent-routine-when" aria-labelledby="routine-when-heading">
      <h3 id="routine-when-heading">When to run</h3>
      <div class="agent-routine-schedule-card">
        <Button
          variant="ghost"
          type="button"
          class="agent-routine-schedule-summary"
          aria-expanded={props.expanded ? "true" : "false"}
          onClick={() => props.onExpandedChange(!props.expanded)}
        >
          <Clock3 aria-hidden="true" />
          <span>{routineScheduleSummary(props.schedule, true)}</span>
        </Button>
        <Show when={props.expanded}>
          <div class="agent-routine-schedule-controls">
            <div class="agent-routine-field agent-routine-frequency-field">
              <span>Frequency</span>
              <RoutineSelect
                ariaLabel="Frequency"
                options={ROUTINE_SCHEDULE_KINDS}
                value={props.schedule.kind}
                onChange={(value) => props.onChange(defaultRoutineSchedule(routineScheduleKind(value)))}
              />
            </div>
            <ScheduleFields schedule={props.schedule} onChange={props.onChange} />
          </div>
        </Show>
      </div>
    </section>
  );
}

function ScheduleFields(props: { schedule: RoutineSchedule; onChange: (schedule: RoutineSchedule) => void }) {
  return (
    <div class="agent-routine-schedule-fields">
      <Show when={scheduleOfKind(props.schedule, "hourly")}>
        {(schedule) => (
          <div class="agent-routine-field">
            <span>Minute</span>
            <RoutineSelect
              ariaLabel="Minute"
              options={ROUTINE_HOUR_MINUTE_OPTIONS}
              value={String(schedule().minute)}
              onChange={(minute) => props.onChange({ kind: "hourly", minute: Number(minute) })}
            />
          </div>
        )}
      </Show>
      <Show when={dailyRoutineSchedule(props.schedule)}>
        {(schedule) => (
          <div class="agent-routine-field">
            <span>Time</span>
            <TimeSelect value={schedule().time} onChange={(time) => props.onChange({ kind: schedule().kind, time })} />
          </div>
        )}
      </Show>
      <Show when={scheduleOfKind(props.schedule, "weekly")}>
        {(schedule) => (
          <div class="agent-routine-inline-fields">
            <div class="agent-routine-field">
              <span>Day</span>
              <RoutineSelect
                ariaLabel="Day"
                options={ROUTINE_WEEKDAY_OPTIONS}
                value={String(schedule().weekday)}
                onChange={(weekday) => props.onChange({ ...schedule(), weekday: Number(weekday) })}
              />
            </div>
            <div class="agent-routine-field">
              <span>Time</span>
              <TimeSelect value={schedule().time} onChange={(time) => props.onChange({ ...schedule(), time })} />
            </div>
          </div>
        )}
      </Show>
      <Show when={scheduleOfKind(props.schedule, "monthly")}>
        {(schedule) => (
          <div class="agent-routine-inline-fields">
            <label class="agent-routine-field">
              <span>Day</span>
              <Input
                size="sm"
                type="number"
                min="1"
                max="31"
                value={String(schedule().day)}
                onValueChange={(value) => props.onChange({ ...schedule(), day: routineIntegerValue(value, 1) })}
              />
            </label>
            <div class="agent-routine-field">
              <span>Time</span>
              <TimeSelect value={schedule().time} onChange={(time) => props.onChange({ ...schedule(), time })} />
            </div>
          </div>
        )}
      </Show>
      <Show when={scheduleOfKind(props.schedule, "interval")}>
        {(schedule) => (
          <div class="agent-routine-inline-fields">
            <label class="agent-routine-field">
              <span>Every</span>
              <Input
                size="sm"
                type="number"
                min="1"
                value={String(schedule().amount)}
                onValueChange={(value) => props.onChange({ ...schedule(), amount: routineIntegerValue(value, 1) })}
              />
            </label>
            <div class="agent-routine-field">
              <span>Unit</span>
              <RoutineSelect
                ariaLabel="Unit"
                options={ROUTINE_INTERVAL_UNIT_OPTIONS}
                value={schedule().unit}
                onChange={(unit) => props.onChange({ ...schedule(), unit: routineIntervalUnit(unit) })}
              />
            </div>
          </div>
        )}
      </Show>
      <Show when={scheduleOfKind(props.schedule, "custom")}>
        {(schedule) => (
          <label class="agent-routine-field">
            <span>Cron expression</span>
            <Input
              size="sm"
              maxlength={INPUT_LIMITS.routineCron}
              value={schedule().expression}
              placeholder="0 9 * * 1-5"
              onValueChange={(expression) => props.onChange({ kind: "custom", expression })}
            />
          </label>
        )}
      </Show>
      <Show when={scheduleOfKind(props.schedule, "advanced")}>
        {(schedule) => <AdvancedScheduleFields schedule={schedule()} onChange={props.onChange} />}
      </Show>
    </div>
  );
}

function AdvancedScheduleFields(props: {
  schedule: Extract<RoutineSchedule, { kind: "advanced" }>;
  onChange: (schedule: RoutineSchedule) => void;
}) {
  const dayValues = () => (props.schedule.days.kind === "every-day" ? [] : props.schedule.days.days);
  return (
    <div class="agent-routine-advanced-fields">
      <label class="agent-routine-field">
        <span>Months</span>
        <Input
          size="sm"
          value={props.schedule.months.join(", ")}
          placeholder="1, 2, 12"
          onValueChange={(months) => props.onChange({ ...props.schedule, months: routineNumberList(months) })}
        />
      </label>
      <div class="agent-routine-inline-fields">
        <div class="agent-routine-field">
          <span>Days</span>
          <RoutineSelect
            ariaLabel="Days"
            options={ROUTINE_DAY_KIND_OPTIONS}
            value={props.schedule.days.kind}
            onChange={(value) => {
              const kind = routineDayKind(value);
              props.onChange({
                ...props.schedule,
                days: kind === "every-day" ? { kind } : { kind, days: [1] },
              });
            }}
          />
        </div>
        <Show when={props.schedule.days.kind !== "every-day"}>
          <label class="agent-routine-field">
            <span>Values</span>
            <Input
              size="sm"
              value={dayValues().join(", ")}
              placeholder={props.schedule.days.kind === "days-of-week" ? "1, 3, 5" : "1, 15, 31"}
              onValueChange={(value) => {
                const days = props.schedule.days;
                if (days.kind !== "every-day") {
                  props.onChange({ ...props.schedule, days: { ...days, days: routineNumberList(value) } });
                }
              }}
            />
          </label>
        </Show>
      </div>
      <div class="agent-routine-inline-fields">
        <div class="agent-routine-field">
          <span>Time mode</span>
          <RoutineSelect
            ariaLabel="Time mode"
            options={ROUTINE_TIME_MODE_OPTIONS}
            value={props.schedule.time.kind}
            onChange={(value) =>
              props.onChange({
                ...props.schedule,
                time:
                  value === "at-time"
                    ? { kind: "at-time", time: "09:00" }
                    : { kind: "every", amount: 15, unit: "minutes" },
              })
            }
          />
        </div>
        <Show
          when={routineAtTime(props.schedule.time)}
          fallback={
            <>
              <label class="agent-routine-field">
                <span>Amount</span>
                <Input
                  size="sm"
                  type="number"
                  min="1"
                  value={String(props.schedule.time.kind === "every" ? props.schedule.time.amount : 15)}
                  onValueChange={(value) => {
                    if (props.schedule.time.kind === "every") {
                      props.onChange({
                        ...props.schedule,
                        time: { ...props.schedule.time, amount: routineIntegerValue(value, 1) },
                      });
                    }
                  }}
                />
              </label>
              <div class="agent-routine-field">
                <span>Unit</span>
                <RoutineSelect
                  ariaLabel="Advanced time unit"
                  options={ROUTINE_SHORT_INTERVAL_UNIT_OPTIONS}
                  value={props.schedule.time.kind === "every" ? props.schedule.time.unit : "minutes"}
                  onChange={(unit) => {
                    if (props.schedule.time.kind === "every") {
                      props.onChange({
                        ...props.schedule,
                        time: { ...props.schedule.time, unit: routineShortIntervalUnit(unit) },
                      });
                    }
                  }}
                />
              </div>
            </>
          }
        >
          {(time) => (
            <div class="agent-routine-field">
              <span>Time</span>
              <TimeSelect
                ariaLabel="Advanced time"
                value={time().time}
                onChange={(value) => props.onChange({ ...props.schedule, time: { kind: "at-time", time: value } })}
              />
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
