import type { JSX } from "@solidjs/web";
import { createUniqueId, omit, Show } from "solid-js";
import { Heading, Text } from "./typography";
import { cx } from "./utils";

export interface SettingsSectionProps extends Omit<JSX.HTMLAttributes<HTMLElement>, "title"> {
  title: JSX.Element;
  description?: JSX.Element;
  actions?: JSX.Element;
}

export function SettingsSection(props: SettingsSectionProps): JSX.Element {
  const headingId = `settings-section-${createUniqueId()}`;
  const others = omit(props, "class", "title", "description", "actions", "children");

  return (
    <section class={cx("ui-settings-section", props.class)} aria-labelledby={headingId} {...others}>
      <div class="ui-settings-section-header">
        <div class="ui-settings-section-copy">
          <Heading id={headingId} class="ui-settings-section-heading" as="h3" size="sm" tone="secondary">
            {props.title}
          </Heading>
          <Show when={props.description}>
            <Text class="ui-settings-section-description" variant="caption" tone="muted">
              {props.description}
            </Text>
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="ui-settings-section-actions">{props.actions}</div>
        </Show>
      </div>
      {props.children}
    </section>
  );
}
