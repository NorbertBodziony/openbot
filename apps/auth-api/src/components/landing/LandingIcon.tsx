import { Match, Switch } from "solid-js";

export type LandingIconName =
  | "arrow-up-right"
  | "browser"
  | "check"
  | "chevron-down"
  | "contact"
  | "context"
  | "download"
  | "file"
  | "handoff"
  | "heart"
  | "plus"
  | "search"
  | "send"
  | "workspace";

export interface LandingIconProps {
  name: LandingIconName;
  class?: string;
  label?: string;
}

export function LandingIcon(props: LandingIconProps) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.label ? undefined : "true"}
      aria-label={props.label}
      role={props.label ? "img" : undefined}
      data-icon={props.name}
    >
      <Switch>
        <Match when={props.name === "download"}>
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </Match>
        <Match when={props.name === "contact"}>
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
        </Match>
        <Match when={props.name === "chevron-down"}>
          <path d="m6 9 6 6 6-6" />
        </Match>
        <Match when={props.name === "browser"}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 8h18" />
          <path d="M7 6h.01M10 6h.01" />
        </Match>
        <Match when={props.name === "check"}>
          <path d="m5 12 4 4L19 6" />
        </Match>
        <Match when={props.name === "context"}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" />
        </Match>
        <Match when={props.name === "file"}>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v5h5" />
        </Match>
        <Match when={props.name === "handoff"}>
          <path d="M5 7h11" />
          <path d="m13 4 3 3-3 3" />
          <path d="M19 17H8" />
          <path d="m11 14-3 3 3 3" />
        </Match>
        <Match when={props.name === "plus"}>
          <path d="M12 5v14M5 12h14" />
        </Match>
        <Match when={props.name === "search"}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        </Match>
        <Match when={props.name === "send"}>
          <path d="m5 12 7-7 7 7" />
          <path d="M12 19V5" />
        </Match>
        <Match when={props.name === "workspace"}>
          <path d="M3 7h7l2 2h9v11H3z" />
          <path d="M3 7V5h7l2 2" />
        </Match>
        <Match when={props.name === "arrow-up-right"}>
          <path d="M7 17 17 7" />
          <path d="M7 7h10v10" />
        </Match>
        <Match when={props.name === "heart"}>
          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
        </Match>
      </Switch>
    </svg>
  );
}
