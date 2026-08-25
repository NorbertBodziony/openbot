import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as SwitchPrimitive from "@kobalte/core/switch";
import type { ComponentProps, JSX, ValidComponent } from "@solidjs/web";
import { createSignal, createUniqueId, omit, Show } from "solid-js";
import { cx } from "./utils";

export type SwitchSize = "sm" | "default";

type SwitchAccessibilityProps = {
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
};

type OpenBotSwitchProps = SwitchAccessibilityProps & {
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  size?: SwitchSize;
};

export type SwitchProps<T extends ValidComponent = "div"> = PolymorphicProps<T, SwitchPrimitive.SwitchRootProps<T>> &
  OpenBotSwitchProps &
  Partial<Pick<ComponentProps<T>, "class">>;

export function Switch<T extends ValidComponent = "div">(props: SwitchProps<T>): JSX.Element {
  const [pointerFocus, setPointerFocus] = createSignal(false);
  const others = omit(props, "class", "size", "id", "aria-label", "aria-labelledby", "aria-describedby");
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: Solid 2's omit cannot preserve Kobalte's generic polymorphic props.
  const rootProps = others as PolymorphicProps<T, SwitchPrimitive.SwitchRootProps<T>>;

  return (
    <SwitchPrimitive.Root<T>
      data-slot="switch"
      data-size={props.size ?? "default"}
      data-pointer-focus={pointerFocus() ? "" : undefined}
      class={cx("ui-switch", props.class)}
      {...rootProps}
    >
      <SwitchPrimitive.Input
        id={props.id}
        data-slot="switch-input"
        class="ui-switch-input"
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-describedby={props["aria-describedby"]}
        onKeyDown={() => setPointerFocus(false)}
        onBlur={() => setPointerFocus(false)}
      />
      <SwitchPrimitive.Control
        data-slot="switch-control"
        class="ui-switch-control"
        onPointerDown={(event) => {
          setPointerFocus(true);
          event.preventDefault();
        }}
        onClick={(event) => event.preventDefault()}
      >
        <SwitchPrimitive.Thumb data-slot="switch-thumb" class="ui-switch-thumb" />
      </SwitchPrimitive.Control>
    </SwitchPrimitive.Root>
  );
}

export interface SwitchFieldProps extends Omit<SwitchProps<"div">, "aria-label" | "children" | "class" | "id"> {
  class?: string;
  switchClass?: string;
  id?: string;
  label: JSX.Element;
  description?: JSX.Element;
}

export function SwitchField(props: SwitchFieldProps): JSX.Element {
  const generatedId = `switch-field-${createUniqueId()}`;
  const switchId = () => props.id ?? generatedId;
  const descriptionId = () => `${switchId()}-description`;
  const others = omit(props, "class", "switchClass", "id", "label", "description");

  return (
    <div class={cx("ui-switch-field", props.class)}>
      <span class="ui-switch-copy">
        <label class="ui-switch-label" for={switchId()} onPointerDown={(event) => event.preventDefault()}>
          {props.label}
        </label>
        <Show when={props.description}>
          <span id={descriptionId()} class="ui-switch-description">
            {props.description}
          </span>
        </Show>
      </span>
      <Switch
        id={switchId()}
        class={props.switchClass}
        aria-describedby={props.description ? descriptionId() : undefined}
        {...others}
      />
    </div>
  );
}
