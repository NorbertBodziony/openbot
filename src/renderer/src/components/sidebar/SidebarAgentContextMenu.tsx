/**
 * The right-click menu on an agent, in the pinned group and in a section alike. `currentSectionId`
 * is the menu's own answer - null when the agent sits in no custom section, which is what draws the
 * tick beside "Unassigned". The scope's `assignedSectionId` answers a different question for the
 * drag measurements, and falls back to the unassigned section instead of null.
 */

import { For, Show } from "solid-js";
import type { BotProfile } from "../../data";
import { MAX_SIDEBAR_PINNED_ITEMS, type SidebarPinnedItem } from "../../sidebar-pins";
import { Check, ChevronRight, ContextMenu, Copy, Folder, FolderInput, FolderPlus, Pin, PinOff } from "../ui";
import { DeleteIcon, EditIcon } from "./SidebarIcons";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarAgentContextMenu(menuProps: { bot: BotProfile; pinned: boolean }) {
  const {
    agentPinnedItems,
    assignAgentSection,
    customSectionById,
    layoutMutable,
    openDelete,
    props,
    startCreateSection,
  } = useSidebarScope();
  const ref = (): SidebarPinnedItem => ({ kind: "agent", id: menuProps.bot.id });
  // A derivation, not a value: as a component this body runs once, where the closure it replaced ran
  // inside the parent's render. Reading the pin count eagerly would freeze the limit at mount.
  const pinLimitReached = () => !menuProps.pinned && agentPinnedItems().length >= MAX_SIDEBAR_PINNED_ITEMS;
  const currentSectionId = () =>
    customSectionById().has(props.layout.agentAssignments[menuProps.bot.id] ?? "")
      ? props.layout.agentAssignments[menuProps.bot.id]
      : null;
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content class="bot-context-menu" aria-label="Agent actions">
        <ContextMenu.Item
          disabled={pinLimitReached()}
          title={pinLimitReached() ? `Maximum ${MAX_SIDEBAR_PINNED_ITEMS} pinned chats` : undefined}
          onSelect={() => (menuProps.pinned ? props.onUnpin(ref()) : props.onPin(ref()))}
        >
          <Show when={menuProps.pinned} fallback={<Pin class="bot-context-icon size-4" aria-hidden="true" />}>
            <PinOff class="bot-context-icon size-4" aria-hidden="true" />
          </Show>
          <span>{menuProps.pinned ? "Unpin" : "Pin"}</span>
        </ContextMenu.Item>
        <Show when={layoutMutable()}>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger>
              <FolderInput class="bot-context-icon size-4" aria-hidden="true" />
              <span>Move to</span>
              <ChevronRight class="bot-context-submenu-chevron size-4" aria-hidden="true" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent class="ui-action-menu bot-context-menu bot-context-submenu" aria-label="Move to">
                <For each={props.layout.sections}>
                  {(section) => (
                    <ContextMenu.Item onSelect={() => assignAgentSection(menuProps.bot.id, section.id)}>
                      <Show
                        when={currentSectionId() === section.id}
                        fallback={<Folder class="bot-context-icon size-4" aria-hidden="true" />}
                      >
                        <Check class="bot-context-icon size-4" aria-hidden="true" />
                      </Show>
                      <span>{section.name}</span>
                    </ContextMenu.Item>
                  )}
                </For>
                <ContextMenu.Item onSelect={() => assignAgentSection(menuProps.bot.id, null)}>
                  <Show
                    when={currentSectionId() === null}
                    fallback={<Folder class="bot-context-icon size-4" aria-hidden="true" />}
                  >
                    <Check class="bot-context-icon size-4" aria-hidden="true" />
                  </Show>
                  <span>Unassigned</span>
                </ContextMenu.Item>
                <ContextMenu.Separator />
                <ContextMenu.Item onSelect={() => startCreateSection(menuProps.bot.id)}>
                  <FolderPlus class="bot-context-icon size-4" aria-hidden="true" />
                  <span>New section</span>
                </ContextMenu.Item>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
        </Show>
        <ContextMenu.Item onSelect={() => props.onEditBot(menuProps.bot.id)}>
          <EditIcon />
          <span>Edit agent</span>
        </ContextMenu.Item>
        <Show when={props.duplicateSupported !== false && props.onDuplicateBot}>
          <ContextMenu.Item
            disabled={props.duplicatingBotIds?.has(menuProps.bot.id)}
            onSelect={() => void props.onDuplicateBot?.(menuProps.bot.id).catch(() => undefined)}
          >
            <Copy class="bot-context-icon size-4" aria-hidden="true" />
            <span>{props.duplicatingBotIds?.has(menuProps.bot.id) ? "Duplicating…" : "Duplicate agent"}</span>
          </ContextMenu.Item>
        </Show>
        <ContextMenu.Separator />
        <ContextMenu.Item
          class="ui-action-menu-danger bot-context-danger"
          onSelect={() => openDelete("agent", menuProps.bot.id)}
        >
          <DeleteIcon />
          <span>Delete agent</span>
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}
