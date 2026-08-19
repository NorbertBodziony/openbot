import type { JSX } from "@solidjs/web";
import { omit, Show } from "solid-js";
import { cx } from "./utils";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type BadgeSize = "sm" | "md";
export type BadgeRadius = "rounded" | "pill";

export interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  shape?: BadgeRadius;
  dot?: boolean;
}

export function Badge(props: BadgeProps): JSX.Element {
  const local = props;
  const others = omit(props, "tone", "size", "shape", "dot", "class", "children");
  return (
    <span
      class={cx("ui-badge", local.class)}
      data-tone={local.tone ?? "neutral"}
      data-size={local.size ?? "md"}
      data-shape={local.shape ?? "rounded"}
      {...others}
    >
      <Show when={local.dot}>
        <span class="ui-badge-dot" aria-hidden="true" />
      </Show>
      {local.children}
    </span>
  );
}
