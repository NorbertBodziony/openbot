import { Match, Switch } from "solid-js";

export type LandingIconName = "arrow-up-right" | "chevron-down" | "contact" | "download" | "heart";

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
