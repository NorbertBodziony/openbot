import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import { Check } from "./icons";
import { cx } from "./utils";

export interface CheckboxProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  class?: string;
}

export function Checkbox(props: CheckboxProps): JSX.Element {
  const local = props;
  const others = omit(props, "class", "type");
  return (
    <span class={cx("ui-checkbox", local.class)}>
      <input class="ui-checkbox-input" type="checkbox" {...others} />
      <span class="ui-checkbox-visual" aria-hidden="true">
        <Check />
      </span>
    </span>
  );
}
