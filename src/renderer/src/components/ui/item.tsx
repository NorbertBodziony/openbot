import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import { cx } from "./utils";

export interface ItemGroupProps extends JSX.HTMLAttributes<HTMLDivElement> {
  surface?: "default" | "subtle";
}

export function ItemGroup(props: ItemGroupProps): JSX.Element {
  const others = omit(props, "class", "surface");
  return <div class={cx("ui-item-group", props.class)} data-surface={props.surface ?? "default"} {...others} />;
}

export interface ItemProps extends JSX.HTMLAttributes<HTMLDivElement> {
  size?: "compact" | "default" | "spacious";
}

export function Item(props: ItemProps): JSX.Element {
  const others = omit(props, "class", "size");
  return <div class={cx("ui-item", props.class)} data-size={props.size ?? "default"} {...others} />;
}

export function ItemMedia(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const others = omit(props, "class");
  return <div class={cx("ui-item-media", props.class)} {...others} />;
}

export function ItemContent(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const others = omit(props, "class");
  return <div class={cx("ui-item-content", props.class)} {...others} />;
}

export function ItemTitle(props: JSX.HTMLAttributes<HTMLElement>): JSX.Element {
  const others = omit(props, "class");
  return <strong class={cx("ui-item-title", props.class)} {...others} />;
}

export function ItemDescription(props: JSX.HTMLAttributes<HTMLSpanElement>): JSX.Element {
  const others = omit(props, "class");
  return <span class={cx("ui-item-description", props.class)} {...others} />;
}

export function ItemActions(props: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  const others = omit(props, "class");
  return <div class={cx("ui-item-actions", props.class)} {...others} />;
}
