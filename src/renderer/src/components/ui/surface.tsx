import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import { cx } from "./utils";

export function Card(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const local = props;
  const others = omit(props, "class");
  return <div class={cx("ui-card", local.class)} {...others} />;
}

export interface SeparatorProps extends JSX.HTMLAttributes<HTMLHRElement> {
  orientation?: "horizontal" | "vertical";
}

export function Separator(props: SeparatorProps): JSX.Element {
  const local = props;
  const others = omit(props, "class", "orientation");
  const orientation = local.orientation ?? "horizontal";
  return (
    <hr
      class={cx("ui-separator", local.class)}
      data-orientation={orientation}
      aria-orientation={orientation}
      {...others}
    />
  );
}

export interface SpinnerProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  size?: "sm" | "md" | "lg";
  label?: string;
}

export function Spinner(props: SpinnerProps): JSX.Element {
  const local = props;
  const others = omit(props, "class", "size", "label");
  return (
    <span
      class={cx("ui-spinner", local.class)}
      data-size={local.size ?? "md"}
      role="status"
      aria-label={local.label}
      aria-hidden={local.label ? undefined : "true"}
      {...others}
    />
  );
}

export function Skeleton(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const local = props;
  const others = omit(props, "class");
  return <div class={cx("ui-skeleton", local.class)} aria-hidden="true" {...others} />;
}

export function Kbd(props: JSX.HTMLAttributes<HTMLElement>): JSX.Element {
  const local = props;
  const others = omit(props, "class");
  return <kbd class={cx("ui-kbd", local.class)} {...others} />;
}
