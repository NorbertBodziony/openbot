/** The server name, the marketplace or expand toggle, and new agent - plus the window drag region. */

import { Show } from "solid-js";
import { Button, Puzzle } from "../ui";
import { PlusIcon, SidebarToggleIcon } from "./SidebarIcons";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarTopbar() {
  const { props } = useSidebarScope();
  return (
    <div class="window-drag sidebar-topbar">
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="sidebar-server-name no-drag"
        aria-label={`Open settings for ${props.serverName}`}
        aria-hidden={props.compact ? "true" : undefined}
        tabindex={props.compact ? -1 : 0}
        title={props.serverName}
        onClick={(event) => props.onOpenServerSettings(event.currentTarget)}
      >
        <span class="sidebar-server-name-label">{props.serverName}</span>
      </Button>
      <div class="sidebar-topbar-actions">
        <Button
          variant="ghost"
          type="button"
          class={[
            "sidebar-icon-button no-drag",
            props.compact ? "sidebar-toggle-button" : "sidebar-marketplace-button",
          ]}
          onClick={() => (props.compact ? props.onExpand() : props.onOpenMarketplace())}
          aria-label={props.compact ? "Expand sidebar" : "Open Marketplace"}
          aria-controls={props.compact ? "agent-sidebar" : undefined}
          aria-expanded={props.compact ? "false" : undefined}
          title={props.compact ? "Expand sidebar" : "Marketplace"}
        >
          <Show when={props.compact} fallback={<Puzzle aria-hidden="true" />}>
            <SidebarToggleIcon />
          </Show>
        </Button>
        <Button
          variant="ghost"
          type="button"
          class="sidebar-icon-button sidebar-new-button no-drag"
          onClick={props.onCreateAgent}
          aria-label="Create new agent"
          aria-hidden={props.compact ? "true" : undefined}
          tabindex={props.compact ? -1 : 0}
        >
          <PlusIcon />
        </Button>
      </div>
    </div>
  );
}
