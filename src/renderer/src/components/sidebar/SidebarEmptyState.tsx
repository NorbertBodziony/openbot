/**
 * What the list shows with nothing in it. Two different empty states: a search that matched nothing
 * says so, while a brand new profile offers `props.emptyAction` - the first agent, rendered as a
 * pressed row so the sidebar is never a blank column.
 */

import { Show } from "solid-js";
import { AgentAvatar } from "../AgentAvatar";
import { Button } from "../ui";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarEmptyState() {
  const { props, query } = useSidebarScope();
  return (
    <Show
      when={!query().trim() && props.emptyAction}
      fallback={
        <p class="empty-search">
          {query().trim() ? "No matches" : props.agents.length ? "No matches" : "No agents yet"}
        </p>
      }
    >
      {(action) => (
        <div class="sidebar-first-agent-state">
          <Button
            variant="ghost"
            type="button"
            class="agent-row-active sidebar-first-agent-action"
            aria-label={action().label}
            aria-pressed="true"
            data-avatar-seed={action().avatarSeed}
            data-avatar-hue={action().avatarHue ?? "automatic"}
            onClick={action().onSelect}
          >
            <span class="agent-row-avatar">
              <AgentAvatar seed={action().avatarSeed} hue={action().avatarHue} motion="hover" />
            </span>
            <span class="agent-row-copy">
              <span class="agent-row-heading">
                <span class="agent-row-title">
                  <strong>{action().label}</strong>
                </span>
              </span>
            </span>
          </Button>
          <p class="sidebar-first-agent-empty">No chats yet</p>
        </div>
      )}
    </Show>
  );
}
