/**
 * The pinned strip above the sections. It stays mounted while `drag.emptyPinnedDropVisible` is on
 * even with nothing pinned, because that empty row is the drop target that lets a first agent be
 * pinned at all.
 */

import { For, Show } from "solid-js";
import { sidebarPinnedItemKey } from "../../sidebar-pins";
import { Badge, buttonVariants, ContextMenu } from "../ui";
import { SidebarAgentContextMenu } from "./SidebarAgentContextMenu";
import { SidebarPinnedAvatar } from "./SidebarAgentIndicator";
import { sidebarAgentStateLabel } from "./sidebar-filtering";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarPinnedGroup() {
  const {
    drag,
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
    <Show when={resolvedPinnedItems().length > 0 || drag.emptyPinnedDropVisible}>
      <section
        class={[
          "sidebar-chat-group sidebar-pinned-group",
          {
            "sidebar-pinned-group-agent-drop-target": pinnedDropActive(),
            "sidebar-pinned-group-empty-target": drag.emptyPinnedDropVisible,
          },
        ]}
        aria-label="Pinned chats"
        onTransitionEnd={handlePinnedTransitionEnd}
      >
        <ul class="sidebar-pinned-list" data-dragging={draggedPinnedKey() ? "" : undefined}>
          <Show when={drag.emptyPinnedDropVisible}>
            <li class="sidebar-pinned-empty-drop">Drag here to pin</li>
          </Show>
          <For each={resolvedPinnedItems()}>
            {(item) => {
              const key = () => sidebarPinnedItemKey(item.ref);
              const name = () => item.bot.name;
              const title = () => item.bot.title.trim();
              return (
                <li
                  class={[
                    "sidebar-pinned-item",
                    {
                      "sidebar-pinned-item-dragging": draggedPinnedKey() === key(),
                      "sidebar-pinned-item-drag-over": dragOverPinnedKey() === key(),
                    },
                  ]}
                  style={`--sidebar-pinned-drag-x: ${dragOffset(key()).x}px; --sidebar-pinned-drag-y: ${dragOffset(key()).y}px;`}
                  data-pinned-key={key()}
                  draggable="true"
                  onDragStart={(event) => {
                    startNativeItemDragging(event, {
                      className: "sidebar-pinned-drag-preview",
                      data: key(),
                      source: { kind: "agent", id: item.bot.id, key: key(), origin: "pinned" },
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
                        "bot-row sidebar-pinned-row",
                        "agent-row",
                        { "bot-row-active": props.activeBotId === item.bot.id },
                      ]}
                      aria-label={`${item.bot.name}, pinned agent`}
                      aria-pressed={props.activeBotId === item.bot.id ? "true" : "false"}
                      onClick={() => props.onSelectBot(item.bot.id)}
                    >
                      <SidebarPinnedAvatar item={item} agentState={() => props.agentStates[item.bot.id]} />
                      <span class="bot-row-copy sidebar-pinned-copy">
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
                      <Show when={props.agentStates[item.bot.id]}>
                        {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
                      </Show>
                    </ContextMenu.Trigger>
                    <SidebarAgentContextMenu bot={item.bot} pinned={true} />
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
