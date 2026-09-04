/**
 * Everything `Sidebar` is, minus the markup. The component builds this once and reads it, and the
 * regions read it through the scope context. The drag&drop pipeline is the one part that lives
 * elsewhere: it needs a closure of its own, and `createSidebarDragEngine` is it.
 */

import { SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID } from "@openbot/contracts/ipc";
import { createContext, createEffect, createMemo, createSignal, createStore, onCleanup, useContext } from "solid-js";
import type { BotProfile } from "../../data";
import { sidebarPinnedItemKey } from "../../sidebar-pins";
import { createScrollFades } from "../createScrollFades";
import type { ResolvedPinnedItem, SidebarProps } from "../Sidebar";
import { teamMemberName } from "../TeamPersonAvatar";
import { createSidebarDragEngine } from "./createSidebarDragEngine";
import { botMatchesQuery, personMatchesQuery } from "./sidebar-filtering";

/**
 * The one delete confirmation the sidebar can have open: an agent, or a custom section, never both.
 * The attempt's progress and the reason it failed live inside the record rather than beside it, so
 * closing the dialog cannot leave a "Deleting…" button or the previous attempt's message behind.
 */
interface SidebarPendingDelete {
  deleting: boolean;
  error: string | null;
  /** The agent or the section, whichever `kind` names. */
  id: string;
  /** Which of the two confirmations is on screen. Each dialog renders from one arm. */
  kind: "agent" | "section";
}

/** What the section editor is editing: a section about to exist, or the one being renamed. */
type SidebarSectionEditorTarget = { kind: "create"; agentId?: string } | { kind: "rename"; sectionId: string };

/**
 * The open section-name editor. The name as typed, its validation message and the save in flight
 * hang off the editor because none of them means anything without one - a name left behind by a
 * closed editor is what every `startCreateSection` had to remember to clear.
 */
interface SidebarSectionEditor {
  error: string | null;
  name: string;
  saving: boolean;
  target: SidebarSectionEditorTarget;
}

/** The two changes the sidebar can have half-made, each waiting on the user rather than on data. */
interface SidebarPending {
  deletion: SidebarPendingDelete | null;
  sectionEditor: SidebarSectionEditor | null;
}

export function createSidebarScope(props: SidebarProps) {
  const layoutMutable = () => props.layoutMutable !== false;
  const [query, setQuery] = createSignal("");
  const [pending, setPending] = createStore<SidebarPending>({ deletion: null, sectionEditor: null });
  // Both dialogs read these: only one confirmation exists, and each dialog only renders while it is
  // the one. That is also why a section delete no longer needs its own pair of flags.
  const deleting = () => pending.deletion?.deleting === true;
  const deleteError = () => pending.deletion?.error ?? null;
  const scrollFades = createScrollFades();

  const [reorderAnnouncement, setReorderAnnouncement] = createSignal("");
  let botList: HTMLElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let sectionNameInput: HTMLInputElement | undefined;

  const directThreadByMember = createMemo(
    () => new Map(props.directThreads.map((thread) => [thread.otherMemberId, thread])),
  );
  const normalizedQuery = createMemo(() => query().trim().toLowerCase());
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
  const deleteTarget = createMemo(() => {
    const deletion = pending.deletion;
    return deletion?.kind === "agent" ? props.bots.find((bot) => bot.id === deletion.id) : undefined;
  });
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
  const sectionDeleteTarget = createMemo(() => {
    const deletion = pending.deletion;
    return deletion?.kind === "section"
      ? props.layout.sections.find((section) => section.id === deletion.id)
      : undefined;
  });

  const dragEngine = createSidebarDragEngine({
    agentPinnedItems,
    assignedSectionId,
    botById,
    filteredBotsBySection,
    filteredPeople,
    getBotList: () => botList,
    layoutMutable,
    orderedPeople,
    personById,
    props,
    scrollFades,
    sectionAcceptsAgent,
    sectionLabel,
    setReorderAnnouncement,
    visiblePinnedKeys,
    visibleSectionIds,
  });
  const {
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
  } = dragEngine;

  onCleanup(() => {
    stopSidebarDragging();
    scrollFades.stop();
  });

  createEffect(
    () => [resolvedPinnedItems(), filteredBots(), filteredPeople()],
    () => {
      scrollFades.remeasure();
    },
  );

  function openDelete(kind: SidebarPendingDelete["kind"], id: string): void {
    setPending((state) => {
      state.deletion = { deleting: false, error: null, id, kind };
    });
  }

  /** Closing the confirmation is what discards a failed attempt's message; nothing else has to. */
  function closeDelete(): void {
    setPending((state) => {
      state.deletion = null;
    });
  }

  /** Marks the confirmation as running and drops what the previous attempt said. */
  function beginDelete(): void {
    setPending((state) => {
      if (!state.deletion) return;
      state.deletion.deleting = true;
      state.deletion.error = null;
    });
  }

  /** A failed delete leaves the confirmation open, no longer running, saying why. */
  function failDelete(cause: unknown): void {
    setPending((state) => {
      if (!state.deletion) return;
      state.deletion.deleting = false;
      state.deletion.error = cause instanceof Error ? cause.message : String(cause);
    });
  }

  async function confirmDelete() {
    const deletion = pending.deletion;
    if (deletion?.kind !== "agent" || deletion.deleting) return;
    beginDelete();
    try {
      await props.onDeleteBot(deletion.id);
      closeDelete();
    } catch (error) {
      failDelete(error);
    }
  }

  const setSectionNameInput = (element: HTMLInputElement) => {
    sectionNameInput = element;
  };

  /**
   * The editor mounts and unmounts as `pending.sectionEditor` moves between create and rename, and
   * the new element can claim the slot before the old one is torn down - so only the element that
   * still holds it may clear it. Clearing unconditionally would leave `focusSectionName` focusing a
   * detached input, which is the silent half of "bad name, no second chance to fix it".
   */
  const releaseSectionNameInput = (element: HTMLInputElement | undefined) => {
    if (sectionNameInput === element) sectionNameInput = undefined;
  };

  function updateSectionEditorName(value: string): void {
    setPending((state) => {
      if (!state.sectionEditor) return;
      state.sectionEditor.name = value;
      state.sectionEditor.error = null;
    });
  }

  function focusSectionName(): void {
    queueMicrotask(() => {
      sectionNameInput?.focus();
      sectionNameInput?.select();
    });
  }

  function startCreateSection(agentId?: string): void {
    props.onExpand();
    setPending((state) => {
      state.sectionEditor = {
        error: null,
        name: "",
        saving: false,
        target: { kind: "create", ...(agentId ? { agentId } : {}) },
      };
    });
    focusSectionName();
  }

  function startRenameSection(sectionId: string): void {
    const section = customSectionById().get(sectionId);
    if (!section) return;
    props.onExpand();
    setPending((state) => {
      state.sectionEditor = { error: null, name: section.name, saving: false, target: { kind: "rename", sectionId } };
    });
    focusSectionName();
  }

  function cancelSectionEditor(): void {
    if (pending.sectionEditor?.saving) return;
    setPending((state) => {
      state.sectionEditor = null;
    });
  }

  /** The editor owns its validation message, so it cannot be read once the editor has closed. */
  function setSectionNameError(message: string): void {
    setPending((state) => {
      if (state.sectionEditor) state.sectionEditor.error = message;
    });
  }

  async function saveSectionEditor(): Promise<void> {
    const editor = pending.sectionEditor;
    if (!editor || editor.saving) return;
    const name = editor.name.trim();
    if (!name) {
      setSectionNameError("Section name is required.");
      focusSectionName();
      return;
    }
    const target = editor.target;
    const duplicate = props.layout.sections.some(
      (section) =>
        section.name.toLocaleLowerCase() === name.toLocaleLowerCase() &&
        !(target.kind === "rename" && target.sectionId === section.id),
    );
    if (duplicate) {
      setSectionNameError("Section names must be unique.");
      focusSectionName();
      return;
    }
    setPending((state) => {
      if (!state.sectionEditor) return;
      state.sectionEditor.error = null;
      state.sectionEditor.saving = true;
    });
    try {
      await props.onMutateLayout(
        target.kind === "create"
          ? { type: "create", name, ...(target.agentId ? { agentId: target.agentId } : {}) }
          : { type: "rename", sectionId: target.sectionId, name },
      );
      // The editor closes on success, which is also what releases the save it was holding.
      setPending((state) => {
        state.sectionEditor = null;
      });
    } catch (error) {
      setPending((state) => {
        if (!state.sectionEditor) return;
        state.sectionEditor.error = error instanceof Error ? error.message : String(error);
        state.sectionEditor.saving = false;
      });
      focusSectionName();
    }
  }

  async function confirmSectionDelete(): Promise<void> {
    const deletion = pending.deletion;
    if (deletion?.kind !== "section" || deletion.deleting) return;
    beginDelete();
    try {
      await props.onMutateLayout({ type: "delete", sectionId: deletion.id });
      closeDelete();
    } catch (error) {
      failDelete(error);
    }
  }

  function sectionIsCollapsed(sectionId: string): boolean {
    return !normalizedQuery() && collapsedSectionIds().has(sectionId);
  }

  function sectionPosition(sectionId: string): number {
    return visibleSectionIds().indexOf(sectionId);
  }

  function moveSection(sectionId: string, direction: "up" | "down"): void {
    const visibleOrder = visibleSectionIds();
    const index = visibleOrder.indexOf(sectionId);
    const targetSectionId = visibleOrder[index + (direction === "up" ? -1 : 1)];
    const rawIndex = props.layout.order.indexOf(sectionId);
    const rawTargetIndex = targetSectionId ? props.layout.order.indexOf(targetSectionId) : -1;
    if (index < 0 || rawIndex < 0 || rawTargetIndex < 0) return;
    const steps = Math.abs(rawTargetIndex - rawIndex);
    void props.onMutateLayout({ type: "move", sectionId, direction, steps }).catch((error) => {
      setReorderAnnouncement(error instanceof Error ? error.message : String(error));
    });
  }

  /** Moves one agent into a section, or out of every section when `sectionId` is null. */
  function assignAgentSection(agentId: string, sectionId: string | null): void {
    void props.onMutateLayout({ type: "assign", agentId, sectionId }).catch((error) => {
      setReorderAnnouncement(error instanceof Error ? error.message : String(error));
    });
  }

  function sectionAcceptsAgent(sectionId: string): boolean {
    return sectionId === SIDEBAR_UNASSIGNED_SECTION_ID || customSectionById().has(sectionId);
  }

  function assignedSectionId(agentId: string): string {
    const assigned = props.layout.agentAssignments[agentId];
    return assigned && customSectionById().has(assigned) ? assigned : SIDEBAR_UNASSIGNED_SECTION_ID;
  }

  function sectionLabel(sectionId: string): string {
    if (sectionId === SIDEBAR_PEOPLE_SECTION_ID) return "People";
    if (sectionId === SIDEBAR_UNASSIGNED_SECTION_ID) return "Unassigned";
    return customSectionById().get(sectionId)?.name ?? "Section";
  }

  function expandToSearch(): void {
    props.onExpand();
    queueMicrotask(() => searchInput?.focus());
  }

  function visiblePinnedKeys(): string[] {
    return resolvedPinnedItems().map((item) => sidebarPinnedItemKey(item.ref));
  }

  const setSearchInputElement = (element: HTMLInputElement) => {
    searchInput = element;
  };

  /** The two statements the list's `ref` used to run inline, in the same order. */
  const setBotListElement = (element: HTMLElement) => {
    botList = element;
    scrollFades.bind(element);
  };

  return {
    props,
    cancelSectionEditor,
    moveSection,
    saveSectionEditor,
    sectionPosition,
    releaseSectionNameInput,
    setSectionNameInput,
    startRenameSection,
    startSectionDragging,
    updateSectionEditorName,
    visibleSectionIds,
    draggedAgentId,
    endAgentDragging,
    startAgentDragging,
    agentPinnedItems,
    assignAgentSection,
    openDelete,
    closeDelete,
    confirmDelete,
    confirmSectionDelete,
    customSectionById,
    deleteError,
    deleteTarget,
    deleting,
    directThreadByMember,
    drag,
    dragOffset,
    dragOverPinnedKey,
    draggedPinnedKey,
    draggingKind,
    dropSidebarNativeDrag,
    expandToSearch,
    filteredBots,
    filteredBotsBySection,
    filteredPeople,
    handleListDragLeave,
    handlePinnedTransitionEnd,
    layoutMutable,
    movePersonByKeyboard,
    movePinnedItem,
    normalizedQuery,
    pending,
    pinnedDropActive,
    query,
    reorderAnnouncement,
    resolvedPinnedItems,
    scrollFades,
    sectionDeleteTarget,
    sectionDragClasses,
    sectionIsCollapsed,
    setBotListElement,
    setQuery,
    setSearchInputElement,
    sidebarClickIsSuppressed,
    startCreateSection,
    startNativeItemDragging,
    startPersonDragging,
    stopSidebarDragging,
    updateSidebarNativeDrag,
  };
}

export type SidebarScope = ReturnType<typeof createSidebarScope>;

export const SidebarScopeContext = createContext<SidebarScope>();

export function useSidebarScope(): SidebarScope {
  const scope = useContext(SidebarScopeContext);
  if (!scope) throw new Error("Sidebar scope is unavailable outside Sidebar.");
  return scope;
}
