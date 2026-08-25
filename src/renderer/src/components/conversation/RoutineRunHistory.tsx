import type { RoutineRun } from "@openbot/contracts/ipc";
import { Check, CirclePause, Clock3, TriangleAlert, X } from "lucide-solid";
import { For, Show } from "solid-js";

interface RoutineRunHistoryProps {
  runs: RoutineRun[];
}

export function RoutineRunHistory(props: RoutineRunHistoryProps) {
  return (
    <section class="agent-routine-history" aria-labelledby="routine-history-heading">
      <h3 id="routine-history-heading">Run history</h3>
      <Show when={props.runs.length > 0} fallback={<p class="agent-routines-empty">No runs yet.</p>}>
        <div class="agent-routine-run-list">
          <For each={props.runs}>
            {(run) => (
              <div class="agent-routine-run-row">
                <span>
                  {run.kind === "manual"
                    ? `Manual · ${formatRoutineRunTime(run.scheduledFor)}`
                    : formatRoutineRunTime(run.scheduledFor)}
                </span>
                <RoutineRunStatus status={run.status} />
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function RoutineRunStatus(props: { status: RoutineRun["status"] }) {
  const label = () => routineRunStatusLabel(props.status);
  return (
    <span
      class={`agent-routine-run-icon agent-routine-run-icon-${props.status}`}
      role="img"
      aria-label={label()}
      title={label()}
    >
      <Show when={props.status === "succeeded"}>
        <Check aria-hidden="true" />
      </Show>
      <Show when={props.status === "failed"}>
        <X aria-hidden="true" />
      </Show>
      <Show when={props.status === "needs-attention"}>
        <TriangleAlert aria-hidden="true" />
      </Show>
      <Show when={props.status === "queued" || props.status === "running"}>
        <Clock3 aria-hidden="true" />
      </Show>
      <Show when={props.status === "interrupted" || props.status === "cancelled"}>
        <CirclePause aria-hidden="true" />
      </Show>
    </span>
  );
}

function formatRoutineRunTime(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  if (sameCalendarDay(date, today)) return `Today at ${time}`;
  if (sameCalendarDay(date, yesterday)) return `Yesterday at ${time}`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function sameCalendarDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function routineRunStatusLabel(status: RoutineRun["status"]): string {
  return status === "needs-attention" ? "Needs attention" : `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}
