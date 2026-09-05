/**
 * A section's header row: the collapse toggle, which doubles as the drag handle, and the section
 * context menu. The menu is inline rather than a component of its own because this is its only
 * caller - both regions that show a section header reach it through here.
 */

import { Show } from "solid-js";
import { ArrowDown, ArrowUp, buttonVariants, ChevronDown, ContextMenu, Pencil, Trash2 } from "../../components/ui";
import { SidebarSectionEditor } from "./SidebarSectionEditor";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarSectionHeader(headerProps: { sectionId: string; name: string }) {
  const {
    customSectionById,
    layoutMutable,
    moveSection,
    openDelete,
    pending,
    props,
    sectionIsCollapsed,
    sectionPosition,
    sidebarClickIsSuppressed,
    startRenameSection,
    startSectionDragging,
    stopSidebarDragging,
    visibleSectionIds,
  } = useSidebarScope();
  const editing = () => {
    const target = pending.sectionEditor?.target;
    return target?.kind === "rename" && target.sectionId === headerProps.sectionId;
  };
  const collapsed = () => sectionIsCollapsed(headerProps.sectionId);
  const custom = () => customSectionById().has(headerProps.sectionId);
  const position = () => sectionPosition(headerProps.sectionId);
  return (
    <Show when={!editing()} fallback={<SidebarSectionEditor />}>
      <header>
        <ContextMenu.Root modal={false}>
          <ContextMenu.Trigger
            as="button"
            type="button"
            class={buttonVariants({
              variant: "ghost",
              class: "sidebar-section-toggle sidebar-section-drag-handle",
            })}
            draggable={!layoutMutable() || props.compact ? "false" : "true"}
            title={!layoutMutable() ? "This host does not support sidebar layout changes." : undefined}
            aria-expanded={collapsed() ? "false" : "true"}
            aria-controls={`sidebar-section-body-${headerProps.sectionId}`}
            onClick={(event: MouseEvent) => {
              if (!sidebarClickIsSuppressed(event)) props.onToggleSection(headerProps.sectionId);
            }}
            onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) =>
              startSectionDragging(event, headerProps.sectionId)
            }
            onDragEnd={stopSidebarDragging}
          >
            <span class="sidebar-section-name" title={headerProps.name}>
              {headerProps.name}
            </span>
            <ChevronDown
              class={`sidebar-section-chevron size-4${collapsed() ? " sidebar-section-chevron-collapsed" : ""}`}
              aria-hidden="true"
            />
          </ContextMenu.Trigger>
          <Show when={layoutMutable()}>
            <ContextMenu.Portal>
              <ContextMenu.Content class="agent-context-menu" aria-label="Section actions">
                <Show when={custom()}>
                  <ContextMenu.Item onSelect={() => startRenameSection(headerProps.sectionId)}>
                    <Pencil class="agent-context-icon size-4" aria-hidden="true" />
                    <span>Rename</span>
                  </ContextMenu.Item>
                </Show>
                <ContextMenu.Item disabled={position() <= 0} onSelect={() => moveSection(headerProps.sectionId, "up")}>
                  <ArrowUp class="agent-context-icon size-4" aria-hidden="true" />
                  <span>Move up</span>
                </ContextMenu.Item>
                <ContextMenu.Item
                  disabled={position() < 0 || position() >= visibleSectionIds().length - 1}
                  onSelect={() => moveSection(headerProps.sectionId, "down")}
                >
                  <ArrowDown class="agent-context-icon size-4" aria-hidden="true" />
                  <span>Move down</span>
                </ContextMenu.Item>
                <Show when={custom()}>
                  <ContextMenu.Separator />
                  <ContextMenu.Item
                    class="ui-action-menu-danger agent-context-danger"
                    onSelect={() => openDelete("section", headerProps.sectionId)}
                  >
                    <Trash2 class="agent-context-icon agent-context-danger-icon size-4" aria-hidden="true" />
                    <span>Delete</span>
                  </ContextMenu.Item>
                </Show>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </Show>
        </ContextMenu.Root>
      </header>
    </Show>
  );
}
