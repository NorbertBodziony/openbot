/**
 * Every read projection the sidebar renders and drags against: the props filtered, sorted, grouped
 * and indexed. Nothing here mutates and nothing here calls a prop callback, which is what makes it
 * safe for the drag engine to hold - it satisfies the engine's list model and can do nothing else.
 */

import { SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID } from "@openbot/contracts/ipc";
import { createMemo } from "solid-js";
import type { BotProfile } from "../../../data";
import { sidebarPinnedItemKey } from "../../../sidebar-pins";
import type { ResolvedPinnedItem, SidebarProps } from "../../Sidebar";
import { teamMemberName } from "../../TeamPersonAvatar";
import { botMatchesQuery, personMatchesQuery } from "../sidebar-filtering";

export function createSidebarDataStore(deps: { normalizedQuery: () => string; props: SidebarProps }) {
  const { normalizedQuery, props } = deps;

  const directThreadByMember = createMemo(
    () => new Map(props.directThreads.map((thread) => [thread.otherMemberId, thread])),
  );
  const agentPinnedItems = createMemo(() => props.pinnedItems.filter((item) => item.kind === "agent"));
  const pinnedKeys = createMemo(() => new Set(agentPinnedItems().map(sidebarPinnedItemKey)));
  const botById = createMemo(() => new Map(props.bots.map((bot) => [bot.id, bot])));
  const personById = createMemo(() => new Map(props.people.map((member) => [member.id, member])));
  const resolvedPinnedItems = createMemo<ResolvedPinnedItem[]>(() => {
    const items: ResolvedPinnedItem[] = [];
    for (const ref of agentPinnedItems()) {
      if (ref.kind === "agent") {
        const bot = botById().get(ref.id);
        if (bot && botMatchesQuery(bot, normalizedQuery())) items.push({ ref, bot });
      }
    }
    return items;
  });
  const filteredBots = createMemo(() => {
    const orderIndex = new Map(props.layout.agentOrder.map((agentId, index) => [agentId, index]));
    const naturalIndex = new Map(props.bots.map((bot, index) => [bot.id, index]));
    return props.bots
      .filter(
        (bot) =>
          !pinnedKeys().has(sidebarPinnedItemKey({ kind: "agent", id: bot.id })) &&
          botMatchesQuery(bot, normalizedQuery()),
      )
      .sort(
        (left, right) =>
          (orderIndex.get(left.id) ?? props.layout.agentOrder.length + (naturalIndex.get(left.id) ?? 0)) -
          (orderIndex.get(right.id) ?? props.layout.agentOrder.length + (naturalIndex.get(right.id) ?? 0)),
      );
  });
  const orderedPeople = createMemo(() => {
    const natural = [...props.people].sort((left, right) => {
      const leftThread = directThreadByMember().get(left.id);
      const rightThread = directThreadByMember().get(right.id);
      if (leftThread || rightThread) {
        return (rightThread?.updatedAt ?? "").localeCompare(leftThread?.updatedAt ?? "");
      }
      if (left.online !== right.online) return left.online ? -1 : 1;
      return teamMemberName(left).localeCompare(teamMemberName(right));
    });
    const orderIndex = new Map(props.peopleOrder.map((memberId, index) => [memberId, index]));
    const naturalIndex = new Map(natural.map((member, index) => [member.id, index]));
    return natural.sort(
      (left, right) =>
        (orderIndex.get(left.id) ?? props.peopleOrder.length + (naturalIndex.get(left.id) ?? 0)) -
        (orderIndex.get(right.id) ?? props.peopleOrder.length + (naturalIndex.get(right.id) ?? 0)),
    );
  });
  const filteredPeople = createMemo(() =>
    orderedPeople().filter((member) => {
      const thread = directThreadByMember().get(member.id);
      return personMatchesQuery(member, thread, normalizedQuery());
    }),
  );
  const customSectionById = createMemo(() => new Map(props.layout.sections.map((section) => [section.id, section])));
  const collapsedSectionIds = createMemo(() => new Set(props.collapsedSectionIds));
  const filteredBotsBySection = createMemo(() => {
    const groups = new Map<string, BotProfile[]>();
    for (const bot of filteredBots()) {
      const assigned = props.layout.agentAssignments[bot.id];
      const sectionId = assigned && customSectionById().has(assigned) ? assigned : SIDEBAR_UNASSIGNED_SECTION_ID;
      groups.set(sectionId, [...(groups.get(sectionId) ?? []), bot]);
    }
    return groups;
  });
  const visibleSectionIds = createMemo(() =>
    props.layout.order.filter((sectionId) => {
      if (sectionId === SIDEBAR_PEOPLE_SECTION_ID) return props.showPeople !== false && filteredPeople().length > 0;
      if (customSectionById().has(sectionId)) {
        return !normalizedQuery() || (filteredBotsBySection().get(sectionId)?.length ?? 0) > 0;
      }
      if (sectionId !== SIDEBAR_UNASSIGNED_SECTION_ID) return false;
      return (filteredBotsBySection().get(sectionId)?.length ?? 0) > 0;
    }),
  );

  function sectionIsCollapsed(sectionId: string): boolean {
    return !normalizedQuery() && collapsedSectionIds().has(sectionId);
  }

  function sectionPosition(sectionId: string): number {
    return visibleSectionIds().indexOf(sectionId);
  }

  function sectionAcceptsAgent(sectionId: string): boolean {
    return sectionId === SIDEBAR_UNASSIGNED_SECTION_ID || customSectionById().has(sectionId);
  }

  /**
   * The section a dragged agent counts as leaving. Deliberately not the menu's `currentSectionId`,
   * which answers `null` for an unassigned agent because that is where its tick goes.
   */
  function assignedSectionId(agentId: string): string {
    const assigned = props.layout.agentAssignments[agentId];
    return assigned && customSectionById().has(assigned) ? assigned : SIDEBAR_UNASSIGNED_SECTION_ID;
  }

  function sectionLabel(sectionId: string): string {
    if (sectionId === SIDEBAR_PEOPLE_SECTION_ID) return "People";
    if (sectionId === SIDEBAR_UNASSIGNED_SECTION_ID) return "Unassigned";
    return customSectionById().get(sectionId)?.name ?? "Section";
  }

  function visiblePinnedKeys(): string[] {
    return resolvedPinnedItems().map((item) => sidebarPinnedItemKey(item.ref));
  }

  return {
    agentPinnedItems,
    assignedSectionId,
    botById,
    customSectionById,
    directThreadByMember,
    filteredBots,
    filteredBotsBySection,
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
  };
}
