/**
 * The drag&drop vocabulary of the sidebar, the geometry helpers that read it, and the drop
 * resolver. Pure on purpose: everything here takes values and rectangles, so where a drag would
 * land can be reasoned about without the component, and a change to a drop target's shape shows
 * up as a type error at every site that builds one.
 */

import { SIDEBAR_PEOPLE_SECTION_ID } from "@openbot/contracts/ipc";

export interface DragSlot {
  bottom: number;
  key: string;
  left: number;
  right: number;
  top: number;
  centerX: number;
  centerY: number;
}

/** How far one row has been pushed from the slot it occupies, in the pixels the CSS transforms by. */
export interface DragOffset {
  x: number;
  y: number;
}

export const ZERO_DRAG_OFFSET: DragOffset = { x: 0, y: 0 };

/** Enough of a measured slot to say how far a row must travel to reach another one. */
export interface ReorderSlot {
  left?: number;
  top: number;
}

export interface SectionDropTarget {
  sectionId: string;
  placement: "before" | "after";
}

export interface AgentDropTarget {
  agentId: string;
  placement: "before" | "after";
  sectionId: string;
}

export interface PersonDropTarget {
  memberId: string;
  placement: "before" | "after";
}

export interface AgentDragSlot {
  agentId: string;
  bottom: number;
  centerY: number;
  element: HTMLElement;
  height: number;
  sectionId: string;
  top: number;
}

export interface SectionDragSlot {
  bottom: number;
  centerY: number;
  sectionId: string;
  top: number;
}

export interface PersonDragSlot {
  bottom: number;
  centerY: number;
  element: HTMLElement;
  memberId: string;
  top: number;
}

export type SidebarDragSource =
  | { kind: "agent"; id: string; origin: "section" }
  | { kind: "agent"; id: string; key: string; origin: "pinned" }
  | { kind: "person"; id: string; origin: "people" }
  | { kind: "section"; id: string };

export type SidebarDropTarget =
  | { kind: "pinned"; key: string | null }
  | { kind: "agent"; target: AgentDropTarget }
  | { kind: "section"; sectionId: string }
  | { kind: "person"; target: PersonDropTarget }
  | { kind: "section-order"; target: SectionDropTarget };

export interface SidebarDragPoint {
  clientX: number;
  clientY: number;
}

export interface SidebarDragSession {
  source: SidebarDragSource;
  startScrollTop: number;
}

export interface SidebarDragGeometry {
  list: DOMRect | null;
  pinned: DOMRect | null;
}

export interface SidebarNativeDragStart {
  className: string;
  createPreview?: (source: HTMLElement) => HTMLElement;
  data: string;
  horizontal?: boolean;
  previewSize?: { height: number; width: number };
  source: SidebarDragSource;
}

/**
 * The reactive projection of the drag in flight: what is being dragged, where it would land, and the
 * two pieces of drop chrome that outlive a single frame. It is one record because a drag is one
 * thing - four parallel `dragged*Id` signals let the sidebar claim an agent and a section are being
 * dragged at once, which is why the list header needed a four-way ternary to pick between them.
 *
 * The imperative half of the drag stays in plain locals (`dragSession`, `dragTarget`, the slot
 * caches) because the pointer pipeline reads its own writes inside one tick, and neither a signal
 * nor a store publishes a write before the next flush.
 */
export interface SidebarDrag {
  /** The empty pinned row, held open so an agent dragged out of a section has somewhere to land. */
  emptyPinnedDropVisible: boolean;
  /** How far each row has shifted to make room for the item being dragged, by row id. */
  offsets: Record<string, DragOffset>;
  /** What is being dragged. Every dragged id below is one arm of this union. */
  source: SidebarDragSource | null;
  /** Where it would land. Every drop highlight below is one arm of this union. */
  target: SidebarDropTarget | null;
}

/**
 * Everything the drop resolver reads, as one snapshot taken at the moment of the pointer event. The
 * resolver is pure against it, so where a drag would land is answered from slot rectangles and a
 * source alone - nothing it can reach mutates under it, and a caller can hand it geometry directly.
 *
 * The three scroll deltas are separate fields rather than one because `agentDragStartScrollTop`,
 * `sectionDragStartScrollTop` and `dragSession.startScrollTop` are assigned in different places and
 * only happen to agree.
 */
export interface SidebarDragWorld {
  agentScrollDelta: number;
  agentSlots: Map<string, AgentDragSlot>;
  /** Read untracked, at resolve time - in the component this is a memo, not a value. */
  canPinDraggedItem: () => boolean;
  geometry: SidebarDragGeometry;
  personSlots: Map<string, PersonDragSlot>;
  pinnedSlots: DragSlot[];
  sectionAcceptsAgent: (sectionId: string) => boolean;
  sectionScrollDelta: number;
  sectionSlots: Map<string, SectionDragSlot>;
  session: SidebarDragSession;
  /** Used by the pinned and people hit tests, both of which key off the session's own start. */
  sessionScrollDelta: number;
}

export function sidebarDropTargetsEqual(left: SidebarDropTarget | null, right: SidebarDropTarget | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "pinned" && right.kind === "pinned") return left.key === right.key;
  if (left.kind === "section" && right.kind === "section") return left.sectionId === right.sectionId;
  if (left.kind === "agent" && right.kind === "agent") {
    return (
      left.target.agentId === right.target.agentId &&
      left.target.placement === right.target.placement &&
      left.target.sectionId === right.target.sectionId
    );
  }
  if (left.kind === "person" && right.kind === "person") {
    return left.target.memberId === right.target.memberId && left.target.placement === right.target.placement;
  }
  if (left.kind === "section-order" && right.kind === "section-order") {
    return left.target.sectionId === right.target.sectionId && left.target.placement === right.target.placement;
  }
  return false;
}

export function pointInRect(point: SidebarDragPoint, rect: DOMRect | null, scrollDelta = 0): boolean {
  if (!rect) return false;
  return (
    point.clientX >= rect.left &&
    point.clientX <= rect.right &&
    point.clientY >= rect.top - scrollDelta &&
    point.clientY <= rect.bottom - scrollDelta
  );
}

export function closestVerticalSlot<T extends { bottom: number; centerY: number; top: number }>(
  slots: Iterable<T>,
  clientY: number,
  scrollDelta: number,
  accepts: (slot: T) => boolean = () => true,
): T | null {
  let closest: T | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  let extentTop = Number.POSITIVE_INFINITY;
  let extentBottom = Number.NEGATIVE_INFINITY;
  for (const slot of slots) {
    if (!accepts(slot)) continue;
    const top = slot.top - scrollDelta;
    const bottom = slot.bottom - scrollDelta;
    extentTop = Math.min(extentTop, top);
    extentBottom = Math.max(extentBottom, bottom);
    const distance = Math.abs(slot.centerY - scrollDelta - clientY);
    if (distance <= closestDistance) {
      closest = slot;
      closestDistance = distance;
    }
  }
  return clientY >= extentTop && clientY <= extentBottom ? closest : null;
}

function targetAgentAt(
  world: SidebarDragWorld,
  sourceAgentId: string,
  agentId: string,
  clientY: number,
): AgentDropTarget | null {
  if (sourceAgentId === agentId) return null;
  const sourceSlot = world.agentSlots.get(sourceAgentId);
  const slot = world.agentSlots.get(agentId);
  if (!slot) return null;
  const scrollDelta = world.agentScrollDelta;
  const placement =
    sourceSlot?.sectionId === slot.sectionId
      ? sourceSlot.top < slot.top
        ? "after"
        : "before"
      : clientY < slot.centerY - scrollDelta
        ? "before"
        : "after";
  const nextTarget: AgentDropTarget = {
    agentId,
    placement,
    sectionId: slot.sectionId,
  };
  return nextTarget;
}

function sectionAtPoint(world: SidebarDragWorld, point: SidebarDragPoint): SectionDragSlot | null {
  return closestVerticalSlot(world.sectionSlots.values(), point.clientY, world.sectionScrollDelta);
}

function agentAtPoint(world: SidebarDragWorld, point: SidebarDragPoint, sectionId: string): AgentDragSlot | null {
  return closestVerticalSlot(
    world.agentSlots.values(),
    point.clientY,
    world.agentScrollDelta,
    (slot) => slot.sectionId === sectionId,
  );
}

function personAtPoint(world: SidebarDragWorld, point: SidebarDragPoint): PersonDragSlot | null {
  return closestVerticalSlot(world.personSlots.values(), point.clientY, world.sessionScrollDelta);
}

function pinnedTargetAtPoint(world: SidebarDragWorld, point: SidebarDragPoint): SidebarDropTarget | null {
  const scrollDelta = world.sessionScrollDelta;
  if (!pointInRect(point, world.geometry.pinned, scrollDelta)) return null;
  const source = world.session.source;
  if (!("origin" in source) || source.origin !== "pinned") {
    return world.canPinDraggedItem() ? { kind: "pinned", key: null } : null;
  }
  if (world.pinnedSlots.length === 0) return { kind: "pinned", key: null };
  const target = world.pinnedSlots.reduce((closest, slot) =>
    Math.hypot(slot.centerX - point.clientX, slot.centerY - scrollDelta - point.clientY) <
    Math.hypot(closest.centerX - point.clientX, closest.centerY - scrollDelta - point.clientY)
      ? slot
      : closest,
  );
  return { kind: "pinned", key: target.key };
}

export function sidebarDropTargetAt(world: SidebarDragWorld, point: SidebarDragPoint): SidebarDropTarget | null {
  const session = world.session;
  if (!pointInRect(point, world.geometry.list)) return null;
  const pinnedTarget = pinnedTargetAtPoint(world, point);
  if (pinnedTarget) return pinnedTarget;
  const section = sectionAtPoint(world, point);
  if (!section) return null;

  if (session.source.kind === "section") {
    if (section.sectionId === session.source.id) return null;
    const scrollDelta = world.sectionScrollDelta;
    return {
      kind: "section-order",
      target: {
        sectionId: section.sectionId,
        placement: point.clientY < section.centerY - scrollDelta ? "before" : "after",
      },
    };
  }

  if (session.source.kind === "person") {
    if (section.sectionId !== SIDEBAR_PEOPLE_SECTION_ID) return null;
    const person = personAtPoint(world, point);
    if (!person || person.memberId === session.source.id) return { kind: "section", sectionId: section.sectionId };
    const sourceSlot = world.personSlots.get(session.source.id);
    return {
      kind: "person",
      target: {
        memberId: person.memberId,
        placement:
          session.source.origin === "people" && sourceSlot
            ? sourceSlot.top < person.top
              ? "after"
              : "before"
            : point.clientY < person.centerY
              ? "before"
              : "after",
      },
    };
  }

  if (!world.sectionAcceptsAgent(section.sectionId)) return null;
  const agent = agentAtPoint(world, point, section.sectionId);
  if (agent && agent.agentId !== session.source.id) {
    const target = targetAgentAt(world, session.source.id, agent.agentId, point.clientY);
    if (target) return { kind: "agent", target };
  }
  return { kind: "section", sectionId: section.sectionId };
}

/**
 * How far every row shifts to open a gap for the one being dragged - the whole animation, for all
 * four reorderable regions of the sidebar.
 *
 * One reorder, computed as splice-then-reindex: take the source out of `currentIds`, put it back
 * beside the target, then ask each remaining id which slot it now sits in. That is the same answer
 * the pinned tiles and the agent rows used to reach through an index ternary, and the same one
 * people and sections used to reach through two separate copies of this loop.
 *
 * `axis` is "y" for the three vertical lists and "x-and-y" for the pinned grid, which wraps. A row
 * that does not move is absent from the result rather than present as a zero, so the caller can
 * treat a missing key and a zero offset as the same thing.
 */
export function reorderOffsets(
  currentIds: readonly string[],
  sourceId: string,
  target: { id: string; placement: "before" | "after" },
  slotOf: (id: string) => ReorderSlot | undefined,
  axis: "x-and-y" | "y",
): Record<string, DragOffset> {
  const desiredIds = currentIds.filter((id) => id !== sourceId);
  const targetIndex = desiredIds.indexOf(target.id);
  if (targetIndex < 0) return {};
  desiredIds.splice(targetIndex + (target.placement === "after" ? 1 : 0), 0, sourceId);
  const desiredIndexById = new Map(desiredIds.map((id, index) => [id, index]));
  const offsets: Record<string, DragOffset> = {};
  for (const id of currentIds) {
    if (id === sourceId) continue;
    const desiredIndex = desiredIndexById.get(id);
    const destinationId = desiredIndex === undefined ? undefined : currentIds[desiredIndex];
    const currentSlot = slotOf(id);
    const destinationSlot = destinationId === undefined ? undefined : slotOf(destinationId);
    if (!currentSlot || !destinationSlot) continue;
    const x = axis === "x-and-y" ? (destinationSlot.left ?? 0) - (currentSlot.left ?? 0) : 0;
    const y = destinationSlot.top - currentSlot.top;
    if (x !== 0 || y !== 0) offsets[id] = { x, y };
  }
  return offsets;
}

/**
 * A pinned tile and an agent row carry no before/after of their own: hovering one means taking its
 * slot, which is `after` when the dragged item started above it and `before` when it started below.
 * The two vertical lists that do carry a placement - people and sections - pass theirs through.
 */
export function placementForSwap(
  currentIds: readonly string[],
  sourceId: string,
  targetId: string,
): "before" | "after" {
  return currentIds.indexOf(sourceId) < currentIds.indexOf(targetId) ? "after" : "before";
}
