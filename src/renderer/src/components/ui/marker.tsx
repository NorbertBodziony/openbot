import { Dynamic, type JSX } from "@solidjs/web";
import { omit } from "solid-js";
import { cx } from "./utils";

type MarkerElement = "div" | "li" | "section";

export interface MarkerProps extends JSX.HTMLAttributes<HTMLElement> {
  as?: MarkerElement;
}

export function Marker(props: MarkerProps): JSX.Element {
  const others = omit(props, "as", "class");
  return <Dynamic component={props.as ?? "div"} data-slot="marker" class={cx("ui-marker", props.class)} {...others} />;
}

export interface MarkerIconProps extends JSX.HTMLAttributes<HTMLSpanElement> {}

export function MarkerIcon(props: MarkerIconProps): JSX.Element {
  const others = omit(props, "class");
  return <span data-slot="marker-icon" class={cx("ui-marker-icon", props.class)} {...others} />;
}

export interface MarkerContentProps extends JSX.HTMLAttributes<HTMLSpanElement> {}

export function MarkerContent(props: MarkerContentProps): JSX.Element {
  const others = omit(props, "class");
  return <span data-slot="marker-content" class={cx("ui-marker-content", props.class)} {...others} />;
}
