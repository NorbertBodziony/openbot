import { Show } from "solid-js";
import { Button, Clock3, Marker, MarkerContent, MarkerIcon, Tooltip } from "../ui";

export type RoutineEventAction = "created" | "updated" | "deleted";

interface RoutineEventBaseProps {
  routineId: string;
  routineName: string;
}

interface ActiveRoutineEventMarkerProps extends RoutineEventBaseProps {
  action: Exclude<RoutineEventAction, "deleted">;
  onOpenRoutine: (routineId: string) => void;
}

interface DeletedRoutineEventMarkerProps extends RoutineEventBaseProps {
  action: "deleted";
  onOpenRoutine?: never;
}

export type RoutineEventMarkerProps = ActiveRoutineEventMarkerProps | DeletedRoutineEventMarkerProps;

const ROUTINE_EVENT_LABELS: Record<RoutineEventAction, string> = {
  created: "Created routine",
  updated: "Updated routine",
  deleted: "Deleted routine",
};

export function RoutineEventMarker(props: RoutineEventMarkerProps) {
  const actionLabel = () => ROUTINE_EVENT_LABELS[props.action];

  return (
    <Marker class="routine-event-marker">
      <MarkerContent class="routine-event-content">
        <span class="routine-event-label">{actionLabel()}</span>
        <Show
          when={props.action === "deleted"}
          fallback={
            <Button
              type="button"
              variant="ghost"
              class="routine-event-pill routine-event-pill-interactive"
              aria-label={`Open routine ${props.routineName}`}
              onClick={() => {
                if (props.action !== "deleted") props.onOpenRoutine(props.routineId);
              }}
            >
              <RoutineEventPillContent routineName={props.routineName} />
            </Button>
          }
        >
          <Tooltip.Root openDelay={100} closeDelay={75} placement="top" gutter={6}>
            <Tooltip.Trigger
              as="span"
              class="routine-event-pill routine-event-pill-deleted"
              aria-label={`${props.routineName}, deleted`}
              tabindex={0}
            >
              <RoutineEventPillContent routineName={props.routineName} />
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content class="ui-tooltip routine-event-tooltip">Deleted</Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Show>
      </MarkerContent>
    </Marker>
  );
}

function RoutineEventPillContent(props: { routineName: string }) {
  return (
    <>
      <MarkerIcon>
        <Clock3 aria-hidden="true" />
      </MarkerIcon>
      <span class="routine-event-pill-name">{props.routineName}</span>
    </>
  );
}
