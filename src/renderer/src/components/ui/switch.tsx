import * as SwitchPrimitive from "@kobalte/core/switch";
import type { JSX } from "@solidjs/web";
import { omit, Show } from "solid-js";
import { cx } from "./utils";

export interface SwitchProps extends SwitchPrimitive.SwitchRootOptions {
  class?: string;
  size?: "sm" | "md";
  label?: JSX.Element;
  description?: JSX.Element;
  "aria-label"?: string;
}

export function Switch(props: SwitchProps): JSX.Element {
  const local = props;
  const others = omit(props, "class", "size", "label", "description", "aria-label");
  return (
    <SwitchPrimitive.Root class={cx("ui-switch", local.class)} data-size={local.size ?? "md"} {...others}>
      <Show when={local.label || local.description}>
        <span class="ui-switch-copy">
          <Show when={local.label}>
            <SwitchPrimitive.Label class="ui-switch-label">{local.label}</SwitchPrimitive.Label>
          </Show>
          <Show when={local.description}>
            <SwitchPrimitive.Description class="ui-switch-description">{local.description}</SwitchPrimitive.Description>
          </Show>
        </span>
      </Show>
      <SwitchPrimitive.Input class="ui-switch-input" aria-label={local["aria-label"]} />
      <SwitchPrimitive.Control class="ui-switch-control">
        <SwitchPrimitive.Thumb class="ui-switch-thumb" />
      </SwitchPrimitive.Control>
    </SwitchPrimitive.Root>
  );
}
