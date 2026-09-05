/**
 * Every sidebar change that leaves the component: `onMutateLayout`, `onPin`, `onUnpin`,
 * `onReorderPinned` and `onReorderPeople`, each paired with what it announces. Gathered here so the
 * list of things the sidebar can ask its host to do is one file, reachable from the drag engine,
 * from the context menus and from the keyboard reorder shortcuts alike.
 */

import {
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutAction,
  type TeamPresenceMember,
} from "@openbot/contracts/ipc";
import { teamMemberName } from "../../../components/TeamPersonAvatar";
import type { AgentProfile } from "../../../data";
import type {
  AgentDropTarget,
  PersonDropTarget,
  SectionDropTarget,
  SidebarDragSource,
  SidebarDropTarget,
} from "../sidebar-drag-model";
import { type SidebarPinnedItem, sidebarPinnedItemKey } from "../sidebar-pins";
import type { SidebarProps } from "../sidebar-types";

export function createSidebarLayoutActions(deps: {
  agentPinnedItems: () => SidebarPinnedItem[];
  announce: (message: string) => void;
  announceError: (cause: unknown) => void;
  assignedSectionId: (agentId: string) => string;
  agentById: () => Map<string, AgentProfile>;
  canPinDraggedSidebarItem: () => boolean;
  draggedSidebarItem: () => SidebarPinnedItem | null;
  filteredAgentsBySection: () => Map<string, AgentProfile[]>;
  filteredPeople: () => TeamPresenceMember[];
  layoutMutable: () => boolean;
  orderedPeople: () => TeamPresenceMember[];
  personById: () => Map<string, TeamPresenceMember>;
  props: SidebarProps;
  sectionLabel: (sectionId: string) => string;
  visiblePinnedKeys: () => string[];
  visibleSectionIds: () => string[];
}) {
  const {
    agentPinnedItems,
    announce,
    announceError,
    assignedSectionId,
    agentById,
    canPinDraggedSidebarItem,
    draggedSidebarItem,
    filteredAgentsBySection,
    filteredPeople,
    layoutMutable,
    orderedPeople,
    personById,
    props,
    sectionLabel,
    visiblePinnedKeys,
    visibleSectionIds,
  } = deps;

  function moveSection(sectionId: string, direction: "up" | "down"): void {
    const visibleOrder = visibleSectionIds();
    const index = visibleOrder.indexOf(sectionId);
    const targetSectionId = visibleOrder[index + (direction === "up" ? -1 : 1)];
    const rawIndex = props.layout.order.indexOf(sectionId);
    const rawTargetIndex = targetSectionId ? props.layout.order.indexOf(targetSectionId) : -1;
    if (index < 0 || rawIndex < 0 || rawTargetIndex < 0) return;
    const steps = Math.abs(rawTargetIndex - rawIndex);
    void props.onMutateLayout({ type: "move", sectionId, direction, steps }).catch(announceError);
  }

  /** Moves one agent into a section, or out of every section when `sectionId` is null. */
  function assignAgentSection(agentId: string, sectionId: string | null): void {
    void props.onMutateLayout({ type: "assign", agentId, sectionId }).catch(announceError);
  }

  function reorderDraggedPerson(sourceMemberId: string, target: PersonDropTarget): void {
    const memberIds = orderedPeople()
      .map((member) => member.id)
      .filter((memberId) => memberId !== sourceMemberId);
    const targetIndex = memberIds.indexOf(target.memberId);
    if (targetIndex < 0) return;
    memberIds.splice(targetIndex + (target.placement === "after" ? 1 : 0), 0, sourceMemberId);
    props.onReorderPeople(memberIds);
    const position = memberIds.indexOf(sourceMemberId) + 1;
    const member = personById().get(sourceMemberId);
    announce(`Moved ${member ? teamMemberName(member) : "person"} to position ${position} of ${memberIds.length}.`);
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
    const sectionAgents = filteredAgentsBySection().get(target.sectionId) ?? [];
    const idsWithoutSource = sectionAgents.map((agent) => agent.id).filter((candidate) => candidate !== agentId);
    const targetIndex = idsWithoutSource.indexOf(target.agentId);
    if (targetIndex < 0) return;
    const beforeAgentId = target.placement === "before" ? target.agentId : (idsWithoutSource[targetIndex + 1] ?? null);
    void props
      .onMutateLayout({
        type: "move-agent",
        agentId,
        sectionId: target.sectionId === SIDEBAR_UNASSIGNED_SECTION_ID ? null : target.sectionId,
        beforeAgentId,
      })
      .then(
        () => announce(`Moved ${agentById().get(agentId)?.name ?? "agent"} in ${sectionLabel(target.sectionId)}.`),
        announceError,
      );
  }

  function reorderDraggedSection(sourceSectionId: string, target: SectionDropTarget): void {
    if (sourceSectionId === target.sectionId) return;
    const sourceIndex = props.layout.order.indexOf(sourceSectionId);
    if (sourceIndex < 0) return;
    const orderWithoutSource = props.layout.order.filter((sectionId) => sectionId !== sourceSectionId);
    const targetIndex = orderWithoutSource.indexOf(target.sectionId);
    if (targetIndex < 0) return;
    const insertionIndex = targetIndex + (target.placement === "after" ? 1 : 0);
    const steps = Math.abs(insertionIndex - sourceIndex);
    if (steps === 0) return;
    const direction = insertionIndex < sourceIndex ? "up" : "down";

    const visibleOrder = visibleSectionIds().filter((sectionId) => sectionId !== sourceSectionId);
    const visibleTargetIndex = visibleOrder.indexOf(target.sectionId);
    const visibleInsertionIndex = visibleTargetIndex + (target.placement === "after" ? 1 : 0);
    void props
      .onMutateLayout({ type: "move", sectionId: sourceSectionId, direction, steps })
      .then(
        () =>
          announce(
            `Moved ${sectionLabel(sourceSectionId)} to position ${visibleInsertionIndex + 1} of ${visibleOrder.length + 1}.`,
          ),
        announceError,
      );
  }

  function pinDraggedSidebarItem(): boolean {
    const item = draggedSidebarItem();
    if (!item || !canPinDraggedSidebarItem()) return false;
    props.onPin(item);
    const name = agentById().get(item.id)?.name ?? "agent";
    announce(`Pinned ${name}.`);
    return true;
  }

  function moveAgentAction(agentId: string, target: AgentDropTarget): SidebarLayoutAction | null {
    const sectionAgents = filteredAgentsBySection().get(target.sectionId) ?? [];
    const idsWithoutSource = sectionAgents.map((agent) => agent.id).filter((candidate) => candidate !== agentId);
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
      announce("This host does not support sidebar layout changes.");
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
      if (action) await props.onMutateLayout(action);
      props.onUnpin({ kind: "agent", id: source.id });
      announce(`Moved ${agentById().get(source.id)?.name ?? "agent"} to ${sectionLabel(sectionId)}.`);
    } catch (error) {
      announceError(error);
    }
  }

  /**
   * The one signature that takes its source as a parameter. Everything below decides where a drag
   * lands, and the engine holds the only source that is current in this tick - reading it back off
   * the drag store would be one flush stale, and would land the drag in the previous target.
   */
  function commitSidebarDrop(source: SidebarDragSource, target: SidebarDropTarget | null): void {
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
        void props
          .onMutateLayout(appendAgentAction(source.id, target.sectionId))
          .then(
            () =>
              announce(`Moved ${agentById().get(source.id)?.name ?? "agent"} to ${sectionLabel(target.sectionId)}.`),
            announceError,
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

  function reorderPinnedItem(sourceKey: string, targetKey: string): void {
    if (sourceKey === targetKey) return;
    const items = [...agentPinnedItems()];
    const sourceIndex = items.findIndex((item) => sidebarPinnedItemKey(item) === sourceKey);
    const targetIndex = items.findIndex((item) => sidebarPinnedItemKey(item) === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = items.splice(sourceIndex, 1);
    items.splice(targetIndex, 0, source);
    props.onReorderPinned(items);
    const position = visiblePinnedKeys().indexOf(targetKey) + 1;
    announce(`Moved pinned chat to position ${position} of ${visiblePinnedKeys().length}.`);
  }

  function movePinnedItem(key: string, direction: -1 | 1): void {
    const keys = visiblePinnedKeys();
    const index = keys.indexOf(key);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= keys.length) return;
    reorderPinnedItem(key, keys[targetIndex]);
  }

  return {
    assignAgentSection,
    commitSidebarDrop,
    moveDraggedAgent,
    movePersonByKeyboard,
    movePinnedItem,
    moveSection,
    pinDraggedSidebarItem,
    reorderDraggedPerson,
    reorderDraggedSection,
    reorderPinnedItem,
  };
}
