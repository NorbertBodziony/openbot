import type { JSX } from "@solidjs/web";
import { omit, Show } from "solid-js";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "./item";
import { cx } from "./utils";

export interface DynamicIslandIdentityProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "children"> {
  name: string;
  status: string;
  description: JSX.Element;
  descriptionRef?: (element: HTMLSpanElement) => void;
  trailing?: JSX.Element;
}

export function DynamicIslandIdentity(props: DynamicIslandIdentityProps): JSX.Element {
  const others = omit(props, "class", "name", "status", "description", "descriptionRef", "trailing");
  return (
    <Item size="compact" class={cx("ui-dynamic-island-identity", props.class)} {...others}>
      <ItemMedia class="ui-dynamic-island-identity-avatar" aria-hidden="true" />
      <ItemContent class="ui-dynamic-island-identity-copy" data-island-motion-content>
        <ItemTitle class="ui-dynamic-island-identity-title">
          <span class="ui-dynamic-island-identity-name">{props.name}</span>
          <span class="ui-dynamic-island-identity-status">{props.status}</span>
        </ItemTitle>
        <ItemDescription
          ref={(element) => props.descriptionRef?.(element)}
          class="ui-dynamic-island-identity-description"
        >
          {props.description}
        </ItemDescription>
      </ItemContent>
      <Show when={props.trailing}>
        <ItemActions class="ui-dynamic-island-identity-trailing" data-island-motion-content>
          {props.trailing}
        </ItemActions>
      </Show>
    </Item>
  );
}
