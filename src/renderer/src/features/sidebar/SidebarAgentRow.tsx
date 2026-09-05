/** One agent in a section: the drag wrapper, the row itself, and its context menu. */

import { Show } from "solid-js";
import { Badge, buttonVariants, ContextMenu } from "../../components/ui";
import type { AgentProfile } from "../../data";
import { AgentAvatar } from "../agents/AgentAvatar";
import { SidebarAgentContextMenu } from "./SidebarAgentContextMenu";
import { SidebarAgentIndicator } from "./SidebarAgentIndicator";
import { sidebarAgentStateLabel } from "./sidebar-filtering";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarAgentRow(rowProps: { agent: AgentProfile }) {
  const {
    dragOffset,
    draggedAgentId,
    endAgentDragging,
    layoutMutable,
    props,
    sidebarClickIsSuppressed,
    startAgentDragging,
  } = useSidebarScope();
  const title = () => rowProps.agent.title.trim();
  const working = () => props.agentStates[rowProps.agent.id]?.kind === "working";
  return (
    /* biome-ignore lint/a11y/noStaticElementInteractions: Native drag belongs to the wrapper around the accessible button. */
    <div
      class={[
        "sidebar-agent-item",
        {
          "sidebar-agent-item-dragging": draggedAgentId() === rowProps.agent.id,
          "sidebar-drag-shifting": dragOffset(rowProps.agent.id).y !== 0,
        },
      ]}
      style={`--sidebar-drag-y: ${dragOffset(rowProps.agent.id).y}px;`}
      data-agent-id={rowProps.agent.id}
      draggable={!layoutMutable() || props.compact ? "false" : "true"}
      onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) => startAgentDragging(event, rowProps.agent)}
      onDragEnd={endAgentDragging}
    >
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger
          as="button"
          type="button"
          class={[
            buttonVariants({ variant: "ghost" }),
            "agent-row",
            {
              "agent-row-active": props.activeAgentId === rowProps.agent.id,
              "sidebar-agent-row-dragging": draggedAgentId() === rowProps.agent.id,
            },
          ]}
          aria-label={`${rowProps.agent.name}${title() ? `, ${title()}` : ""}. ${rowProps.agent.preview}`}
          aria-pressed={props.activeAgentId === rowProps.agent.id ? "true" : "false"}
          onClick={(event: MouseEvent) => {
            if (!sidebarClickIsSuppressed(event)) props.onSelectAgent(rowProps.agent.id);
          }}
        >
          <span class="agent-row-avatar">
            <AgentAvatar agent={rowProps.agent} motion={working() ? "working" : "hover"} />
            <Show when={props.agentStates[rowProps.agent.id]}>
              {(state) => <SidebarAgentIndicator state={state()} />}
            </Show>
          </span>
          <span class="agent-row-copy">
            <span class="agent-row-heading">
              <span class="agent-row-title">
                <strong>{rowProps.agent.name}</strong>
                <Show when={title()}>
                  {(label) => (
                    <Badge class="agent-role-badge" size="sm" title={label()}>
                      <span>{label()}</span>
                    </Badge>
                  )}
                </Show>
              </span>
              <span class="agent-row-time">{rowProps.agent.time}</span>
            </span>
            <span class="agent-row-preview">{rowProps.agent.preview}</span>
          </span>
          <Show when={props.agentStates[rowProps.agent.id]}>
            {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
          </Show>
        </ContextMenu.Trigger>
        <SidebarAgentContextMenu agent={rowProps.agent} pinned={false} />
      </ContextMenu.Root>
    </div>
  );
}
