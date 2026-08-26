import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import { cx } from "./utils";

export type AlertTone = "neutral" | "success" | "warning" | "danger";

export interface AlertProps extends JSX.HTMLAttributes<HTMLDivElement> {
  tone?: AlertTone;
}

export function Alert(props: AlertProps): JSX.Element {
  const others = omit(props, "class", "tone");
  return <div class={cx("ui-alert", props.class)} data-tone={props.tone ?? "neutral"} {...others} />;
}

export function AlertIcon(props: JSX.HTMLAttributes<HTMLSpanElement>): JSX.Element {
  const others = omit(props, "class");
  return <span class={cx("ui-alert-icon", props.class)} aria-hidden="true" {...others} />;
}

export function AlertContent(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const others = omit(props, "class");
  return <div class={cx("ui-alert-content", props.class)} {...others} />;
}

export function AlertTitle(props: JSX.HTMLAttributes<HTMLElement>): JSX.Element {
  const others = omit(props, "class");
  return <strong class={cx("ui-alert-title", props.class)} {...others} />;
}

export function AlertDescription(props: JSX.HTMLAttributes<HTMLSpanElement>): JSX.Element {
  const others = omit(props, "class");
  return <span class={cx("ui-alert-description", props.class)} {...others} />;
}

export function AlertActions(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const others = omit(props, "class");
  return <div class={cx("ui-alert-actions", props.class)} {...others} />;
}
