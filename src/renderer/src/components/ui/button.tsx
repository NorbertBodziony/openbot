import type { JSX } from "@solidjs/web";
import type { Ref } from "solid-js";
import { omit, Show } from "solid-js";
import { Spinner } from "./surface";
import { cx } from "./utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "class" | "disabled" | "ref"> {
  /** @internal Kobalte's polymorphic renderer passes these through custom components. */
  as?: unknown;
  component?: unknown;
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
  children?: JSX.Element;
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  fullWidth?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button(props: ButtonProps): JSX.Element {
  const local = props;
  const others = omit(
    local,
    "class",
    "children",
    "variant",
    "size",
    "loading",
    "loadingLabel",
    "fullWidth",
    "disabled",
    "as",
    "component",
  );
  return (
    <button
      class={cx("ui-button", local.fullWidth && "ui-button-full", local.class)}
      data-variant={local.variant ?? "secondary"}
      data-size={local.size ?? "md"}
      disabled={Boolean(local.disabled || local.loading)}
      aria-busy={local.loading ? "true" : undefined}
      {...others}
    >
      <Show when={local.loading}>
        <Spinner size="sm" />
      </Show>
      {local.loading && local.loadingLabel ? local.loadingLabel : local.children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "children" | "fullWidth"> {
  label: string;
  children: JSX.Element;
  tooltip?: string;
}

export function IconButton(props: IconButtonProps): JSX.Element {
  const local = props;
  const others = omit(props, "label", "tooltip", "children", "class", "size");
  return (
    <Button
      class={cx("ui-icon-button", local.class)}
      size={local.size ?? "sm"}
      aria-label={local.label}
      title={local.tooltip ?? local.label}
      {...others}
    >
      {local.children}
    </Button>
  );
}
