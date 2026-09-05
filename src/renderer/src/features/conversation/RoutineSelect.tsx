import { createMemo } from "solid-js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui";
import {
  formatRoutineClock,
  ROUTINE_TIME_OPTIONS,
  type RoutineSelectOption,
  routineTimeMinutes,
} from "./routine-schedule-ui";

interface RoutineSelectProps {
  ariaLabel: string;
  value: string;
  options: RoutineSelectOption[];
  onChange: (value: string) => void;
  class?: string;
  contentClass?: string;
  scrollSelected?: boolean;
}

export function RoutineSelect(props: RoutineSelectProps) {
  const selected = () => props.options.find((option) => option.value === props.value) ?? null;
  return (
    <Select<RoutineSelectOption>
      class={props.class}
      options={props.options}
      value={selected()}
      optionValue="value"
      optionTextValue="label"
      onOpenChange={(open) => {
        if (!open || !props.scrollSelected) return;
        window.requestAnimationFrame(() => {
          document
            .querySelector(`${props.contentClass ? `.${props.contentClass}` : ".ui-select-content"} [data-selected]`)
            ?.scrollIntoView({ block: "center" });
        });
      }}
      onChange={(option) => {
        if (option) props.onChange(option.value);
      }}
      itemComponent={(item) => <SelectItem item={item.item}>{item.item.rawValue.label}</SelectItem>}
    >
      <SelectTrigger size="sm" aria-label={props.ariaLabel}>
        <SelectValue<RoutineSelectOption>>{(state) => state.selectedOption()?.label ?? "Select"}</SelectValue>
      </SelectTrigger>
      <SelectContent class={props.contentClass} />
    </Select>
  );
}

interface TimeSelectProps {
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
}

export function TimeSelect(props: TimeSelectProps) {
  const options = createMemo(() => {
    if (ROUTINE_TIME_OPTIONS.some((option) => option.value === props.value)) return ROUTINE_TIME_OPTIONS;
    return [...ROUTINE_TIME_OPTIONS, { value: props.value, label: formatRoutineClock(props.value) }].sort(
      (left, right) => routineTimeMinutes(left.value) - routineTimeMinutes(right.value),
    );
  });
  return (
    <RoutineSelect
      ariaLabel={props.ariaLabel ?? "Time"}
      class="agent-routine-time-select"
      contentClass="agent-routine-time-select-content"
      options={options()}
      value={props.value}
      scrollSelected
      onChange={props.onChange}
    />
  );
}
