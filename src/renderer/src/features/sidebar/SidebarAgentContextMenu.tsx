/**
 * The right-click menu on an agent, in the pinned group and in a section alike. `currentSectionId`
 * is the menu's own answer - null when the agent sits in no custom section, which is what draws the
 * tick beside "Unassigned". The scope's `assignedSectionId` answers a different question for the
 * drag measurements, and falls back to the unassigned section instead of null.
 */

import { For, Show } from "solid-js";
import {
  Check,
  ChevronRight,
  ContextMenu,
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  Pin,
  PinOff,
} from "../../components/ui";
import type { AgentProfile } from "../../data";
import { DeleteIcon, EditIcon } from "./SidebarIcons";
import { MAX_SIDEBAR_PINNED_ITEMS, type SidebarPinnedItem } from "./sidebar-pins";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarAgentContextMenu(menuProps: { agent: AgentProfile; pinned: boolean }) {
  const {
    agentPinnedItems,
    assignAgentSection,
    customSectionById,
    layoutMutable,
    openDelete,
    props,
    startCreateSection,
  } = useSidebarScope();
  const ref = (): SidebarPinnedItem => ({ kind: "agent", id: menuProps.agent.id });
  // A derivation, not a value: as a component this body runs once, where the closure it replaced ran
  // inside the parent's render. Reading the pin count eagerly would freeze the limit at mount.
  const pinLimitReached = () => !menuProps.pinned && agentPinnedItems().length >= MAX_SIDEBAR_PINNED_ITEMS;
  const currentSectionId = () =>
    customSectionById().has(props.layout.agentAssignments[menuProps.agent.id] ?? "")
      ? props.layout.agentAssignments[menuProps.agent.id]
      : null;
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content class="agent-context-menu" aria-label="Agent actions">
        <ContextMenu.Item
          disabled={pinLimitReached()}
          title={pinLimitReached() ? `Maximum ${MAX_SIDEBAR_PINNED_ITEMS} pinned chats` : undefined}
          onSelect={() => (menuProps.pinned ? props.onUnpin(ref()) : props.onPin(ref()))}
        >
          <Show when={menuProps.pinned} fallback={<Pin class="agent-context-icon size-4" aria-hidden="true" />}>
            <PinOff class="agent-context-icon size-4" aria-hidden="true" />
          </Show>
          <span>{menuProps.pinned ? "Unpin" : "Pin"}</span>
        </ContextMenu.Item>
        <Show when={layoutMutable()}>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger>
              <FolderInput class="agent-context-icon size-4" aria-hidden="true" />
              <span>Move to</span>
              <ChevronRight class="agent-context-submenu-chevron size-4" aria-hidden="true" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                class="ui-action-menu agent-context-menu agent-context-submenu"
                aria-label="Move to"
              >
                <For each={props.layout.sections}>
                  {(section) => (
                    <ContextMenu.Item onSelect={() => assignAgentSection(menuProps.agent.id, section.id)}>
                      <Show
                        when={currentSectionId() === section.id}
                        fallback={<Folder class="agent-context-icon size-4" aria-hidden="true" />}
                      >
                        <Check class="agent-context-icon size-4" aria-hidden="true" />
                      </Show>
                      <span>{section.name}</span>
                    </ContextMenu.Item>
                  )}
                </For>
                <ContextMenu.Item onSelect={() => assignAgentSection(menuProps.agent.id, null)}>
                  <Show
                    when={currentSectionId() === null}
                    fallback={<Folder class="agent-context-icon size-4" aria-hidden="true" />}
                  >
                    <Check class="agent-context-icon size-4" aria-hidden="true" />
                  </Show>
                  <span>Unassigned</span>
                </ContextMenu.Item>
                <ContextMenu.Separator />
                <ContextMenu.Item onSelect={() => startCreateSection(menuProps.agent.id)}>
                  <FolderPlus class="agent-context-icon size-4" aria-hidden="true" />
                  <span>New section</span>
                </ContextMenu.Item>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
        </Show>
        <ContextMenu.Item onSelect={() => props.onEditAgent(menuProps.agent.id)}>
          <EditIcon />
          <span>Edit agent</span>
        </ContextMenu.Item>
        <Show when={props.duplicateSupported !== false && props.onDuplicateAgent}>
          <ContextMenu.Item
            disabled={props.duplicatingAgentIds?.has(menuProps.agent.id)}
            onSelect={() => void props.onDuplicateAgent?.(menuProps.agent.id).catch(() => undefined)}
          >
            <Copy class="agent-context-icon size-4" aria-hidden="true" />
            <span>{props.duplicatingAgentIds?.has(menuProps.agent.id) ? "Duplicating…" : "Duplicate agent"}</span>
          </ContextMenu.Item>
        </Show>
        <ContextMenu.Separator />
        <ContextMenu.Item
          class="ui-action-menu-danger agent-context-danger"
          onSelect={() => openDelete("agent", menuProps.agent.id)}
        >
          <DeleteIcon />
          <span>Delete agent</span>
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}
