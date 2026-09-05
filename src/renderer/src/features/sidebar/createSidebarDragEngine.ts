/**
 * The imperative half of the sidebar's drag&drop: the pointer pipeline, the slot caches, the
 * auto-scroll and the resolve path that decides what a drop would land on.
 *
 * `dragSession`, `dragTarget` and the slot caches are plain locals because the pipeline reads its
 * own writes inside one tick, and neither a signal nor a store publishes a write before the next
 * flush. The reactive half the rows render from is `drag-state-store`, and this file is handed only
 * its writers: anything deciding where a drag lands takes the source from `dragSession`, and taking
 * it from `drag.source` instead would bring back exactly the one-frame staleness this split exists
 * to avoid. `commitSidebarDrop` is passed that source for the same reason.
 */

import type { TeamPresenceMember } from "@openbot/contracts/ipc";
import { createBoundedDragPreview } from "../../components/createBoundedDragPreview";
import type { createScrollFades } from "../../components/createScrollFades";
import type { AgentProfile } from "../../data";
import { clearSidebarDragDecorations, createSidebarAgentDragCard, measureSidebarDragSlots } from "./sidebar-drag-dom";
import {
  type AgentDragSlot,
  type DragOffset,
  type DragSlot,
  type PersonDragSlot,
  placementForSwap,
  pointInRect,
  reorderOffsets,
  type SectionDragSlot,
  type SidebarDragGeometry,
  type SidebarDragPoint,
  type SidebarDragSession,
  type SidebarDragSource,
  type SidebarDragWorld,
  type SidebarDropTarget,
  type SidebarNativeDragStart,
  sidebarDropTargetAt,
  sidebarDropTargetsEqual,
} from "./sidebar-drag-model";
import type { SidebarPinnedItem } from "./sidebar-pins";
import type { SidebarProps } from "./sidebar-types";
import type { SidebarDragWriters } from "./stores/drag-state-store";

export interface SidebarDragEngineDeps {
  agentPinnedItems: () => SidebarPinnedItem[];
  assignedSectionId: (agentId: string) => string;
  commitSidebarDrop: (source: SidebarDragSource, target: SidebarDropTarget | null) => void;
  /** Read on the resolve path, so it is a predicate over the pin count - never a read of the source. */
  canPinDraggedItem: () => boolean;
  dragState: SidebarDragWriters;
  filteredAgentsBySection: () => Map<string, AgentProfile[]>;
  filteredPeople: () => TeamPresenceMember[];
  getAgentList: () => HTMLElement | undefined;
  props: SidebarProps;
  scrollFades: ReturnType<typeof createScrollFades>;
  sectionAcceptsAgent: (sectionId: string) => boolean;
  visiblePinnedKeys: () => string[];
  visibleSectionIds: () => string[];
}

export function createSidebarDragEngine(deps: SidebarDragEngineDeps) {
  const {
    agentPinnedItems,
    assignedSectionId,
    canPinDraggedItem,
    commitSidebarDrop,
    dragState,
    filteredAgentsBySection,
    filteredPeople,
    scrollFades,
    sectionAcceptsAgent,
    visiblePinnedKeys,
    visibleSectionIds,
  } = deps;

  let pinnedDragSlots: DragSlot[] = [];

  let agentDragSlots = new Map<string, AgentDragSlot>();

  let agentDragStartScrollTop = 0;

  let sectionDragSlots = new Map<string, SectionDragSlot>();

  let sectionDragStartScrollTop = 0;

  let dragSession: SidebarDragSession | null = null;

  let dragGeometry: SidebarDragGeometry = { list: null, pinned: null };

  let dragPoint: SidebarDragPoint | null = null;

  let dragTarget: SidebarDropTarget | null = null;

  let dragTargetFrame: number | null = null;

  let dragScrollFrame: number | null = null;

  let dragScrollSpeed = 0;

  let personDragSlots = new Map<string, PersonDragSlot>();

  let suppressSidebarClickUntil = 0;

  const dragPreview = createBoundedDragPreview();

  function stopSidebarDragging(): void {
    if (dragTargetFrame !== null) cancelAnimationFrame(dragTargetFrame);
    if (dragScrollFrame !== null) cancelAnimationFrame(dragScrollFrame);
    window.removeEventListener("blur", stopSidebarDragging);
    dragSession = null;
    dragPoint = null;
    dragTarget = null;
    dragTargetFrame = null;
    dragScrollFrame = null;
    dragScrollSpeed = 0;
    dragGeometry = { list: null, pinned: null };
    dragState.resetDrag();
    clearSidebarDragDecorations(deps.getAgentList());
    for (const slot of personDragSlots.values()) slot.element.classList.remove("sidebar-person-item-dragging");
    agentDragSlots.clear();
    personDragSlots.clear();
    sectionDragSlots.clear();
    pinnedDragSlots = [];
    dragPreview.stop();
  }

  function sidebarClickIsSuppressed(event: MouseEvent): boolean {
    if (Date.now() >= suppressSidebarClickUntil) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  /**
   * Resets the caches and both drag-start scroll tops before anything can fail, then measures. The
   * early return matters: with no list there are no slots, but `dragGeometry` keeps its previous
   * value, and `resolveSidebarDropTarget` rejects every point once that becomes `{list: null}`.
   */
  function measureSidebarDragTargets(): void {
    sectionDragSlots = new Map();
    agentDragSlots = new Map();
    personDragSlots = new Map();
    pinnedDragSlots = [];
    const list = deps.getAgentList();
    const startScrollTop = list?.scrollTop ?? 0;
    sectionDragStartScrollTop = startScrollTop;
    agentDragStartScrollTop = startScrollTop;
    if (!list) return;
    const measurement = measureSidebarDragSlots(list, assignedSectionId);
    sectionDragSlots = measurement.sections;
    agentDragSlots = measurement.agents;
    personDragSlots = measurement.people;
    pinnedDragSlots = measurement.pinned;
    dragGeometry = measurement.geometry;
  }

  function startNativeItemDragging(
    event: DragEvent & { currentTarget: HTMLElement },
    options: SidebarNativeDragStart,
  ): void {
    if (deps.props.compact) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/plain", options.data);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    dragSession = { source: options.source, startScrollTop: deps.getAgentList()?.scrollTop ?? 0 };
    dragPoint = { clientX: event.clientX, clientY: event.clientY };
    dragTarget = null;
    dragState.beginDrag(options.source);
    measureSidebarDragTargets();
    const list = deps.getAgentList();
    if (!list) return;
    dragPreview.start({
      bounds: list,
      className: options.className,
      createPreview: options.createPreview,
      event,
      horizontal: options.horizontal,
      previewSize: options.previewSize,
      source: event.currentTarget,
    });
    window.addEventListener("blur", stopSidebarDragging, { once: true });
  }

  function startAgentDragging(event: DragEvent & { currentTarget: HTMLElement }, agent: AgentProfile): void {
    if (deps.props.compact) return;
    startNativeItemDragging(event, {
      className: "sidebar-agent-drag-preview",
      createPreview: createSidebarAgentDragCard,
      data: `openbot-agent:${agent.id}`,
      previewSize: { height: 94, width: 72 },
      source: { kind: "agent", id: agent.id, origin: "section" },
    });
  }

  function startPersonDragging(event: DragEvent & { currentTarget: HTMLElement }, member: TeamPresenceMember): void {
    startNativeItemDragging(event, {
      className: "sidebar-person-drag-preview",
      createPreview: createSidebarAgentDragCard,
      data: `openbot-person:${member.id}`,
      previewSize: { height: 94, width: 72 },
      source: { kind: "person", id: member.id, origin: "people" },
    });
    personDragSlots.get(member.id)?.element.classList.add("sidebar-person-item-dragging");
  }

  function startSectionDragging(event: DragEvent & { currentTarget: HTMLElement }, sectionId: string): void {
    startNativeItemDragging(event, {
      className: "sidebar-section-drag-preview",
      data: `openbot-section:${sectionId}`,
      horizontal: false,
      source: { kind: "section", id: sectionId },
    });
  }

  /**
   * The imperative half of the drag, snapshotted for the pure resolver. The three scroll deltas stay
   * separate because `dragSession.startScrollTop` is set on its own: they hold the same number
   * today, and one shared field would hide the day they stop.
   */
  function sidebarDragWorld(session: SidebarDragSession): SidebarDragWorld {
    const scrollTop = deps.getAgentList()?.scrollTop ?? 0;
    return {
      agentScrollDelta: scrollTop - agentDragStartScrollTop,
      agentSlots: agentDragSlots,
      canPinDraggedItem,
      geometry: dragGeometry,
      personSlots: personDragSlots,
      pinnedSlots: pinnedDragSlots,
      sectionAcceptsAgent,
      sectionScrollDelta: scrollTop - sectionDragStartScrollTop,
      sectionSlots: sectionDragSlots,
      session,
      sessionScrollDelta: scrollTop - session.startScrollTop,
    };
  }

  function resolveSidebarDropTarget(point: SidebarDragPoint): SidebarDropTarget | null {
    const session = dragSession;
    return session ? sidebarDropTargetAt(sidebarDragWorld(session), point) : null;
  }

  /**
   * Which rows shift, and by how much, for the target now in flight. The source comes from
   * `dragSession` rather than from `drag.source`: this runs in the same tick as the target write
   * that drives it, and a store publishes a write only at the next flush.
   *
   * One computation for all four regions - see `reorderOffsets`. The guards below are the only part
   * that stays per-region, because each one names a different pairing of source and target that can
   * be hovered but not reordered: a tile being pinned from the list, an agent aimed at another
   * section, a person aimed at an agent.
   */
  function sidebarDragOffsets(target: SidebarDropTarget | null): Record<string, DragOffset> {
    const source = dragSession?.source;
    if (!source || !target) return {};
    switch (target.kind) {
      case "pinned": {
        if (source.kind !== "agent" || source.origin !== "pinned" || !target.key) return {};
        const keys = visiblePinnedKeys();
        return reorderOffsets(
          keys,
          source.key,
          { id: target.key, placement: placementForSwap(keys, source.key, target.key) },
          (key) => pinnedDragSlots[keys.indexOf(key)],
          "x-and-y",
        );
      }
      case "agent": {
        if (source.kind !== "agent" || source.origin !== "section") return {};
        const sourceSlot = agentDragSlots.get(source.id);
        const targetSlot = agentDragSlots.get(target.target.agentId);
        // An agent only pushes its own neighbours: aimed at another section it is a move, not a reorder.
        if (!sourceSlot || !targetSlot || sourceSlot.sectionId !== targetSlot.sectionId) return {};
        const agentIds = (filteredAgentsBySection().get(sourceSlot.sectionId) ?? []).map((agent) => agent.id);
        return reorderOffsets(
          agentIds,
          source.id,
          {
            id: target.target.agentId,
            placement: placementForSwap(agentIds, source.id, target.target.agentId),
          },
          (agentId) => agentDragSlots.get(agentId),
          "y",
        );
      }
      case "person": {
        if (source.kind !== "person") return {};
        return reorderOffsets(
          filteredPeople().map((member) => member.id),
          source.id,
          { id: target.target.memberId, placement: target.target.placement },
          (memberId) => personDragSlots.get(memberId),
          "y",
        );
      }
      case "section-order": {
        if (source.kind !== "section") return {};
        return reorderOffsets(
          visibleSectionIds(),
          source.id,
          { id: target.target.sectionId, placement: target.target.placement },
          (sectionId) => sectionDragSlots.get(sectionId),
          "y",
        );
      }
      default:
        return {};
    }
  }

  function applySidebarDropTarget(target: SidebarDropTarget | null): void {
    if (sidebarDropTargetsEqual(dragTarget, target)) return;
    dragTarget = target;
    dragState.setDragTarget(target);
    dragState.setDragOffsets(sidebarDragOffsets(target));
  }

  function runSidebarDragTargetFrame(): void {
    dragTargetFrame = null;
    if (!dragPoint || !dragSession) return;
    applySidebarDropTarget(resolveSidebarDropTarget(dragPoint));
    updateSidebarDragAutoScroll(dragPoint.clientY);
  }

  function scheduleSidebarDragTarget(point: SidebarDragPoint): void {
    dragPoint = point;
    if (dragTargetFrame === null) dragTargetFrame = requestAnimationFrame(runSidebarDragTargetFrame);
  }

  function flushSidebarDragTarget(point: SidebarDragPoint): SidebarDropTarget | null {
    if (dragTargetFrame !== null) cancelAnimationFrame(dragTargetFrame);
    dragTargetFrame = null;
    dragPoint = point;
    const target = resolveSidebarDropTarget(point);
    applySidebarDropTarget(target);
    return target;
  }

  function runSidebarDragAutoScroll(): void {
    dragScrollFrame = null;
    const list = deps.getAgentList();
    if (!list || !dragSession || !dragPoint || dragScrollSpeed === 0) return;
    const previousScrollTop = list.scrollTop;
    list.scrollTop += dragScrollSpeed;
    if (list.scrollTop === previousScrollTop) {
      dragScrollSpeed = 0;
      return;
    }
    applySidebarDropTarget(resolveSidebarDropTarget(dragPoint));
    scrollFades.measure();
    dragScrollFrame = requestAnimationFrame(runSidebarDragAutoScroll);
  }

  function updateSidebarDragAutoScroll(clientY: number): void {
    const bounds = dragGeometry.list;
    if (!bounds) return;
    const edgeSize = Math.min(40, bounds.height / 4);
    if (clientY < bounds.top + edgeSize) {
      dragScrollSpeed = -Math.min(12, Math.ceil(((bounds.top + edgeSize - clientY) / edgeSize) * 12));
    } else if (clientY > bounds.bottom - edgeSize) {
      dragScrollSpeed = Math.min(12, Math.ceil(((clientY - (bounds.bottom - edgeSize)) / edgeSize) * 12));
    } else dragScrollSpeed = 0;
    if (dragScrollSpeed !== 0 && dragScrollFrame === null) {
      dragScrollFrame = requestAnimationFrame(runSidebarDragAutoScroll);
    } else if (dragScrollSpeed === 0 && dragScrollFrame !== null) {
      cancelAnimationFrame(dragScrollFrame);
      dragScrollFrame = null;
    }
  }

  function updateSidebarNativeDrag(event: DragEvent): void {
    if (!dragSession) return;
    if (
      !dragState.emptyPinnedDropVisible() &&
      agentPinnedItems().length === 0 &&
      dragSession.source.kind === "agent" &&
      dragSession.source.origin === "section"
    ) {
      const activeSession = dragSession;
      dragState.setEmptyPinnedDropVisible(true);
      queueMicrotask(() => {
        if (dragSession !== activeSession) return;
        measureSidebarDragTargets();
        if (dragPoint) scheduleSidebarDragTarget(dragPoint);
      });
    }
    const point = { clientX: event.clientX, clientY: event.clientY };
    if (pointInRect(point, dragGeometry.list)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
    dragPreview.move(event.clientX, event.clientY);
    scheduleSidebarDragTarget(point);
  }

  function dropSidebarNativeDrag(event: DragEvent): void {
    if (!dragSession) return;
    event.preventDefault();
    event.stopPropagation();
    const animatedPinnedTarget =
      dragState.emptyPinnedDropVisible() && dragTarget?.kind === "pinned" ? dragTarget : null;
    if (dragState.emptyPinnedDropVisible() && !animatedPinnedTarget) measureSidebarDragTargets();
    const target = animatedPinnedTarget ?? flushSidebarDragTarget({ clientX: event.clientX, clientY: event.clientY });
    commitSidebarDrop(dragSession.source, target);
    suppressSidebarClickUntil = Date.now() + 250;
    stopSidebarDragging();
  }

  function endAgentDragging(event: DragEvent): void {
    const session = dragSession;
    const canCommitAnimatedPin =
      dragState.emptyPinnedDropVisible() &&
      session?.source.kind === "agent" &&
      session.source.origin === "section" &&
      dragTarget?.kind === "pinned" &&
      (event.clientX !== 0 || event.clientY !== 0) &&
      pointInRect({ clientX: event.clientX, clientY: event.clientY }, dragGeometry.list);
    if (session && canCommitAnimatedPin) {
      commitSidebarDrop(session.source, dragTarget);
      suppressSidebarClickUntil = Date.now() + 250;
    }
    stopSidebarDragging();
  }

  /** The pointer left the list. Still inside it means a child boundary, not a leave. */
  function handleListDragLeave(event: DragEvent): void {
    const point = { clientX: event.clientX, clientY: event.clientY };
    if (pointInRect(point, dragGeometry.list)) return;
    scheduleSidebarDragTarget(point);
  }

  /**
   * The pinned group finished growing or shrinking, so every slot below it has moved. Re-measures
   * and re-resolves at the last known point. Together with `handleListDragLeave` this is the whole
   * reason the markup never has to reach into the imperative half of the drag.
   */
  function handlePinnedTransitionEnd(event: TransitionEvent & { currentTarget: HTMLElement }): void {
    if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
    if (!dragSession) return;
    measureSidebarDragTargets();
    if (dragPoint) scheduleSidebarDragTarget(dragPoint);
  }

  return {
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
  };
}
