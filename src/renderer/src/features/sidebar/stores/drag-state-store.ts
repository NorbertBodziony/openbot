/**
 * The reactive half of the sidebar's drag&drop: what the rows render from while a drag is in
 * flight. The imperative half - the session, the resolved target and the slot caches - stays in
 * `createSidebarDragEngine`, which is handed only the writers below.
 *
 * That asymmetry is the point. The engine reads its own writes inside one tick, and a store
 * publishes a write only at the next flush, so anything deciding where a drag lands has to take the
 * source from `dragSession`. Not giving the engine a way to read `drag.source` is what makes the
 * one-frame-stale read impossible rather than merely discouraged.
 */

import { createMemo, createStore } from "solid-js";
import {
  type DragOffset,
  type SidebarDrag,
  type SidebarDragSource,
  type SidebarDropTarget,
  ZERO_DRAG_OFFSET,
} from "../sidebar-drag-model";
import { MAX_SIDEBAR_PINNED_ITEMS, type SidebarPinnedItem } from "../sidebar-pins";

/** Everything `createSidebarDragEngine` may do to the drag store, and deliberately nothing more. */
export interface SidebarDragWriters {
  beginDrag: (source: SidebarDragSource) => void;
  emptyPinnedDropVisible: () => boolean;
  resetDrag: () => void;
  setDragOffsets: (next: Record<string, DragOffset>) => void;
  setDragTarget: (target: SidebarDropTarget | null) => void;
  setEmptyPinnedDropVisible: (visible: boolean) => void;
}

export function createSidebarDragStateStore(deps: {
  agentPinnedItems: () => SidebarPinnedItem[];
  sectionAcceptsAgent: (sectionId: string) => boolean;
}) {
  const { agentPinnedItems, sectionAcceptsAgent } = deps;

  const [drag, setDrag] = createStore<SidebarDrag>({
    emptyPinnedDropVisible: false,
    offsets: {},
    source: null,
    target: null,
  });

  // The arms of the two unions above. Each one is a memo so that hovering a pinned tile invalidates
  // the pinned rows only: `drag.target` changes on every hover, these change when their own answer
  // does. Being derived is also why they can no longer disagree about which drag is in flight.
  const draggedPinnedKey = createMemo(() => {
    const source = drag.source;
    return source?.kind === "agent" && source.origin === "pinned" ? source.key : null;
  });

  const draggedAgentId = createMemo(() => {
    const source = drag.source;
    return source?.kind === "agent" && source.origin === "section" ? source.id : null;
  });

  const draggedSectionId = createMemo(() => {
    const source = drag.source;
    return source?.kind === "section" ? source.id : null;
  });

  /** Which kind of drag the list is in, for the styling that dims everything the drag cannot reach. */
  const draggingKind = createMemo(() => {
    const source = drag.source;
    if (!source) return undefined;
    if (source.kind === "agent") return source.origin === "pinned" ? "pinned" : "agent";
    return source.kind;
  });

  const dragOverPinnedKey = createMemo(() => {
    const target = drag.target;
    return target?.kind === "pinned" ? target.key : null;
  });

  /** The section a dragged agent would land in, whether it aims at a row inside it or at the section. */
  const agentDropSectionId = createMemo(() => {
    const target = drag.target;
    if (target?.kind === "agent") return target.target.sectionId;
    if (target?.kind === "section" && drag.source?.kind === "agent") return target.sectionId;
    return null;
  });

  const sectionDropTarget = createMemo(() => {
    const target = drag.target;
    return target?.kind === "section-order" ? target.target : null;
  });

  function draggedSidebarItem(): SidebarPinnedItem | null {
    const agentId = draggedAgentId();
    return agentId ? { kind: "agent", id: agentId } : null;
  }

  /**
   * A plain function, not a memo: `pinnedDropActive` below reads it inside its own tracking scope,
   * which is what makes that memo depend on the pin count, while `sidebarDropTargetAt` and
   * `pinDraggedSidebarItem` call it untracked. A memo would answer both, but only one correctly.
   */
  function canPinDraggedSidebarItem(): boolean {
    return draggedSidebarItem() !== null && agentPinnedItems().length < MAX_SIDEBAR_PINNED_ITEMS;
  }

  /** The pinned group highlights only while an agent from the list could actually land in it. */
  const pinnedDropActive = createMemo(() => {
    const source = drag.source;
    const pinningFromSidebar = Boolean(source && "origin" in source && source.origin !== "pinned");
    return drag.target?.kind === "pinned" && pinningFromSidebar && canPinDraggedSidebarItem();
  });

  function dragOffset(id: string): DragOffset {
    return drag.offsets[id] ?? ZERO_DRAG_OFFSET;
  }

  function sectionDragClasses(sectionId: string) {
    const target = sectionDropTarget();
    return {
      "sidebar-section-agent-drop-target": agentDropSectionId() === sectionId && sectionAcceptsAgent(sectionId),
      "sidebar-section-dragging": draggedSectionId() === sectionId,
      "sidebar-drag-shifting": dragOffset(sectionId).y !== 0,
      "sidebar-section-drop-before":
        draggedSectionId() !== null && target?.sectionId === sectionId && target.placement === "before",
      "sidebar-section-drop-after":
        draggedSectionId() !== null && target?.sectionId === sectionId && target.placement === "after",
    };
  }

  const emptyPinnedDropVisible = () => drag.emptyPinnedDropVisible;

  /** A new drag replaces the previous one wholesale; nothing from it survives into this one. */
  function beginDrag(source: SidebarDragSource): void {
    setDrag((state) => {
      state.offsets = {};
      state.source = source;
      state.target = null;
    });
  }

  function resetDrag(): void {
    setDrag((state) => {
      state.emptyPinnedDropVisible = false;
      state.offsets = {};
      state.source = null;
      state.target = null;
    });
  }

  function setDragTarget(target: SidebarDropTarget | null): void {
    setDrag((state) => {
      state.target = target;
    });
  }

  /**
   * Per key rather than by replacing the record: a row re-renders only when its own offset changes,
   * which is the granularity the four per-item memos used to buy.
   */
  function setDragOffsets(next: Record<string, DragOffset>): void {
    setDrag((state) => {
      for (const id of Object.keys(state.offsets)) {
        if (!next[id]) delete state.offsets[id];
      }
      for (const [id, offset] of Object.entries(next)) {
        const current = state.offsets[id];
        if (current?.x !== offset.x || current.y !== offset.y) state.offsets[id] = offset;
      }
    });
  }

  function setEmptyPinnedDropVisible(visible: boolean): void {
    setDrag((state) => {
      state.emptyPinnedDropVisible = visible;
    });
  }

  return {
    beginDrag,
    canPinDraggedSidebarItem,
    dragOffset,
    dragOverPinnedKey,
    draggedAgentId,
    draggedPinnedKey,
    draggedSidebarItem,
    draggingKind,
    emptyPinnedDropVisible,
    pinnedDropActive,
    resetDrag,
    sectionDragClasses,
    setDragOffsets,
    setDragTarget,
    setEmptyPinnedDropVisible,
  };
}
