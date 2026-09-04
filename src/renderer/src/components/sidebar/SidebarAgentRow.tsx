/** One agent in a section: the drag wrapper, the row itself, and its context menu. */

import { Show } from "solid-js";
import type { BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { Badge, buttonVariants, ContextMenu } from "../ui";
import { SidebarAgentContextMenu } from "./SidebarAgentContextMenu";
import { SidebarAgentIndicator } from "./SidebarAgentIndicator";
import { sidebarAgentStateLabel } from "./sidebar-filtering";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarAgentRow(rowProps: { bot: BotProfile }) {
  const {
    dragOffset,
    draggedAgentId,
    endAgentDragging,
    layoutMutable,
    props,
    sidebarClickIsSuppressed,
    startAgentDragging,
  } = useSidebarScope();
  const title = () => rowProps.bot.title.trim();
  const working = () => props.agentStates[rowProps.bot.id]?.kind === "working";
  return (
    /* biome-ignore lint/a11y/noStaticElementInteractions: Native drag belongs to the wrapper around the accessible button. */
    <div
      class={[
        "sidebar-agent-item",
        {
          "sidebar-agent-item-dragging": draggedAgentId() === rowProps.bot.id,
          "sidebar-drag-shifting": dragOffset(rowProps.bot.id).y !== 0,
        },
      ]}
      style={`--sidebar-drag-y: ${dragOffset(rowProps.bot.id).y}px;`}
      data-agent-id={rowProps.bot.id}
      draggable={!layoutMutable() || props.compact ? "false" : "true"}
      onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) => startAgentDragging(event, rowProps.bot)}
      onDragEnd={endAgentDragging}
    >
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger
          as="button"
          type="button"
          class={[
            buttonVariants({ variant: "ghost" }),
            "bot-row agent-row",
            {
              "bot-row-active": props.activeBotId === rowProps.bot.id,
              "sidebar-agent-row-dragging": draggedAgentId() === rowProps.bot.id,
            },
          ]}
          aria-label={`${rowProps.bot.name}${title() ? `, ${title()}` : ""}. ${rowProps.bot.preview}`}
          aria-pressed={props.activeBotId === rowProps.bot.id ? "true" : "false"}
          onClick={(event: MouseEvent) => {
            if (!sidebarClickIsSuppressed(event)) props.onSelectBot(rowProps.bot.id);
          }}
        >
          <span class="bot-row-avatar">
            <AgentAvatar bot={rowProps.bot} motion={working() ? "working" : "hover"} />
            <Show when={props.agentStates[rowProps.bot.id]}>
              {(state) => <SidebarAgentIndicator state={state()} />}
            </Show>
          </span>
          <span class="bot-row-copy">
            <span class="bot-row-heading">
              <span class="bot-row-title">
                <strong>{rowProps.bot.name}</strong>
                <Show when={title()}>
                  {(label) => (
                    <Badge class="bot-role-badge" size="sm" title={label()}>
                      <span>{label()}</span>
                    </Badge>
                  )}
                </Show>
              </span>
              <span class="bot-row-time">{rowProps.bot.time}</span>
            </span>
            <span class="bot-row-preview">{rowProps.bot.preview}</span>
          </span>
          <Show when={props.agentStates[rowProps.bot.id]}>
            {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
          </Show>
        </ContextMenu.Trigger>
        <SidebarAgentContextMenu bot={rowProps.bot} pinned={false} />
      </ContextMenu.Root>
    </div>
  );
}
