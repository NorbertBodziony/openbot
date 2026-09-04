/**
 * The imperative half of the sidebar's drag&drop: the pointer pipeline, the slot caches, the
 * auto-scroll and the commit path, plus the reactive projection the list renders from.
 *
 * Both halves live here on purpose. `dragSession`, `dragTarget` and the slot caches are plain
 * locals because the pipeline reads its own writes inside one tick, and neither a signal nor a
 * store publishes a write before the next flush; the `drag` store is what the rows render from.
 * Anything that decides where a drag lands, or which rows shift, reads the locals - taking the
 * source from `drag.source` instead brings back exactly the one-frame staleness this split exists
 * to avoid.
 */

import type { TeamPresenceMember } from "@openbot/contracts/ipc";
import { SIDEBAR_UNASSIGNED_SECTION_ID, type SidebarLayoutAction } from "@openbot/contracts/ipc";
import { createMemo, createStore } from "solid-js";
import type { BotProfile } from "../../data";
import { MAX_SIDEBAR_PINNED_ITEMS, type SidebarPinnedItem, sidebarPinnedItemKey } from "../../sidebar-pins";
import { createBoundedDragPreview } from "../createBoundedDragPreview";
import type { createScrollFades } from "../createScrollFades";
import type { SidebarProps } from "../Sidebar";
import { teamMemberName } from "../TeamPersonAvatar";
import { clearSidebarDragDecorations, createSidebarAgentDragCard, measureSidebarDragSlots } from "./sidebar-drag-dom";
import {
  type AgentDragSlot,
  type AgentDropTarget,
  type DragOffset,
  type DragSlot,
  type PersonDragSlot,
  type PersonDropTarget,
  placementForSwap,
  pointInRect,
  reorderOffsets,
  type SectionDragSlot,
  type SectionDropTarget,
  type SidebarDrag,
  type SidebarDragGeometry,
  type SidebarDragPoint,
  type SidebarDragSession,
  type SidebarDragSource,
  type SidebarDragWorld,
  type SidebarDropTarget,
  type SidebarNativeDragStart,
  sidebarDropTargetAt,
  sidebarDropTargetsEqual,
  ZERO_DRAG_OFFSET,
} from "./sidebar-drag-model";

export interface SidebarDragEngineDeps {
  agentPinnedItems: () => SidebarPinnedItem[];
  assignedSectionId: (agentId: string) => string;
  botById: () => Map<string, BotProfile>;
  filteredBotsBySection: () => Map<string, BotProfile[]>;
  filteredPeople: () => TeamPresenceMember[];
  getBotList: () => HTMLElement | undefined;
  layoutMutable: () => boolean;
  orderedPeople: () => TeamPresenceMember[];
  personById: () => Map<string, TeamPresenceMember>;
  props: SidebarProps;
  scrollFades: ReturnType<typeof createScrollFades>;
  sectionAcceptsAgent: (sectionId: string) => boolean;
  sectionLabel: (sectionId: string) => string;
  setReorderAnnouncement: (message: string) => void;
  visiblePinnedKeys: () => string[];
  visibleSectionIds: () => string[];
}

export function createSidebarDragEngine(deps: SidebarDragEngineDeps) {
  const {
    agentPinnedItems,
    assignedSectionId,
    botById,
    filteredBotsBySection,
    filteredPeople,
    layoutMutable,
    orderedPeople,
    personById,
    scrollFades,
    sectionAcceptsAgent,
    sectionLabel,
    setReorderAnnouncement,
    visiblePinnedKeys,
    visibleSectionIds,
  } = deps;

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

  /** The pinned group highlights only while an agent from the list could actually land in it. */
  const pinnedDropActive = createMemo(() => {
    const source = drag.source;
    const pinningFromSidebar = Boolean(source && "origin" in source && source.origin !== "pinned");
    return drag.target?.kind === "pinned" && pinningFromSidebar && canPinDraggedSidebarItem();
  });

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
    setDrag((state) => {
      state.emptyPinnedDropVisible = false;
      state.offsets = {};
      state.source = null;
      state.target = null;
    });
    clearSidebarDragDecorations(deps.getBotList());
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
    const list = deps.getBotList();
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
    dragSession = { source: options.source, startScrollTop: deps.getBotList()?.scrollTop ?? 0 };
    dragPoint = { clientX: event.clientX, clientY: event.clientY };
    dragTarget = null;
    setDrag((state) => {
      state.offsets = {};
      state.source = options.source;
      state.target = null;
    });
    measureSidebarDragTargets();
    const list = deps.getBotList();
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

  function startAgentDragging(event: DragEvent & { currentTarget: HTMLElement }, bot: BotProfile): void {
    if (deps.props.compact) return;
    startNativeItemDragging(event, {
      className: "sidebar-agent-drag-preview",
      createPreview: createSidebarAgentDragCard,
      data: `openbot-agent:${bot.id}`,
      previewSize: { height: 94, width: 72 },
      source: { kind: "agent", id: bot.id, origin: "section" },
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

  function reorderDraggedPerson(sourceMemberId: string, target: PersonDropTarget): void {
    const memberIds = orderedPeople()
      .map((member) => member.id)
      .filter((memberId) => memberId !== sourceMemberId);
    const targetIndex = memberIds.indexOf(target.memberId);
    if (targetIndex < 0) return;
    memberIds.splice(targetIndex + (target.placement === "after" ? 1 : 0), 0, sourceMemberId);
    deps.props.onReorderPeople(memberIds);
    const position = memberIds.indexOf(sourceMemberId) + 1;
    const member = personById().get(sourceMemberId);
    setReorderAnnouncement(
      `Moved ${member ? teamMemberName(member) : "person"} to position ${position} of ${memberIds.length}.`,
    );
  }

  function movePersonByKeyboard(memberId: string, direction: -1 | 1): void {
    const visibleMemberIds = filteredPeople().map((member) => member.id);
    const index = visibleMemberIds.indexOf(memberId);
    const targetMemberId = visibleMemberIds[index + direction];
    if (index < 0 || !targetMemberId) return;
    reorderDraggedPerson(memberId, {
      memberId: targetMemberId,
      placement: direction < 0 ? "before" : "after",
    });
  }

  function moveDraggedAgent(agentId: string, target: AgentDropTarget): void {
    const sectionBots = filteredBotsBySection().get(target.sectionId) ?? [];
    const idsWithoutSource = sectionBots.map((bot) => bot.id).filter((candidate) => candidate !== agentId);
    const targetIndex = idsWithoutSource.indexOf(target.agentId);
    if (targetIndex < 0) return;
    const beforeAgentId = target.placement === "before" ? target.agentId : (idsWithoutSource[targetIndex + 1] ?? null);
    void deps.props
      .onMutateLayout({
        type: "move-agent",
        agentId,
        sectionId: target.sectionId === SIDEBAR_UNASSIGNED_SECTION_ID ? null : target.sectionId,
        beforeAgentId,
      })
      .then(
        () =>
          setReorderAnnouncement(
            `Moved ${botById().get(agentId)?.name ?? "agent"} in ${sectionLabel(target.sectionId)}.`,
          ),
        (error) => setReorderAnnouncement(error instanceof Error ? error.message : String(error)),
      );
  }

  function reorderDraggedSection(sourceSectionId: string, target: SectionDropTarget): void {
    if (sourceSectionId === target.sectionId) return;
    const sourceIndex = deps.props.layout.order.indexOf(sourceSectionId);
    if (sourceIndex < 0) return;
    const orderWithoutSource = deps.props.layout.order.filter((sectionId) => sectionId !== sourceSectionId);
    const targetIndex = orderWithoutSource.indexOf(target.sectionId);
    if (targetIndex < 0) return;
    const insertionIndex = targetIndex + (target.placement === "after" ? 1 : 0);
    const steps = Math.abs(insertionIndex - sourceIndex);
    if (steps === 0) return;
    const direction = insertionIndex < sourceIndex ? "up" : "down";

    const visibleOrder = visibleSectionIds().filter((sectionId) => sectionId !== sourceSectionId);
    const visibleTargetIndex = visibleOrder.indexOf(target.sectionId);
    const visibleInsertionIndex = visibleTargetIndex + (target.placement === "after" ? 1 : 0);
    void deps.props.onMutateLayout({ type: "move", sectionId: sourceSectionId, direction, steps }).then(
      () =>
        setReorderAnnouncement(
          `Moved ${sectionLabel(sourceSectionId)} to position ${visibleInsertionIndex + 1} of ${visibleOrder.length + 1}.`,
        ),
      (error) => setReorderAnnouncement(error instanceof Error ? error.message : String(error)),
    );
  }

  function draggedSidebarItem(): SidebarPinnedItem | null {
    const agentId = draggedAgentId();
    return agentId ? { kind: "agent", id: agentId } : null;
  }

  function pinDraggedSidebarItem(): boolean {
    const item = draggedSidebarItem();
    if (!item || !canPinDraggedSidebarItem()) return false;
    deps.props.onPin(item);
    const name = botById().get(item.id)?.name ?? "agent";
    setReorderAnnouncement(`Pinned ${name}.`);
    return true;
  }

  /**
   * The imperative half of the drag, snapshotted for the pure resolver. The three scroll deltas stay
   * separate because `dragSession.startScrollTop` is set on its own: they hold the same number
   * today, and one shared field would hide the day they stop.
   */
  function sidebarDragWorld(session: SidebarDragSession): SidebarDragWorld {
    const scrollTop = deps.getBotList()?.scrollTop ?? 0;
    return {
      agentScrollDelta: scrollTop - agentDragStartScrollTop,
      agentSlots: agentDragSlots,
      canPinDraggedItem: canPinDraggedSidebarItem,
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
        const agentIds = (filteredBotsBySection().get(sourceSlot.sectionId) ?? []).map((bot) => bot.id);
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

  function applySidebarDropTarget(target: SidebarDropTarget | null): void {
    if (sidebarDropTargetsEqual(dragTarget, target)) return;
    dragTarget = target;
    setDrag((state) => {
      state.target = target;
    });
    setDragOffsets(sidebarDragOffsets(target));
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
    const list = deps.getBotList();
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

  function moveAgentAction(agentId: string, target: AgentDropTarget): SidebarLayoutAction | null {
    const sectionBots = filteredBotsBySection().get(target.sectionId) ?? [];
    const idsWithoutSource = sectionBots.map((bot) => bot.id).filter((candidate) => candidate !== agentId);
    const targetIndex = idsWithoutSource.indexOf(target.agentId);
    if (targetIndex < 0) return null;
    return {
      type: "move-agent",
      agentId,
      sectionId: target.sectionId === SIDEBAR_UNASSIGNED_SECTION_ID ? null : target.sectionId,
      beforeAgentId: target.placement === "before" ? target.agentId : (idsWithoutSource[targetIndex + 1] ?? null),
    };
  }

  function appendAgentAction(agentId: string, sectionId: string): SidebarLayoutAction {
    return {
      type: "move-agent",
      agentId,
      sectionId: sectionId === SIDEBAR_UNASSIGNED_SECTION_ID ? null : sectionId,
      beforeAgentId: null,
    };
  }

  async function commitPinnedAgentDrop(
    source: Extract<SidebarDragSource, { kind: "agent" }>,
    target: SidebarDropTarget | null,
  ) {
    if (target && target.kind !== "pinned" && !layoutMutable()) {
      setReorderAnnouncement("This host does not support sidebar layout changes.");
      return;
    }
    let action: SidebarLayoutAction | null = null;
    let sectionId = assignedSectionId(source.id);
    if (target?.kind === "agent") {
      action = moveAgentAction(source.id, target.target);
      sectionId = target.target.sectionId;
    } else if (target?.kind === "section") {
      sectionId = target.sectionId;
      if (assignedSectionId(source.id) !== target.sectionId) action = appendAgentAction(source.id, target.sectionId);
    }
    try {
      if (action) await deps.props.onMutateLayout(action);
      deps.props.onUnpin({ kind: "agent", id: source.id });
      setReorderAnnouncement(`Moved ${botById().get(source.id)?.name ?? "agent"} to ${sectionLabel(sectionId)}.`);
    } catch (error) {
      setReorderAnnouncement(error instanceof Error ? error.message : String(error));
    }
  }

  function commitSidebarDrop(target: SidebarDropTarget | null): void {
    const source = dragSession?.source;
    if (!source) return;

    if ("origin" in source && source.origin === "pinned") {
      if (target?.kind === "pinned") {
        if (target.key) reorderPinnedItem(source.key, target.key);
      } else {
        void commitPinnedAgentDrop(source, target);
      }
      return;
    }

    if (source.kind === "agent") {
      if (target?.kind === "pinned") pinDraggedSidebarItem();
      else if (target?.kind === "agent") moveDraggedAgent(source.id, target.target);
      else if (target?.kind === "section") {
        void deps.props.onMutateLayout(appendAgentAction(source.id, target.sectionId)).then(
          () =>
            setReorderAnnouncement(
              `Moved ${botById().get(source.id)?.name ?? "agent"} to ${sectionLabel(target.sectionId)}.`,
            ),
          (error) => setReorderAnnouncement(error instanceof Error ? error.message : String(error)),
        );
      }
      return;
    }

    if (source.kind === "person") {
      if (target?.kind === "person") reorderDraggedPerson(source.id, target.target);
      return;
    }

    if (target?.kind === "section-order") reorderDraggedSection(source.id, target.target);
  }

  function updateSidebarNativeDrag(event: DragEvent): void {
    if (!dragSession) return;
    if (
      !drag.emptyPinnedDropVisible &&
      agentPinnedItems().length === 0 &&
      dragSession.source.kind === "agent" &&
      dragSession.source.origin === "section"
    ) {
      const activeSession = dragSession;
      setDrag((state) => {
        state.emptyPinnedDropVisible = true;
      });
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
    const animatedPinnedTarget = drag.emptyPinnedDropVisible && dragTarget?.kind === "pinned" ? dragTarget : null;
    if (drag.emptyPinnedDropVisible && !animatedPinnedTarget) measureSidebarDragTargets();
    const target = animatedPinnedTarget ?? flushSidebarDragTarget({ clientX: event.clientX, clientY: event.clientY });
    commitSidebarDrop(target);
    suppressSidebarClickUntil = Date.now() + 250;
    stopSidebarDragging();
  }

  function endAgentDragging(event: DragEvent): void {
    const canCommitAnimatedPin =
      drag.emptyPinnedDropVisible &&
      dragSession?.source.kind === "agent" &&
      dragSession.source.origin === "section" &&
      dragTarget?.kind === "pinned" &&
      (event.clientX !== 0 || event.clientY !== 0) &&
      pointInRect({ clientX: event.clientX, clientY: event.clientY }, dragGeometry.list);
    if (canCommitAnimatedPin) {
      commitSidebarDrop(dragTarget);
      suppressSidebarClickUntil = Date.now() + 250;
    }
    stopSidebarDragging();
  }

  function dragOffset(id: string): DragOffset {
    return drag.offsets[id] ?? ZERO_DRAG_OFFSET;
  }

  function sectionDragClasses(sectionId: string) {
    const target = sectionDropTarget();
    return {
      "sidebar-section-agent-drop-target": agentDropSectionId() === sectionId && sectionAcceptsAgent(sectionId),
      "sidebar-section-dragging": draggedSectionId() === sectionId,
      "sidebar-section-shifting": dragOffset(sectionId).y !== 0,
      "sidebar-section-drop-before":
        draggedSectionId() !== null && target?.sectionId === sectionId && target.placement === "before",
      "sidebar-section-drop-after":
        draggedSectionId() !== null && target?.sectionId === sectionId && target.placement === "after",
    };
  }

  function reorderPinnedItem(sourceKey: string, targetKey: string): void {
    if (sourceKey === targetKey) return;
    const items = [...agentPinnedItems()];
    const sourceIndex = items.findIndex((item) => sidebarPinnedItemKey(item) === sourceKey);
    const targetIndex = items.findIndex((item) => sidebarPinnedItemKey(item) === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = items.splice(sourceIndex, 1);
    items.splice(targetIndex, 0, source);
    deps.props.onReorderPinned(items);
    const position = visiblePinnedKeys().indexOf(targetKey) + 1;
    setReorderAnnouncement(`Moved pinned chat to position ${position} of ${visiblePinnedKeys().length}.`);
  }

  function movePinnedItem(key: string, direction: -1 | 1): void {
    const keys = visiblePinnedKeys();
    const index = keys.indexOf(key);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= keys.length) return;
    reorderPinnedItem(key, keys[targetIndex]);
  }

  function canPinDraggedSidebarItem(): boolean {
    return draggedSidebarItem() !== null && agentPinnedItems().length < MAX_SIDEBAR_PINNED_ITEMS;
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
    drag,
    dragOffset,
    dragOverPinnedKey,
    draggedAgentId,
    draggedPinnedKey,
    draggingKind,
    dropSidebarNativeDrag,
    endAgentDragging,
    handleListDragLeave,
    handlePinnedTransitionEnd,
    movePersonByKeyboard,
    movePinnedItem,
    pinnedDropActive,
    sectionDragClasses,
    sidebarClickIsSuppressed,
    startAgentDragging,
    startNativeItemDragging,
    startPersonDragging,
    startSectionDragging,
    stopSidebarDragging,
    updateSidebarNativeDrag,
  };
}

export type SidebarDragEngine = ReturnType<typeof createSidebarDragEngine>;
