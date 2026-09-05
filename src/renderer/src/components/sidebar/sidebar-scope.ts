/**
 * Everything `Sidebar` is, minus the markup. The component builds this once and reads it, and the
 * regions read it through the scope context.
 *
 * The body here is composition: each store under `stores/` owns one concern and is built in
 * dependency order, because a store can only be handed what already exists. The drag&drop pipeline
 * is the one part that needs a closure of its own, and `createSidebarDragEngine` is it.
 */

import { createContext, createEffect, onCleanup, useContext } from "solid-js";
import { createScrollFades } from "../createScrollFades";
import type { SidebarProps } from "../Sidebar";
import { createSidebarDragEngine } from "./createSidebarDragEngine";
import { createSidebarAnnouncementStore } from "./stores/announcement-store";
import { createSidebarDataStore } from "./stores/data-store";
import { createSidebarDragStateStore } from "./stores/drag-state-store";
import { createSidebarLayoutActions } from "./stores/layout-actions";
import { createSidebarPendingStore } from "./stores/pending-store";
import { createSidebarSearchStore } from "./stores/search-store";

export function createSidebarScope(props: SidebarProps) {
  const layoutMutable = () => props.layoutMutable !== false;
  const scrollFades = createScrollFades();

  const { announce, announceError, reorderAnnouncement } = createSidebarAnnouncementStore();
  const { expandToSearch, normalizedQuery, query, setQuery, setSearchInputElement } = createSidebarSearchStore({
    props,
  });
  const {
    agentPinnedItems,
    assignedSectionId,
    agentById,
    customSectionById,
    directThreadByMember,
    filteredAgents,
    filteredAgentsBySection,
    filteredPeople,
    orderedPeople,
    personById,
    resolvedPinnedItems,
    sectionAcceptsAgent,
    sectionIsCollapsed,
    sectionLabel,
    sectionPosition,
    visiblePinnedKeys,
    visibleSectionIds,
  } = createSidebarDataStore({ normalizedQuery, props });
  const {
    cancelSectionEditor,
    closeDelete,
    confirmDelete,
    confirmSectionDelete,
    deleteError,
    deleteTarget,
    deleting,
    openDelete,
    pending,
    releaseSectionNameInput,
    saveSectionEditor,
    sectionDeleteTarget,
    setSectionNameInput,
    startCreateSection,
    startRenameSection,
    updateSectionEditorName,
  } = createSidebarPendingStore({ customSectionById, props });
  let agentList: HTMLElement | undefined;

  const dragState = createSidebarDragStateStore({ agentPinnedItems, sectionAcceptsAgent });
  const { assignAgentSection, commitSidebarDrop, movePersonByKeyboard, movePinnedItem, moveSection } =
    createSidebarLayoutActions({
      agentPinnedItems,
      announce,
      announceError,
      assignedSectionId,
      agentById,
      canPinDraggedSidebarItem: dragState.canPinDraggedSidebarItem,
      draggedSidebarItem: dragState.draggedSidebarItem,
      filteredAgentsBySection,
      filteredPeople,
      layoutMutable,
      orderedPeople,
      personById,
      props,
      sectionLabel,
      visiblePinnedKeys,
      visibleSectionIds,
    });
  const {
    dropSidebarNativeDrag,
    endAgentDragging,
    handleListDragLeave,
    handlePinnedTransitionEnd,
    sidebarClickIsSuppressed,
    startAgentDragging,
    startNativeItemDragging,
    startPersonDragging,
    startSectionDragging,
    stopSidebarDragging,
    updateSidebarNativeDrag,
  } = createSidebarDragEngine({
    agentPinnedItems,
    assignedSectionId,
    canPinDraggedItem: dragState.canPinDraggedSidebarItem,
    commitSidebarDrop,
    dragState,
    filteredAgentsBySection,
    filteredPeople,
    getAgentList: () => agentList,
    props,
    scrollFades,
    sectionAcceptsAgent,
    visiblePinnedKeys,
    visibleSectionIds,
  });

  onCleanup(() => {
    stopSidebarDragging();
    scrollFades.stop();
  });

  createEffect(
    () => [resolvedPinnedItems(), filteredAgents(), filteredPeople()],
    () => {
      scrollFades.remeasure();
    },
  );

  /** The two statements the list's `ref` used to run inline, in the same order. */
  const setAgentListElement = (element: HTMLElement) => {
    agentList = element;
    scrollFades.bind(element);
  };

  /**
   * The scope's public surface, and the whole of what a region component may reach for. The drag
   * store's writers are deliberately absent: only the engine may move a drag along.
   */
  return {
    agentPinnedItems,
    assignAgentSection,
    cancelSectionEditor,
    closeDelete,
    confirmDelete,
    confirmSectionDelete,
    customSectionById,
    deleteError,
    deleteTarget,
    deleting,
    directThreadByMember,
    dragOffset: dragState.dragOffset,
    dragOverPinnedKey: dragState.dragOverPinnedKey,
    draggedAgentId: dragState.draggedAgentId,
    draggedPinnedKey: dragState.draggedPinnedKey,
    draggingKind: dragState.draggingKind,
    dropSidebarNativeDrag,
    emptyPinnedDropVisible: dragState.emptyPinnedDropVisible,
    endAgentDragging,
    expandToSearch,
    filteredAgents,
    filteredAgentsBySection,
    filteredPeople,
    handleListDragLeave,
    handlePinnedTransitionEnd,
    layoutMutable,
    movePersonByKeyboard,
    movePinnedItem,
    moveSection,
    normalizedQuery,
    openDelete,
    pending,
    pinnedDropActive: dragState.pinnedDropActive,
    props,
    query,
    releaseSectionNameInput,
    reorderAnnouncement,
    resolvedPinnedItems,
    saveSectionEditor,
    scrollFades,
    sectionDeleteTarget,
    sectionDragClasses: dragState.sectionDragClasses,
    sectionIsCollapsed,
    sectionPosition,
    setAgentListElement,
    setQuery,
    setSearchInputElement,
    setSectionNameInput,
    sidebarClickIsSuppressed,
    startAgentDragging,
    startCreateSection,
    startNativeItemDragging,
    startPersonDragging,
    startRenameSection,
    startSectionDragging,
    stopSidebarDragging,
    updateSectionEditorName,
    updateSidebarNativeDrag,
    visibleSectionIds,
  };
}

export type SidebarScope = ReturnType<typeof createSidebarScope>;

export const SidebarScopeContext = createContext<SidebarScope>();

export function useSidebarScope(): SidebarScope {
  const scope = useContext(SidebarScopeContext);
  if (!scope) throw new Error("Sidebar scope is unavailable outside Sidebar.");
  return scope;
}
