/**
 * The scrolling list itself. This element is the one `measureSidebarDragSlots` queries, so its ref
 * is the rail the whole drag pipeline runs on: `setAgentListElement` hands it to the engine and to
 * the scroll fades in that order.
 */

import { Show } from "solid-js";
import { ContextMenu, FolderPlus } from "../ui";
import { SidebarEmptyState } from "./SidebarEmptyState";
import { SidebarPinnedGroup } from "./SidebarPinnedGroup";
import { SidebarSectionList } from "./SidebarSectionList";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarNav() {
  const {
    draggingKind,
    dropSidebarNativeDrag,
    filteredAgents,
    filteredPeople,
    handleListDragLeave,
    layoutMutable,
    pending,
    props,
    reorderAnnouncement,
    resolvedPinnedItems,
    scrollFades,
    setAgentListElement,
    startCreateSection,
    updateSidebarNativeDrag,
  } = useSidebarScope();
  return (
    <nav
      ref={setAgentListElement}
      aria-label="Chat list"
      class={["agent-list", scrollFades.classes()]}
      data-sidebar-dragging={draggingKind()}
      onDragOver={updateSidebarNativeDrag}
      onDragLeave={handleListDragLeave}
      onDrop={dropSidebarNativeDrag}
      onScroll={scrollFades.measure}
    >
      <div class="agent-list-content">
        <Show
          when={
            resolvedPinnedItems().length > 0 ||
            filteredAgents().length > 0 ||
            (props.showPeople !== false && filteredPeople().length > 0) ||
            pending.sectionEditor?.target.kind === "create"
          }
          fallback={<SidebarEmptyState />}
        >
          <SidebarPinnedGroup />
          <SidebarSectionList />
        </Show>
        <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {reorderAnnouncement()}
        </span>
      </div>
      <Show when={layoutMutable()}>
        <ContextMenu.Root modal={false}>
          <ContextMenu.Trigger class="sidebar-list-context-trigger" aria-label="Sidebar free area" />
          <ContextMenu.Portal>
            <ContextMenu.Content class="agent-context-menu" aria-label="Sidebar actions">
              <ContextMenu.Item onSelect={() => startCreateSection()}>
                <FolderPlus class="agent-context-icon size-4" aria-hidden="true" />
                <span>New section</span>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      </Show>
    </nav>
  );
}
