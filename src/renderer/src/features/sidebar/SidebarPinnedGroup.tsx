/**
 * The pinned strip above the sections. It stays mounted while `emptyPinnedDropVisible()` is on
 * even with nothing pinned, because that empty row is the drop target that lets a first agent be
 * pinned at all.
 */

import { For, Show } from "solid-js";
import { Badge, buttonVariants, ContextMenu } from "../../components/ui";
import { SidebarAgentContextMenu } from "./SidebarAgentContextMenu";
import { SidebarPinnedAvatar } from "./SidebarAgentIndicator";
import { sidebarAgentStateLabel } from "./sidebar-filtering";
import { sidebarPinnedItemKey } from "./sidebar-pins";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarPinnedGroup() {
  const {
    emptyPinnedDropVisible,
    dragOffset,
    dragOverPinnedKey,
    draggedPinnedKey,
    handlePinnedTransitionEnd,
    movePinnedItem,
    pinnedDropActive,
    props,
    resolvedPinnedItems,
    startNativeItemDragging,
    stopSidebarDragging,
  } = useSidebarScope();
  return (
    <Show when={resolvedPinnedItems().length > 0 || emptyPinnedDropVisible()}>
      <section
        class={[
          "sidebar-chat-group sidebar-pinned-group",
          {
            "sidebar-pinned-group-agent-drop-target": pinnedDropActive(),
            "sidebar-pinned-group-empty-target": emptyPinnedDropVisible(),
          },
        ]}
        aria-label="Pinned chats"
        onTransitionEnd={handlePinnedTransitionEnd}
      >
        <ul class="sidebar-pinned-list" data-dragging={draggedPinnedKey() ? "" : undefined}>
          <Show when={emptyPinnedDropVisible()}>
            <li class="sidebar-pinned-empty-drop">Drag here to pin</li>
          </Show>
          <For each={resolvedPinnedItems()}>
            {(item) => {
              const key = () => sidebarPinnedItemKey(item.ref);
              const name = () => item.agent.name;
              const title = () => item.agent.title.trim();
              return (
                <li
                  class={[
                    "sidebar-pinned-item",
                    {
                      "sidebar-pinned-item-dragging": draggedPinnedKey() === key(),
                      "sidebar-pinned-item-drag-over": dragOverPinnedKey() === key(),
                    },
                  ]}
                  style={`--sidebar-drag-x: ${dragOffset(key()).x}px; --sidebar-drag-y: ${dragOffset(key()).y}px;`}
                  data-pinned-key={key()}
                  draggable="true"
                  onDragStart={(event) => {
                    startNativeItemDragging(event, {
                      className: "sidebar-pinned-drag-preview",
                      data: key(),
                      source: { kind: "agent", id: item.agent.id, key: key(), origin: "pinned" },
                    });
                  }}
                  onDragEnd={stopSidebarDragging}
                  onKeyDown={(event) => {
                    if (!event.altKey) return;
                    if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      movePinnedItem(key(), -1);
                    } else if (event.key === "ArrowRight") {
                      event.preventDefault();
                      movePinnedItem(key(), 1);
                    }
                  }}
                >
                  <ContextMenu.Root modal={false}>
                    <ContextMenu.Trigger
                      as="button"
                      type="button"
                      class={[
                        buttonVariants({ variant: "ghost" }),
                        "agent-row sidebar-pinned-row",
                        "agent-row",
                        { "agent-row-active": props.activeAgentId === item.agent.id },
                      ]}
                      aria-label={`${item.agent.name}, pinned agent`}
                      aria-pressed={props.activeAgentId === item.agent.id ? "true" : "false"}
                      onClick={() => props.onSelectAgent(item.agent.id)}
                    >
                      <SidebarPinnedAvatar item={item} agentState={() => props.agentStates[item.agent.id]} />
                      <span class="agent-row-copy sidebar-pinned-copy">
                        <strong class="sidebar-pinned-name" title={name()}>
                          {name()}
                        </strong>
                        <Show when={title()}>
                          {(label) => (
                            <Badge class="sidebar-pinned-title" size="sm" title={label()}>
                              <span>{label()}</span>
                            </Badge>
                          )}
                        </Show>
                      </span>
                      <Show when={props.agentStates[item.agent.id]}>
                        {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
                      </Show>
                    </ContextMenu.Trigger>
                    <SidebarAgentContextMenu agent={item.agent} pinned={true} />
                  </ContextMenu.Root>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    </Show>
  );
}
