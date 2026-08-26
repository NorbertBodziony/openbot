import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { BotAvatarHue, DirectThreadSummary, TeamPresenceMember } from "@openbot/contracts/ipc";
import {
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutAction,
  type SidebarLayoutSnapshot,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import type { BotProfile } from "../data";
import { MAX_SIDEBAR_PINNED_ITEMS, type SidebarPinnedItem, sidebarPinnedItemKey } from "../sidebar-pins";
import { AgentAvatar } from "./AgentAvatar";
import { createBoundedDragPreview } from "./createBoundedDragPreview";
import { TeamPersonAvatar, teamMemberName } from "./TeamPersonAvatar";
import { TypingDots } from "./TypingDots";
import {
  AlertDialog,
  ArrowDown,
  ArrowUp,
  Badge,
  Button,
  buttonVariants,
  Check,
  ChevronDown,
  ChevronRight,
  ContextMenu,
  Folder,
  FolderInput,
  FolderPlus,
  Input,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "./ui";

interface SidebarProps {
  serverName: string;
  onOpenServerSettings: (trigger: HTMLElement) => void;
  bots: BotProfile[];
  activeBotId: string;
  people: TeamPresenceMember[];
  directThreads: DirectThreadSummary[];
  activeDirectMemberId: string | null;
  agentStates: Record<string, SidebarAgentState>;
  layout: SidebarLayoutSnapshot;
  collapsedSectionIds: string[];
  onMutateLayout: (action: SidebarLayoutAction) => Promise<void>;
  onToggleSection: (sectionId: string) => void;
  pinnedItems: SidebarPinnedItem[];
  peopleOrder: string[];
  onPin: (item: SidebarPinnedItem) => void;
  onUnpin: (item: SidebarPinnedItem) => void;
  onReorderPinned: (items: SidebarPinnedItem[]) => void;
  onReorderPeople: (memberIds: string[]) => void;
  onSelectBot: (botId: string) => void;
  onSelectPerson: (memberId: string) => void;
  onPreloadDirectConversation?: () => void;
  onCreateBot: () => void;
  onEditBot: (botId: string) => void;
  onDeleteBot: (botId: string) => Promise<void>;
  compact: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  emptyAction?: {
    label: string;
    avatarSeed: string;
    avatarHue: BotAvatarHue | null;
    onSelect: () => void;
  };
}

export type SidebarAgentState = { kind: "working" } | { kind: "responded" } | { kind: "unread"; count: number };

type ResolvedPinnedItem = { ref: SidebarPinnedItem; bot: BotProfile };

interface DragSlot {
  bottom: number;
  key: string;
  left: number;
  right: number;
  top: number;
  centerX: number;
  centerY: number;
}

interface SectionDropTarget {
  sectionId: string;
  placement: "before" | "after";
}

interface AgentDropTarget {
  agentId: string;
  placement: "before" | "after";
  sectionId: string;
}

interface PersonDropTarget {
  memberId: string;
  placement: "before" | "after";
}

interface AgentDragSlot {
  agentId: string;
  bottom: number;
  centerY: number;
  element: HTMLElement;
  height: number;
  sectionId: string;
  top: number;
}

interface SectionDragSlot {
  bottom: number;
  centerY: number;
  sectionId: string;
  top: number;
}

interface PersonDragSlot {
  bottom: number;
  centerY: number;
  element: HTMLElement;
  memberId: string;
  top: number;
}

type SidebarDragSource =
  | { kind: "agent"; id: string; origin: "section" }
  | { kind: "agent"; id: string; key: string; origin: "pinned" }
  | { kind: "person"; id: string; origin: "people" }
  | { kind: "section"; id: string };

type SidebarDropTarget =
  | { kind: "pinned"; key: string | null }
  | { kind: "agent"; target: AgentDropTarget }
  | { kind: "section"; sectionId: string }
  | { kind: "person"; target: PersonDropTarget }
  | { kind: "section-order"; target: SectionDropTarget };

interface SidebarDragPoint {
  clientX: number;
  clientY: number;
}

interface SidebarDragSession {
  source: SidebarDragSource;
  startScrollTop: number;
}

interface SidebarDragGeometry {
  list: DOMRect | null;
  pinned: DOMRect | null;
}

interface SidebarNativeDragStart {
  className: string;
  createPreview?: (source: HTMLElement) => HTMLElement;
  data: string;
  horizontal?: boolean;
  previewSize?: { height: number; width: number };
  source: SidebarDragSource;
}

function sidebarDropTargetsEqual(left: SidebarDropTarget | null, right: SidebarDropTarget | null): boolean {
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

function sidebarAgentStateLabel(state: SidebarAgentState): string {
  if (state.kind === "working") return "Thinking";
  if (state.kind === "responded") return "Responded";
  return `${state.count} new ${state.count === 1 ? "reply" : "replies"}`;
}

function SidebarAgentIndicator(props: { state: SidebarAgentState }) {
  const unreadCount = () => (props.state.kind === "unread" ? props.state.count : 0);
  return (
    <span class={`bot-row-agent-status bot-row-agent-status-${props.state.kind}`} aria-hidden="true">
      <Show when={props.state.kind === "working"}>
        <TypingDots class="bot-row-thinking-dots" />
      </Show>
      <Show when={props.state.kind === "responded"}>
        <svg viewBox="0 0 12 12">
          <title>Responded</title>
          <path d="m3 6.2 1.8 1.8L9 3.8" />
        </svg>
      </Show>
      <Show when={props.state.kind === "unread"}>
        <span>{unreadCount()}</span>
      </Show>
    </span>
  );
}

function SidebarPinnedAvatar(props: { item: ResolvedPinnedItem; agentState: () => SidebarAgentState | undefined }) {
  return (
    <span class="bot-row-avatar sidebar-pinned-avatar">
      <AgentAvatar bot={props.item.bot} motion={props.agentState()?.kind === "working" ? "working" : "idle"} />
      <Show when={props.agentState()}>{(state) => <SidebarAgentIndicator state={state()} />}</Show>
    </span>
  );
}

function createSidebarAgentDragCard(source: HTMLElement): HTMLElement {
  const card = document.createElement("div");
  card.className = "bot-row sidebar-pinned-row sidebar-agent-drag-card";

  const sourceAvatar = source.querySelector(".bot-row-avatar")?.cloneNode(true);
  if (sourceAvatar instanceof HTMLElement) {
    sourceAvatar.classList.add("sidebar-pinned-avatar");
    card.append(sourceAvatar);
  }

  const copy = document.createElement("span");
  copy.className = "bot-row-copy sidebar-pinned-copy";
  const name = document.createElement("strong");
  name.className = "sidebar-pinned-name";
  name.textContent =
    source
      .querySelector(".sidebar-pinned-name, .bot-row-title strong, .bot-row-heading > strong")
      ?.textContent?.trim() ?? "Chat";
  copy.append(name);

  const titleText = source.querySelector(".sidebar-pinned-title, .bot-role-badge")?.textContent?.trim();
  if (titleText) {
    const title = document.createElement("span");
    title.className = "ui-badge sidebar-pinned-title";
    title.dataset.size = "sm";
    const label = document.createElement("span");
    label.textContent = titleText;
    title.append(label);
    copy.append(title);
  }

  card.append(copy);
  return card;
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-4 fill-none stroke-current">
      <circle cx="8.5" cy="8.5" r="5.5" stroke-width="1.6" />
      <path d="m12.7 12.7 3.6 3.6" stroke-width="1.6" stroke-linecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[18px] fill-none stroke-current">
      <path d="M10 4v12M4 10h12" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  );
}

export function SidebarToggleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="sidebar-toggle-icon">
      <rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2.25" />
      <path d="M7.25 3.75v12.5" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="bot-context-icon size-4 fill-none stroke-current">
      <path d="m12.6 4.2 3.2 3.2-8.7 8.7-3.8.6.6-3.8 8.7-8.7Z" stroke-width="1.4" />
      <path d="m10.9 5.9 3.2 3.2" stroke-width="1.4" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      class="bot-context-icon bot-context-danger-icon size-4 fill-none stroke-current"
    >
      <path
        d="M4.5 6.2h11M8 3.8h4M6.2 6.2l.7 9.3h6.2l.7-9.3M8.4 8.7v4.5M11.6 8.7v4.5"
        stroke-width="1.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = createSignal("");
  const [deleteTargetId, setDeleteTargetId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  const [sectionDeleteTargetId, setSectionDeleteTargetId] = createSignal<string | null>(null);
  const [sectionDeleteError, setSectionDeleteError] = createSignal<string | null>(null);
  const [deletingSection, setDeletingSection] = createSignal(false);
  const [sectionEditor, setSectionEditor] = createSignal<
    { kind: "create"; agentId?: string } | { kind: "rename"; sectionId: string } | null
  >(null);
  const [sectionName, setSectionName] = createSignal("");
  const [sectionNameError, setSectionNameError] = createSignal<string | null>(null);
  const [savingSection, setSavingSection] = createSignal(false);
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  const [draggedPinnedKey, setDraggedPinnedKey] = createSignal<string | null>(null);
  const [dragOverPinnedKey, setDragOverPinnedKey] = createSignal<string | null>(null);
  const [pinnedDropActive, setPinnedDropActive] = createSignal(false);
  const [emptyPinnedDropVisible, setEmptyPinnedDropVisible] = createSignal(false);
  const [draggedAgentId, setDraggedAgentId] = createSignal<string | null>(null);
  const [dragOverAgentId, setDragOverAgentId] = createSignal<string | null>(null);
  const [draggedPersonId, setDraggedPersonId] = createSignal<string | null>(null);
  const [agentDropSectionId, setAgentDropSectionId] = createSignal<string | null>(null);
  const [draggedSectionId, setDraggedSectionId] = createSignal<string | null>(null);
  const [sectionDropTarget, setSectionDropTarget] = createSignal<SectionDropTarget | null>(null);
  const [sectionDragOffsets, setSectionDragOffsets] = createSignal<Record<string, number>>({});
  const [reorderAnnouncement, setReorderAnnouncement] = createSignal("");
  let botList: HTMLElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let sectionNameInput: HTMLInputElement | undefined;
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
  let currentAgentDropSectionId: string | null = null;
  let currentAgentDropTarget: AgentDropTarget | null = null;
  let currentSectionDropTarget: SectionDropTarget | null = null;
  let currentPersonDropTarget: PersonDropTarget | null = null;
  let personDragSlots = new Map<string, PersonDragSlot>();
  let renderedPersonDragOffsets: Record<string, number> = {};
  let suppressSidebarClickUntil = 0;
  const dragPreview = createBoundedDragPreview();
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
  const deleteTarget = createMemo(() => props.bots.find((bot) => bot.id === deleteTargetId()));
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
      if (sectionId === SIDEBAR_PEOPLE_SECTION_ID) return filteredPeople().length > 0;
      if (sectionId !== SIDEBAR_UNASSIGNED_SECTION_ID && !customSectionById().has(sectionId)) return false;
      return (filteredBotsBySection().get(sectionId)?.length ?? 0) > 0;
    }),
  );
  const sectionDeleteTarget = createMemo(() =>
    props.layout.sections.find((section) => section.id === sectionDeleteTargetId()),
  );

  onCleanup(() => {
    stopSidebarDragging();
  });

  function updateScrollFade() {
    if (!botList) return;
    const remaining = botList.scrollHeight - botList.scrollTop - botList.clientHeight;
    setFadeAtTop(botList.scrollTop > 2);
    setFadeAtBottom(remaining > 2);
  }

  createEffect(
    () => [resolvedPinnedItems(), filteredBots(), filteredPeople()],
    () => {
      requestAnimationFrame(updateScrollFade);
    },
  );

  onSettled(() => {
    const resizeObserver = new ResizeObserver(updateScrollFade);
    if (botList) resizeObserver.observe(botList);
    requestAnimationFrame(updateScrollFade);
    return () => {
      resizeObserver.disconnect();
    };
  });

  async function confirmDelete() {
    const botId = deleteTargetId();
    if (!botId || deleting()) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await props.onDeleteBot(botId);
      setDeleteTargetId(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  function focusSectionName(): void {
    queueMicrotask(() => {
      sectionNameInput?.focus();
      sectionNameInput?.select();
    });
  }

  function startCreateSection(agentId?: string): void {
    props.onExpand();
    setSectionEditor({ kind: "create", ...(agentId ? { agentId } : {}) });
    setSectionName("");
    setSectionNameError(null);
    focusSectionName();
  }

  function startRenameSection(sectionId: string): void {
    const section = customSectionById().get(sectionId);
    if (!section) return;
    props.onExpand();
    setSectionEditor({ kind: "rename", sectionId });
    setSectionName(section.name);
    setSectionNameError(null);
    focusSectionName();
  }

  function cancelSectionEditor(): void {
    if (savingSection()) return;
    setSectionEditor(null);
    setSectionNameError(null);
  }

  async function saveSectionEditor(): Promise<void> {
    const editor = sectionEditor();
    if (!editor || savingSection()) return;
    const name = sectionName().trim();
    if (!name) {
      setSectionNameError("Section name is required.");
      focusSectionName();
      return;
    }
    const duplicate = props.layout.sections.some(
      (section) =>
        section.name.toLocaleLowerCase() === name.toLocaleLowerCase() &&
        !(editor.kind === "rename" && editor.sectionId === section.id),
    );
    if (duplicate) {
      setSectionNameError("Section names must be unique.");
      focusSectionName();
      return;
    }
    setSavingSection(true);
    setSectionNameError(null);
    try {
      await props.onMutateLayout(
        editor.kind === "create"
          ? { type: "create", name, ...(editor.agentId ? { agentId: editor.agentId } : {}) }
          : { type: "rename", sectionId: editor.sectionId, name },
      );
      setSectionEditor(null);
    } catch (error) {
      setSectionNameError(error instanceof Error ? error.message : String(error));
      focusSectionName();
    } finally {
      setSavingSection(false);
    }
  }

  async function confirmSectionDelete(): Promise<void> {
    const sectionId = sectionDeleteTargetId();
    if (!sectionId || deletingSection()) return;
    setDeletingSection(true);
    setSectionDeleteError(null);
    try {
      await props.onMutateLayout({ type: "delete", sectionId });
      setSectionDeleteTargetId(null);
    } catch (error) {
      setSectionDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingSection(false);
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
    currentAgentDropSectionId = null;
    currentAgentDropTarget = null;
    currentSectionDropTarget = null;
    currentPersonDropTarget = null;
    setPinnedDropActive(false);
    setEmptyPinnedDropVisible(false);
    setDraggedAgentId(null);
    setDragOverAgentId(null);
    setDraggedPersonId(null);
    setAgentDropSectionId(null);
    applyPersonDragOffsets({});
    setDraggedSectionId(null);
    setSectionDropTarget(null);
    setSectionDragOffsets({});
    botList?.querySelector(".sidebar-pinned-group")?.classList.remove("sidebar-pinned-group-agent-drop-target");
    for (const section of botList?.querySelectorAll<HTMLElement>(".sidebar-section") ?? []) {
      section.classList.remove(
        "sidebar-section-agent-drop-target",
        "sidebar-section-drop-before",
        "sidebar-section-drop-after",
      );
    }
    for (const slot of personDragSlots.values()) slot.element.classList.remove("sidebar-person-item-dragging");
    agentDragSlots.clear();
    personDragSlots.clear();
    sectionDragSlots.clear();
    pinnedDragSlots = [];
    dragPreview.stop();
    setDraggedPinnedKey(null);
    setDragOverPinnedKey(null);
  }

  function sidebarClickIsSuppressed(event: MouseEvent): boolean {
    if (Date.now() >= suppressSidebarClickUntil) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function activeDraggedSectionId(): string | null {
    return dragSession?.source.kind === "section" ? dragSession.source.id : null;
  }

  function activeDraggedPersonId(): string | null {
    return dragSession?.source.kind === "person" ? dragSession.source.id : null;
  }

  function measureSidebarDragTargets(): void {
    sectionDragSlots = new Map();
    agentDragSlots = new Map();
    personDragSlots = new Map();
    pinnedDragSlots = [];
    const startScrollTop = botList?.scrollTop ?? 0;
    sectionDragStartScrollTop = startScrollTop;
    agentDragStartScrollTop = startScrollTop;
    if (!botList) return;
    const pinnedGroup = botList.querySelector<HTMLElement>(".sidebar-pinned-group");
    const pinnedTarget = pinnedGroup?.querySelector<HTMLElement>(".sidebar-pinned-empty-drop") ?? pinnedGroup;
    dragGeometry = {
      list: botList.getBoundingClientRect(),
      pinned: pinnedTarget?.getBoundingClientRect() ?? null,
    };
    for (const section of botList.querySelectorAll<HTMLElement>("[data-section-id]")) {
      const sectionId = section.dataset.sectionId;
      if (!sectionId) continue;
      const bounds = section.getBoundingClientRect();
      sectionDragSlots.set(sectionId, {
        bottom: bounds.bottom,
        sectionId,
        top: bounds.top,
        centerY: bounds.top + bounds.height / 2,
      });
    }
    for (const row of botList.querySelectorAll<HTMLElement>("[data-agent-id]")) {
      const agentId = row.dataset.agentId;
      if (!agentId) continue;
      const bounds = row.getBoundingClientRect();
      agentDragSlots.set(agentId, {
        agentId,
        bottom: bounds.bottom,
        centerY: bounds.top + bounds.height / 2,
        element: row,
        height: bounds.height,
        sectionId: assignedSectionId(agentId),
        top: bounds.top,
      });
    }
    for (const row of botList.querySelectorAll<HTMLElement>("[data-person-id]")) {
      const memberId = row.dataset.personId;
      if (!memberId) continue;
      const bounds = row.getBoundingClientRect();
      personDragSlots.set(memberId, {
        bottom: bounds.bottom,
        centerY: bounds.top + bounds.height / 2,
        element: row,
        memberId,
        top: bounds.top,
      });
    }
    for (const item of botList.querySelectorAll<HTMLElement>("[data-pinned-key]")) {
      const key = item.dataset.pinnedKey;
      if (!key) continue;
      const bounds = item.getBoundingClientRect();
      pinnedDragSlots.push({
        bottom: bounds.bottom,
        centerX: bounds.left + bounds.width / 2,
        centerY: bounds.top + bounds.height / 2,
        key,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
      });
    }
  }

  function startNativeItemDragging(
    event: DragEvent & { currentTarget: HTMLElement },
    options: SidebarNativeDragStart,
  ): void {
    if (props.compact) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/plain", options.data);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    dragSession = { source: options.source, startScrollTop: botList?.scrollTop ?? 0 };
    dragPoint = { clientX: event.clientX, clientY: event.clientY };
    dragTarget = null;
    measureSidebarDragTargets();
    if (!botList) return;
    dragPreview.start({
      bounds: botList,
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
    if (props.compact) return;
    currentAgentDropSectionId = null;
    currentAgentDropTarget = null;
    startNativeItemDragging(event, {
      className: "sidebar-agent-drag-preview",
      createPreview: createSidebarAgentDragCard,
      data: `openbot-agent:${bot.id}`,
      previewSize: { height: 94, width: 72 },
      source: { kind: "agent", id: bot.id, origin: "section" },
    });
    setDraggedAgentId(bot.id);
    setDragOverAgentId(bot.id);
    setAgentDropSectionId(null);
  }

  function startPersonDragging(event: DragEvent & { currentTarget: HTMLElement }, member: TeamPresenceMember): void {
    currentPersonDropTarget = null;
    startNativeItemDragging(event, {
      className: "sidebar-person-drag-preview",
      createPreview: createSidebarAgentDragCard,
      data: `openbot-person:${member.id}`,
      previewSize: { height: 94, width: 72 },
      source: { kind: "person", id: member.id, origin: "people" },
    });
    setDraggedPersonId(member.id);
    personDragSlots.get(member.id)?.element.classList.add("sidebar-person-item-dragging");
    applyPersonDragOffsets({});
  }

  function startSectionDragging(event: DragEvent & { currentTarget: HTMLElement }, sectionId: string): void {
    currentSectionDropTarget = null;
    startNativeItemDragging(event, {
      className: "sidebar-section-drag-preview",
      data: `openbot-section:${sectionId}`,
      horizontal: false,
      source: { kind: "section", id: sectionId },
    });
    setDraggedSectionId(sectionId);
    setSectionDropTarget(null);
    setSectionDragOffsets({});
  }

  function setAgentTarget(target: AgentDropTarget | null, sectionId: string | null): void {
    const currentTarget = currentAgentDropTarget;
    if (
      currentTarget?.agentId === target?.agentId &&
      currentTarget?.placement === target?.placement &&
      currentTarget?.sectionId === target?.sectionId &&
      currentAgentDropSectionId === sectionId
    ) {
      return;
    }
    currentAgentDropTarget = target;
    currentAgentDropSectionId = sectionId;
    setDragOverAgentId(target?.agentId ?? null);
    setAgentDropSectionId(sectionId);
  }

  function computePersonDragOffsets(target: PersonDropTarget | null): Record<string, number> {
    const sourceMemberId = activeDraggedPersonId();
    if (!sourceMemberId || !target) return {};
    const currentIds = filteredPeople().map((member) => member.id);
    const desiredIds = currentIds.filter((memberId) => memberId !== sourceMemberId);
    const targetIndex = desiredIds.indexOf(target.memberId);
    if (targetIndex < 0) return {};
    desiredIds.splice(targetIndex + (target.placement === "after" ? 1 : 0), 0, sourceMemberId);
    const desiredIndexById = new Map(desiredIds.map((memberId, index) => [memberId, index]));
    const offsets: Record<string, number> = {};
    for (const memberId of currentIds) {
      if (memberId === sourceMemberId) continue;
      const desiredIndex = desiredIndexById.get(memberId);
      const currentSlot = personDragSlots.get(memberId);
      const destinationMemberId = desiredIndex === undefined ? undefined : currentIds[desiredIndex];
      const destinationSlot = destinationMemberId ? personDragSlots.get(destinationMemberId) : undefined;
      if (desiredIndex !== undefined && currentSlot && destinationSlot) {
        offsets[memberId] = destinationSlot.top - currentSlot.top;
      }
    }
    return offsets;
  }

  function applyPersonDragOffsets(offsets: Record<string, number>): void {
    const changedMemberIds = new Set([...Object.keys(renderedPersonDragOffsets), ...Object.keys(offsets)]);
    for (const memberId of changedMemberIds) {
      const element = personDragSlots.get(memberId)?.element;
      if (!element) continue;
      const offset = offsets[memberId] ?? 0;
      element.style.setProperty("--sidebar-person-drag-y", `${offset}px`);
      element.classList.toggle("sidebar-person-item-shifting", offset !== 0);
    }
    renderedPersonDragOffsets = offsets;
  }

  function setPersonTarget(target: PersonDropTarget | null): void {
    if (
      currentPersonDropTarget?.memberId === target?.memberId &&
      currentPersonDropTarget?.placement === target?.placement
    ) {
      return;
    }
    currentPersonDropTarget = target;
    applyPersonDragOffsets(computePersonDragOffsets(target));
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

  function computeSectionDragOffsets(target: SectionDropTarget | null): Record<string, number> {
    const sourceSectionId = activeDraggedSectionId();
    if (!sourceSectionId || !target) return {};
    const currentOrder = visibleSectionIds();
    const desiredOrder = currentOrder.filter((candidate) => candidate !== sourceSectionId);
    const targetIndex = desiredOrder.indexOf(target.sectionId);
    if (targetIndex < 0) return {};
    desiredOrder.splice(targetIndex + (target.placement === "after" ? 1 : 0), 0, sourceSectionId);
    const desiredIndexById = new Map(desiredOrder.map((sectionId, index) => [sectionId, index]));
    const offsets: Record<string, number> = {};
    for (const sectionId of currentOrder) {
      if (sectionId === sourceSectionId) continue;
      const desiredIndex = desiredIndexById.get(sectionId);
      const currentSlot = sectionDragSlots.get(sectionId);
      const destinationSectionId = desiredIndex === undefined ? undefined : currentOrder[desiredIndex];
      const destinationSlot = destinationSectionId ? sectionDragSlots.get(destinationSectionId) : undefined;
      if (desiredIndex !== undefined && currentSlot && destinationSlot) {
        offsets[sectionId] = destinationSlot.top - currentSlot.top;
      }
    }
    return offsets;
  }

  function setSectionTarget(target: SectionDropTarget | null): void {
    const currentTarget = currentSectionDropTarget;
    if (currentTarget?.sectionId === target?.sectionId && currentTarget?.placement === target?.placement) return;
    currentSectionDropTarget = target;
    setSectionDropTarget(target);
    setSectionDragOffsets(computeSectionDragOffsets(target));
  }

  function targetAgentAt(sourceAgentId: string, agentId: string, clientY: number): AgentDropTarget | null {
    if (sourceAgentId === agentId) return null;
    const sourceSlot = agentDragSlots.get(sourceAgentId);
    const slot = agentDragSlots.get(agentId);
    if (!slot) return null;
    const scrollDelta = (botList?.scrollTop ?? 0) - agentDragStartScrollTop;
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

  function moveDraggedAgent(agentId: string, target: AgentDropTarget): void {
    const sectionBots = filteredBotsBySection().get(target.sectionId) ?? [];
    const idsWithoutSource = sectionBots.map((bot) => bot.id).filter((candidate) => candidate !== agentId);
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
        () =>
          setReorderAnnouncement(
            `Moved ${botById().get(agentId)?.name ?? "agent"} in ${sectionLabel(target.sectionId)}.`,
          ),
        (error) => setReorderAnnouncement(error instanceof Error ? error.message : String(error)),
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
    void props.onMutateLayout({ type: "move", sectionId: sourceSectionId, direction, steps }).then(
      () =>
        setReorderAnnouncement(
          `Moved ${sectionLabel(sourceSectionId)} to position ${visibleInsertionIndex + 1} of ${visibleOrder.length + 1}.`,
        ),
      (error) => setReorderAnnouncement(error instanceof Error ? error.message : String(error)),
    );
  }

  function draggedSidebarItem(): SidebarPinnedItem | null {
    if (draggedPinnedKey()) return null;
    const agentId = draggedAgentId();
    return agentId ? { kind: "agent", id: agentId } : null;
  }

  function pinDraggedSidebarItem(): boolean {
    const item = draggedSidebarItem();
    if (!item || !canPinDraggedSidebarItem()) return false;
    props.onPin(item);
    const name = botById().get(item.id)?.name ?? "agent";
    setReorderAnnouncement(`Pinned ${name}.`);
    return true;
  }

  function pointInRect(point: SidebarDragPoint, rect: DOMRect | null, scrollDelta = 0): boolean {
    if (!rect) return false;
    return (
      point.clientX >= rect.left &&
      point.clientX <= rect.right &&
      point.clientY >= rect.top - scrollDelta &&
      point.clientY <= rect.bottom - scrollDelta
    );
  }

  function closestVerticalSlot<T extends { bottom: number; centerY: number; top: number }>(
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

  function sectionAtPoint(point: SidebarDragPoint): SectionDragSlot | null {
    const scrollDelta = (botList?.scrollTop ?? 0) - sectionDragStartScrollTop;
    return closestVerticalSlot(sectionDragSlots.values(), point.clientY, scrollDelta);
  }

  function agentAtPoint(point: SidebarDragPoint, sectionId: string): AgentDragSlot | null {
    const scrollDelta = (botList?.scrollTop ?? 0) - agentDragStartScrollTop;
    return closestVerticalSlot(
      agentDragSlots.values(),
      point.clientY,
      scrollDelta,
      (slot) => slot.sectionId === sectionId,
    );
  }

  function personAtPoint(point: SidebarDragPoint): PersonDragSlot | null {
    const scrollDelta = (botList?.scrollTop ?? 0) - (dragSession?.startScrollTop ?? 0);
    return closestVerticalSlot(personDragSlots.values(), point.clientY, scrollDelta);
  }

  function pinnedTargetAtPoint(point: SidebarDragPoint): SidebarDropTarget | null {
    const scrollDelta = (botList?.scrollTop ?? 0) - (dragSession?.startScrollTop ?? 0);
    if (!pointInRect(point, dragGeometry.pinned, scrollDelta)) return null;
    const source = dragSession?.source;
    if (!source) return null;
    if (!("origin" in source) || source.origin !== "pinned") {
      return canPinDraggedSidebarItem() ? { kind: "pinned", key: null } : null;
    }
    if (pinnedDragSlots.length === 0) return { kind: "pinned", key: null };
    const target = pinnedDragSlots.reduce((closest, slot) =>
      Math.hypot(slot.centerX - point.clientX, slot.centerY - scrollDelta - point.clientY) <
      Math.hypot(closest.centerX - point.clientX, closest.centerY - scrollDelta - point.clientY)
        ? slot
        : closest,
    );
    return { kind: "pinned", key: target.key };
  }

  function resolveSidebarDropTarget(point: SidebarDragPoint): SidebarDropTarget | null {
    const session = dragSession;
    if (!session || !pointInRect(point, dragGeometry.list)) return null;
    const pinnedTarget = pinnedTargetAtPoint(point);
    if (pinnedTarget) return pinnedTarget;
    const section = sectionAtPoint(point);
    if (!section) return null;

    if (session.source.kind === "section") {
      if (section.sectionId === session.source.id) return null;
      const scrollDelta = (botList?.scrollTop ?? 0) - sectionDragStartScrollTop;
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
      const person = personAtPoint(point);
      if (!person || person.memberId === session.source.id) return { kind: "section", sectionId: section.sectionId };
      const sourceSlot = personDragSlots.get(session.source.id);
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

    if (!sectionAcceptsAgent(section.sectionId)) return null;
    const agent = agentAtPoint(point, section.sectionId);
    if (agent && agent.agentId !== session.source.id) {
      const target = targetAgentAt(session.source.id, agent.agentId, point.clientY);
      if (target) return { kind: "agent", target };
    }
    return { kind: "section", sectionId: section.sectionId };
  }

  function applySidebarDropTarget(target: SidebarDropTarget | null): void {
    if (sidebarDropTargetsEqual(dragTarget, target)) return;
    dragTarget = target;
    const source = dragSession?.source;
    const pinningFromSidebar = Boolean(source && "origin" in source && source.origin !== "pinned");
    setPinnedDropActive(target?.kind === "pinned" && pinningFromSidebar && canPinDraggedSidebarItem());
    setDragOverPinnedKey(target?.kind === "pinned" ? target.key : null);
    if (target?.kind === "agent") setAgentTarget(target.target, target.target.sectionId);
    else if (target?.kind === "section" && dragSession?.source.kind === "agent") {
      setAgentTarget(null, target.sectionId);
    } else setAgentTarget(null, null);
    if (target?.kind === "person") setPersonTarget(target.target);
    else setPersonTarget(null);
    if (target?.kind === "section-order") setSectionTarget(target.target);
    else setSectionTarget(null);
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
    if (!botList || !dragSession || !dragPoint || dragScrollSpeed === 0) return;
    const previousScrollTop = botList.scrollTop;
    botList.scrollTop += dragScrollSpeed;
    if (botList.scrollTop === previousScrollTop) {
      dragScrollSpeed = 0;
      return;
    }
    applySidebarDropTarget(resolveSidebarDropTarget(dragPoint));
    updateScrollFade();
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
        void props.onMutateLayout(appendAgentAction(source.id, target.sectionId)).then(
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
      !emptyPinnedDropVisible() &&
      agentPinnedItems().length === 0 &&
      dragSession.source.kind === "agent" &&
      dragSession.source.origin === "section"
    ) {
      const activeSession = dragSession;
      setEmptyPinnedDropVisible(true);
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
    const animatedPinnedTarget = emptyPinnedDropVisible() && dragTarget?.kind === "pinned" ? dragTarget : null;
    if (emptyPinnedDropVisible() && !animatedPinnedTarget) measureSidebarDragTargets();
    const target = animatedPinnedTarget ?? flushSidebarDragTarget({ clientX: event.clientX, clientY: event.clientY });
    commitSidebarDrop(target);
    suppressSidebarClickUntil = Date.now() + 250;
    stopSidebarDragging();
  }

  function endAgentDragging(event: DragEvent): void {
    const canCommitAnimatedPin =
      emptyPinnedDropVisible() &&
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

  function sectionDragOffset(sectionId: string): number {
    return sectionDragOffsets()[sectionId] ?? 0;
  }

  function sectionDragClasses(sectionId: string) {
    const target = sectionDropTarget();
    return {
      "sidebar-section-agent-drop-target": agentDropSectionId() === sectionId && sectionAcceptsAgent(sectionId),
      "sidebar-section-dragging": draggedSectionId() === sectionId,
      "sidebar-section-shifting": sectionDragOffset(sectionId) !== 0,
      "sidebar-section-drop-before":
        draggedSectionId() !== null && target?.sectionId === sectionId && target.placement === "before",
      "sidebar-section-drop-after":
        draggedSectionId() !== null && target?.sectionId === sectionId && target.placement === "after",
    };
  }

  function expandToSearch(): void {
    props.onExpand();
    queueMicrotask(() => searchInput?.focus());
  }

  function visiblePinnedKeys(): string[] {
    return resolvedPinnedItems().map((item) => sidebarPinnedItemKey(item.ref));
  }

  function pinnedDragOffset(key: string): { x: number; y: number } {
    const sourceKey = draggedPinnedKey();
    const targetKey = dragOverPinnedKey();
    if (!sourceKey || !targetKey || sourceKey === targetKey || key === sourceKey) return { x: 0, y: 0 };
    const keys = visiblePinnedKeys();
    const sourceIndex = keys.indexOf(sourceKey);
    const targetIndex = keys.indexOf(targetKey);
    const index = keys.indexOf(key);
    if (sourceIndex < 0 || targetIndex < 0 || index < 0) return { x: 0, y: 0 };
    const destinationIndex =
      sourceIndex < targetIndex && index > sourceIndex && index <= targetIndex
        ? index - 1
        : sourceIndex > targetIndex && index >= targetIndex && index < sourceIndex
          ? index + 1
          : index;
    const sourceSlot = pinnedDragSlots[index];
    const destinationSlot = pinnedDragSlots[destinationIndex];
    if (!sourceSlot || !destinationSlot) return { x: 0, y: 0 };
    return { x: destinationSlot.left - sourceSlot.left, y: destinationSlot.top - sourceSlot.top };
  }

  function agentDragOffset(agentId: string): { x: number; y: number } {
    const sourceAgentId = draggedAgentId();
    const targetAgentId = dragOverAgentId();
    if (!sourceAgentId || !targetAgentId) return { x: 0, y: 0 };
    const sourceSlot = sourceAgentId ? agentDragSlots.get(sourceAgentId) : undefined;
    const targetSlot = targetAgentId ? agentDragSlots.get(targetAgentId) : undefined;
    if (!sourceSlot || !targetSlot || sourceSlot.sectionId !== targetSlot.sectionId) return { x: 0, y: 0 };
    const keys = (filteredBotsBySection().get(sourceSlot.sectionId) ?? []).map((bot) => bot.id);
    if (sourceAgentId === targetAgentId || agentId === sourceAgentId) return { x: 0, y: 0 };
    const sourceIndex = keys.indexOf(sourceAgentId);
    const targetIndex = keys.indexOf(targetAgentId);
    const index = keys.indexOf(agentId);
    if (sourceIndex < 0 || targetIndex < 0 || index < 0) return { x: 0, y: 0 };
    const destinationIndex =
      sourceIndex < targetIndex && index > sourceIndex && index <= targetIndex
        ? index - 1
        : sourceIndex > targetIndex && index >= targetIndex && index < sourceIndex
          ? index + 1
          : index;
    const currentSlot = agentDragSlots.get(keys[index] ?? "");
    const destinationSlot = agentDragSlots.get(keys[destinationIndex] ?? "");
    if (!currentSlot || !destinationSlot) return { x: 0, y: 0 };
    return { x: 0, y: destinationSlot.top - currentSlot.top };
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

  function agentActions(bot: BotProfile, pinned: boolean) {
    const ref: SidebarPinnedItem = { kind: "agent", id: bot.id };
    const pinLimitReached = !pinned && agentPinnedItems().length >= MAX_SIDEBAR_PINNED_ITEMS;
    const assignedSectionId = () =>
      customSectionById().has(props.layout.agentAssignments[bot.id] ?? "")
        ? props.layout.agentAssignments[bot.id]
        : null;
    const assign = (sectionId: string | null) => {
      void props.onMutateLayout({ type: "assign", agentId: bot.id, sectionId }).catch((error) => {
        setReorderAnnouncement(error instanceof Error ? error.message : String(error));
      });
    };
    return (
      <ContextMenu.Portal>
        <ContextMenu.Content class="bot-context-menu" aria-label="Agent actions">
          <ContextMenu.Item
            disabled={pinLimitReached}
            title={pinLimitReached ? `Maximum ${MAX_SIDEBAR_PINNED_ITEMS} pinned chats` : undefined}
            onSelect={() => (pinned ? props.onUnpin(ref) : props.onPin(ref))}
          >
            <Show when={pinned} fallback={<Pin class="bot-context-icon size-4" aria-hidden="true" />}>
              <PinOff class="bot-context-icon size-4" aria-hidden="true" />
            </Show>
            <span>{pinned ? "Unpin" : "Pin"}</span>
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger>
              <FolderInput class="bot-context-icon size-4" aria-hidden="true" />
              <span>Move to</span>
              <ChevronRight class="bot-context-submenu-chevron size-4" aria-hidden="true" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent class="ui-action-menu bot-context-menu bot-context-submenu" aria-label="Move to">
                <For each={props.layout.sections}>
                  {(section) => (
                    <ContextMenu.Item onSelect={() => assign(section.id)}>
                      <Show
                        when={assignedSectionId() === section.id}
                        fallback={<Folder class="bot-context-icon size-4" aria-hidden="true" />}
                      >
                        <Check class="bot-context-icon size-4" aria-hidden="true" />
                      </Show>
                      <span>{section.name}</span>
                    </ContextMenu.Item>
                  )}
                </For>
                <ContextMenu.Item onSelect={() => assign(null)}>
                  <Show
                    when={assignedSectionId() === null}
                    fallback={<Folder class="bot-context-icon size-4" aria-hidden="true" />}
                  >
                    <Check class="bot-context-icon size-4" aria-hidden="true" />
                  </Show>
                  <span>Unassigned</span>
                </ContextMenu.Item>
                <ContextMenu.Separator />
                <ContextMenu.Item onSelect={() => startCreateSection(bot.id)}>
                  <FolderPlus class="bot-context-icon size-4" aria-hidden="true" />
                  <span>New section</span>
                </ContextMenu.Item>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item
            onSelect={() => {
              setDeleteError(null);
              props.onEditBot(bot.id);
            }}
          >
            <EditIcon />
            <span>Edit agent</span>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item
            class="ui-action-menu-danger bot-context-danger"
            onSelect={() => {
              setDeleteError(null);
              setDeleteTargetId(bot.id);
            }}
          >
            <DeleteIcon />
            <span>Delete agent</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    );
  }

  function sectionActions(sectionId: string) {
    const custom = () => customSectionById().has(sectionId);
    const position = () => sectionPosition(sectionId);
    return (
      <ContextMenu.Portal>
        <ContextMenu.Content class="bot-context-menu" aria-label="Section actions">
          <Show when={custom()}>
            <ContextMenu.Item onSelect={() => startRenameSection(sectionId)}>
              <Pencil class="bot-context-icon size-4" aria-hidden="true" />
              <span>Rename</span>
            </ContextMenu.Item>
          </Show>
          <ContextMenu.Item disabled={position() <= 0} onSelect={() => moveSection(sectionId, "up")}>
            <ArrowUp class="bot-context-icon size-4" aria-hidden="true" />
            <span>Move up</span>
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={position() < 0 || position() >= visibleSectionIds().length - 1}
            onSelect={() => moveSection(sectionId, "down")}
          >
            <ArrowDown class="bot-context-icon size-4" aria-hidden="true" />
            <span>Move down</span>
          </ContextMenu.Item>
          <Show when={custom()}>
            <ContextMenu.Separator />
            <ContextMenu.Item
              class="ui-action-menu-danger bot-context-danger"
              onSelect={() => {
                setSectionDeleteError(null);
                setSectionDeleteTargetId(sectionId);
              }}
            >
              <Trash2 class="bot-context-icon bot-context-danger-icon size-4" aria-hidden="true" />
              <span>Delete</span>
            </ContextMenu.Item>
          </Show>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    );
  }

  function sectionEditorHeader() {
    return (
      <header class="sidebar-section-editor-wrap">
        <Input
          ref={(element) => (sectionNameInput = element)}
          class="sidebar-section-editor"
          value={sectionName()}
          onValueChange={(value) => {
            setSectionName(value);
            if (sectionNameError()) setSectionNameError(null);
          }}
          maxlength={INPUT_LIMITS.sidebarSectionName}
          aria-label={sectionEditor()?.kind === "rename" ? "Rename section" : "New section name"}
          aria-invalid={sectionNameError() ? "true" : undefined}
          title={sectionNameError() ?? undefined}
          disabled={savingSection()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveSectionEditor();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelSectionEditor();
            }
          }}
          onBlur={() => void saveSectionEditor()}
        />
        <ChevronDown class="sidebar-section-editor-chevron size-4" aria-hidden="true" />
        <Show when={sectionNameError()}>
          {(message) => (
            <span class="sr-only" role="alert">
              {message()}
            </span>
          )}
        </Show>
      </header>
    );
  }

  function sectionHeader(sectionId: string, name: string) {
    const editing = () => {
      const editor = sectionEditor();
      return editor?.kind === "rename" && editor.sectionId === sectionId;
    };
    const collapsed = () => sectionIsCollapsed(sectionId);
    return (
      <Show when={!editing()} fallback={sectionEditorHeader()}>
        <header>
          <ContextMenu.Root modal={false}>
            <ContextMenu.Trigger
              as="button"
              type="button"
              class={buttonVariants({
                variant: "ghost",
                class: "sidebar-section-toggle sidebar-section-drag-handle",
              })}
              draggable={props.compact ? "false" : "true"}
              aria-expanded={collapsed() ? "false" : "true"}
              aria-controls={`sidebar-section-body-${sectionId}`}
              onClick={(event: MouseEvent) => {
                if (!sidebarClickIsSuppressed(event)) props.onToggleSection(sectionId);
              }}
              onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) =>
                startSectionDragging(event, sectionId)
              }
              onDragEnd={stopSidebarDragging}
            >
              <span class="sidebar-section-name" title={name}>
                {name}
              </span>
              <ChevronDown
                class={`sidebar-section-chevron size-4${collapsed() ? " sidebar-section-chevron-collapsed" : ""}`}
                aria-hidden="true"
              />
            </ContextMenu.Trigger>
            {sectionActions(sectionId)}
          </ContextMenu.Root>
        </header>
      </Show>
    );
  }

  function agentRow(bot: BotProfile) {
    const title = () => bot.title.trim();
    const working = () => props.agentStates[bot.id]?.kind === "working";
    const dragOffset = createMemo(() => agentDragOffset(bot.id));
    return (
      /* biome-ignore lint/a11y/noStaticElementInteractions: Native drag belongs to the wrapper around the accessible button. */
      <div
        class={[
          "sidebar-agent-item",
          {
            "sidebar-agent-item-dragging": draggedAgentId() === bot.id,
            "sidebar-agent-item-shifting": dragOffset().y !== 0,
          },
        ]}
        style={`--sidebar-agent-drag-y: ${dragOffset().y}px;`}
        data-agent-id={bot.id}
        draggable={props.compact ? "false" : "true"}
        onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) => startAgentDragging(event, bot)}
        onDragEnd={endAgentDragging}
      >
        <ContextMenu.Root modal={false}>
          <ContextMenu.Trigger
            as="button"
            type="button"
            class={[
              buttonVariants({ variant: "ghost" }),
              "bot-row agent-row",
              {
                "bot-row-active": props.activeBotId === bot.id,
                "sidebar-agent-row-dragging": draggedAgentId() === bot.id,
              },
            ]}
            aria-label={`${bot.name}${title() ? `, ${title()}` : ""}. ${bot.preview}`}
            aria-pressed={props.activeBotId === bot.id ? "true" : "false"}
            onClick={(event: MouseEvent) => {
              if (!sidebarClickIsSuppressed(event)) props.onSelectBot(bot.id);
            }}
          >
            <span class="bot-row-avatar">
              <AgentAvatar bot={bot} motion={working() ? "working" : "idle"} />
              <Show when={props.agentStates[bot.id]}>{(state) => <SidebarAgentIndicator state={state()} />}</Show>
            </span>
            <span class="bot-row-copy">
              <span class="bot-row-heading">
                <span class="bot-row-title">
                  <strong>{bot.name}</strong>
                  <Show when={title()}>
                    {(label) => (
                      <Badge class="bot-role-badge" size="sm" title={label()}>
                        {label()}
                      </Badge>
                    )}
                  </Show>
                </span>
                <span class="bot-row-time">{bot.time}</span>
              </span>
              <span class="bot-row-preview">{bot.preview}</span>
            </span>
            <Show when={props.agentStates[bot.id]}>
              {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
            </Show>
          </ContextMenu.Trigger>
          {agentActions(bot, false)}
        </ContextMenu.Root>
      </div>
    );
  }

  return (
    <aside
      id="bot-sidebar"
      aria-label="Bot navigation"
      class={["sidebar panel-edge", { "sidebar-compact": props.compact }]}
    >
      <div class="window-drag sidebar-topbar">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class="sidebar-server-name no-drag"
          aria-label={`Open settings for ${props.serverName}`}
          aria-hidden={props.compact ? "true" : undefined}
          tabindex={props.compact ? -1 : 0}
          title={props.serverName}
          onClick={(event) => props.onOpenServerSettings(event.currentTarget)}
        >
          <span class="sidebar-server-name-label">{props.serverName}</span>
        </Button>
        <div class="sidebar-topbar-actions">
          <Button
            variant="ghost"
            type="button"
            class="sidebar-icon-button sidebar-toggle-button no-drag"
            onClick={() => (props.compact ? props.onExpand() : props.onCollapse())}
            aria-label={props.compact ? "Expand sidebar" : "Collapse sidebar"}
            aria-controls="bot-sidebar"
            aria-expanded={props.compact ? "false" : "true"}
            title={props.compact ? "Expand sidebar" : "Collapse sidebar"}
          >
            <SidebarToggleIcon />
          </Button>
          <Button
            variant="ghost"
            type="button"
            class="sidebar-icon-button sidebar-new-button no-drag"
            onClick={props.onCreateBot}
            aria-label="Create new Bot"
            aria-hidden={props.compact ? "true" : undefined}
            tabindex={props.compact ? -1 : 0}
          >
            <PlusIcon />
          </Button>
        </div>
      </div>

      <div class="sidebar-search-wrap">
        <label class="search-field" aria-hidden={props.compact ? "true" : undefined}>
          <span class="sr-only">Search chats</span>
          <SearchIcon />
          <Input
            ref={(element) => (searchInput = element)}
            type="search"
            value={query()}
            onValueChange={setQuery}
            placeholder="Search"
            aria-label="Search chats"
            tabindex={props.compact ? -1 : 0}
            maxlength={INPUT_LIMITS.agentName}
          />
        </label>
        <Button
          variant="ghost"
          type="button"
          class="sidebar-compact-search"
          aria-label="Expand sidebar and search chats"
          aria-hidden={props.compact ? undefined : "true"}
          tabindex={props.compact ? 0 : -1}
          onClick={expandToSearch}
        >
          <SearchIcon />
        </Button>
      </div>

      <nav
        ref={(element) => (botList = element)}
        aria-label="Chat list"
        class={[
          "bot-list",
          {
            "scroll-fade-top": fadeAtTop(),
            "scroll-fade-bottom": fadeAtBottom(),
          },
        ]}
        data-sidebar-dragging={
          draggedPinnedKey()
            ? "pinned"
            : draggedAgentId()
              ? "agent"
              : draggedPersonId()
                ? "person"
                : draggedSectionId()
                  ? "section"
                  : undefined
        }
        onDragOver={updateSidebarNativeDrag}
        onDragLeave={(event) => {
          const point = { clientX: event.clientX, clientY: event.clientY };
          if (pointInRect(point, dragGeometry.list)) return;
          scheduleSidebarDragTarget(point);
        }}
        onDrop={dropSidebarNativeDrag}
        onScroll={() => updateScrollFade()}
      >
        <div class="bot-list-content">
          <Show
            when={
              resolvedPinnedItems().length > 0 ||
              filteredBots().length > 0 ||
              filteredPeople().length > 0 ||
              sectionEditor()?.kind === "create"
            }
            fallback={
              <Show
                when={!query().trim() && props.emptyAction}
                fallback={
                  <p class="empty-search">
                    {query().trim() ? "No matches" : props.bots.length ? "No matches" : "No agents yet"}
                  </p>
                }
              >
                {(action) => (
                  <div class="sidebar-first-bot-state">
                    <Button
                      variant="ghost"
                      type="button"
                      class="bot-row bot-row-active sidebar-first-bot-action"
                      aria-label={action().label}
                      aria-pressed="true"
                      data-avatar-seed={action().avatarSeed}
                      data-avatar-hue={action().avatarHue ?? "automatic"}
                      onClick={action().onSelect}
                    >
                      <span class="bot-row-avatar">
                        <AgentAvatar seed={action().avatarSeed} hue={action().avatarHue} motion="idle" />
                      </span>
                      <span class="bot-row-copy">
                        <span class="bot-row-heading">
                          <span class="bot-row-title">
                            <strong>{action().label}</strong>
                          </span>
                        </span>
                      </span>
                    </Button>
                    <p class="sidebar-first-bot-empty">No chats yet</p>
                  </div>
                )}
              </Show>
            }
          >
            <Show when={resolvedPinnedItems().length > 0 || emptyPinnedDropVisible()}>
              <section
                class={[
                  "sidebar-chat-group sidebar-pinned-group",
                  {
                    "sidebar-pinned-group-agent-drop-target": pinnedDropActive(),
                    "sidebar-pinned-group-empty-target": emptyPinnedDropVisible(),
                  },
                ]}
                aria-label="Pinned chats"
                onTransitionEnd={(event) => {
                  if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
                  if (!dragSession) return;
                  measureSidebarDragTargets();
                  if (dragPoint) scheduleSidebarDragTarget(dragPoint);
                }}
              >
                <ul class="sidebar-pinned-list" data-dragging={draggedPinnedKey() ? "" : undefined}>
                  <Show when={emptyPinnedDropVisible()}>
                    <li class="sidebar-pinned-empty-drop">Drag here to pin</li>
                  </Show>
                  <For each={resolvedPinnedItems()}>
                    {(item) => {
                      const key = () => sidebarPinnedItemKey(item.ref);
                      const dragOffset = createMemo(() => pinnedDragOffset(key()));
                      const name = () => item.bot.name;
                      const title = () => item.bot.title.trim();
                      return (
                        <li
                          class={[
                            "sidebar-pinned-item",
                            {
                              "sidebar-pinned-item-dragging": draggedPinnedKey() === key(),
                              "sidebar-pinned-item-drag-over": dragOverPinnedKey() === key(),
                            },
                          ]}
                          style={`--sidebar-pinned-drag-x: ${dragOffset().x}px; --sidebar-pinned-drag-y: ${dragOffset().y}px;`}
                          data-pinned-key={key()}
                          draggable="true"
                          onDragStart={(event) => {
                            startNativeItemDragging(event, {
                              className: "sidebar-pinned-drag-preview",
                              data: key(),
                              source: { kind: "agent", id: item.bot.id, key: key(), origin: "pinned" },
                            });
                            setPinnedDropActive(false);
                            setDraggedPinnedKey(key());
                            setDragOverPinnedKey(key());
                          }}
                          onDragEnd={stopSidebarDragging}
                          onKeyDown={(event) => {
                            if (!event.altKey) return;
                            if (event.key === "ArrowLeft") {
                              event.preventDefault();
                              movePinnedItem(key(), -1);
                            } else if (event.key === "ArrowRight") {
                              event.preventDefault();
                              movePinnedItem(key(), 1);
                            }
                          }}
                        >
                          <ContextMenu.Root modal={false}>
                            <ContextMenu.Trigger
                              as="button"
                              type="button"
                              class={[
                                buttonVariants({ variant: "ghost" }),
                                "bot-row sidebar-pinned-row",
                                "agent-row",
                                { "bot-row-active": props.activeBotId === item.bot.id },
                              ]}
                              aria-label={`${item.bot.name}, pinned agent`}
                              aria-pressed={props.activeBotId === item.bot.id ? "true" : "false"}
                              onClick={() => props.onSelectBot(item.bot.id)}
                            >
                              <SidebarPinnedAvatar item={item} agentState={() => props.agentStates[item.bot.id]} />
                              <span class="bot-row-copy sidebar-pinned-copy">
                                <strong class="sidebar-pinned-name" title={name()}>
                                  {name()}
                                </strong>
                                <Show when={title()}>
                                  {(label) => (
                                    <Badge class="sidebar-pinned-title" size="sm" title={label()}>
                                      <span>{label()}</span>
                                    </Badge>
                                  )}
                                </Show>
                              </span>
                              <Show when={props.agentStates[item.bot.id]}>
                                {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
                              </Show>
                            </ContextMenu.Trigger>
                            {agentActions(item.bot, true)}
                          </ContextMenu.Root>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </section>
            </Show>
            <For each={props.layout.order}>
              {(sectionId) => {
                if (sectionId === SIDEBAR_PEOPLE_SECTION_ID) {
                  return (
                    <Show when={filteredPeople().length > 0}>
                      <section
                        class={["sidebar-chat-group sidebar-section", sectionDragClasses(sectionId)]}
                        style={`--sidebar-section-drag-y: ${sectionDragOffset(sectionId)}px;`}
                        aria-label="People"
                        data-section-id={sectionId}
                        onFocusIn={() => props.onPreloadDirectConversation?.()}
                        onPointerEnter={() => props.onPreloadDirectConversation?.()}
                      >
                        {sectionHeader(sectionId, "People")}
                        <div
                          class="sidebar-section-collapse"
                          data-collapsed={sectionIsCollapsed(sectionId) ? "" : undefined}
                          aria-hidden={sectionIsCollapsed(sectionId) ? "true" : undefined}
                          inert={sectionIsCollapsed(sectionId) ? true : undefined}
                        >
                          <div id={`sidebar-section-body-${sectionId}`} class="sidebar-section-body">
                            <For each={filteredPeople()}>
                              {(member) => {
                                const thread = () => directThreadByMember().get(member.id);
                                return (
                                  /* biome-ignore lint/a11y/noStaticElementInteractions: Native drag belongs to the wrapper around the accessible button. */
                                  <div
                                    class="sidebar-person-item"
                                    style="--sidebar-person-drag-y: 0px;"
                                    data-person-id={member.id}
                                    draggable={props.compact ? "false" : "true"}
                                    onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) =>
                                      startPersonDragging(event, member)
                                    }
                                    onDragEnd={stopSidebarDragging}
                                  >
                                    <Button
                                      variant="ghost"
                                      type="button"
                                      class={[
                                        "bot-row person-row",
                                        { "bot-row-active": props.activeDirectMemberId === member.id },
                                      ]}
                                      aria-label={`${teamMemberName(member)}. ${thread()?.lastMessage.text ?? (member.online ? "Online now" : "Offline")}`}
                                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                                      aria-pressed={props.activeDirectMemberId === member.id ? "true" : "false"}
                                      onClick={(event: MouseEvent) => {
                                        if (sidebarClickIsSuppressed(event)) return;
                                        props.onPreloadDirectConversation?.();
                                        props.onSelectPerson(member.id);
                                      }}
                                      onKeyDown={(event: KeyboardEvent) => {
                                        if (!event.altKey) return;
                                        if (event.key === "ArrowUp") {
                                          event.preventDefault();
                                          movePersonByKeyboard(member.id, -1);
                                        } else if (event.key === "ArrowDown") {
                                          event.preventDefault();
                                          movePersonByKeyboard(member.id, 1);
                                        }
                                      }}
                                    >
                                      <span class="bot-row-avatar">
                                        <TeamPersonAvatar member={member} />
                                        <Show when={(thread()?.unreadCount ?? 0) > 0}>
                                          <Badge
                                            class="person-unread-badge"
                                            tone="accent"
                                            shape="pill"
                                            aria-hidden="true"
                                          >
                                            {Math.min(thread()?.unreadCount ?? 0, 99)}
                                          </Badge>
                                        </Show>
                                      </span>
                                      <span class="bot-row-copy">
                                        <span class="bot-row-heading">
                                          <strong>{teamMemberName(member)}</strong>
                                          <span>{thread() ? sidebarMessageTime(thread()?.updatedAt ?? "") : ""}</span>
                                        </span>
                                        <span class="bot-row-preview">
                                          {thread()?.lastMessage.text ?? (member.online ? "Online now" : "Offline")}
                                        </span>
                                      </span>
                                      <Show when={(thread()?.unreadCount ?? 0) > 0}>
                                        <span class="sr-only">{thread()?.unreadCount} unread direct messages</span>
                                      </Show>
                                    </Button>
                                  </div>
                                );
                              }}
                            </For>
                          </div>
                        </div>
                      </section>
                    </Show>
                  );
                }

                const bots = () => filteredBotsBySection().get(sectionId) ?? [];
                const name = () =>
                  sectionId === SIDEBAR_UNASSIGNED_SECTION_ID
                    ? "Unassigned"
                    : (customSectionById().get(sectionId)?.name ?? "");
                return (
                  <Show when={name() && bots().length > 0}>
                    <section
                      class={["sidebar-chat-group sidebar-section", sectionDragClasses(sectionId)]}
                      style={`--sidebar-section-drag-y: ${sectionDragOffset(sectionId)}px;`}
                      aria-label={name()}
                      data-section-id={sectionId}
                    >
                      {sectionHeader(sectionId, name())}
                      <div
                        class="sidebar-section-collapse"
                        data-collapsed={sectionIsCollapsed(sectionId) ? "" : undefined}
                        aria-hidden={sectionIsCollapsed(sectionId) ? "true" : undefined}
                        inert={sectionIsCollapsed(sectionId) ? true : undefined}
                      >
                        <div id={`sidebar-section-body-${sectionId}`} class="sidebar-section-body">
                          <For each={bots()}>{(bot) => agentRow(bot)}</For>
                        </div>
                      </div>
                    </section>
                  </Show>
                );
              }}
            </For>
            <Show when={sectionEditor()?.kind === "create"}>
              <section class="sidebar-chat-group sidebar-section sidebar-section-draft" aria-label="New section">
                {sectionEditorHeader()}
              </section>
            </Show>
          </Show>
          <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {reorderAnnouncement()}
          </span>
        </div>
        <ContextMenu.Root modal={false}>
          <ContextMenu.Trigger class="sidebar-list-context-trigger" aria-label="Sidebar free area" />
          <ContextMenu.Portal>
            <ContextMenu.Content class="bot-context-menu" aria-label="Sidebar actions">
              <ContextMenu.Item onSelect={() => startCreateSection()}>
                <FolderPlus class="bot-context-icon size-4" aria-hidden="true" />
                <span>New section</span>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      </nav>

      <AlertDialog.Root
        open={Boolean(deleteTarget())}
        onOpenChange={(open) => {
          if (!open && !deleting()) setDeleteTargetId(null);
        }}
      >
        <Show when={deleteTarget()}>
          {(bot) => (
            <AlertDialog.Portal>
              <AlertDialog.Overlay class="bot-delete-backdrop">
                <AlertDialog.Content class="bot-delete-dialog">
                  <AgentAvatar
                    bot={bot()}
                    style={{
                      width: "44px",
                      height: "44px",
                      "margin-bottom": "15px",
                    }}
                  />
                  <AlertDialog.Title>Delete {bot().name}?</AlertDialog.Title>
                  <AlertDialog.Description>
                    This removes the agent, its OpenBot queue, and managed files used only by that conversation. Its
                    workspace and CLI history stay on your Mac.
                  </AlertDialog.Description>
                  <Show when={deleteError()}>{(message) => <p class="bot-delete-error">{message()}</p>}</Show>
                  <div class="bot-delete-actions">
                    <Button
                      variant="outline"
                      type="button"
                      disabled={deleting()}
                      onClick={() => setDeleteTargetId(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      type="button"
                      class="bot-delete-confirm"
                      disabled={deleting()}
                      onClick={() => void confirmDelete()}
                    >
                      {deleting() ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </AlertDialog.Content>
              </AlertDialog.Overlay>
            </AlertDialog.Portal>
          )}
        </Show>
      </AlertDialog.Root>

      <AlertDialog.Root
        open={Boolean(sectionDeleteTarget())}
        onOpenChange={(open) => {
          if (!open && !deletingSection()) setSectionDeleteTargetId(null);
        }}
      >
        <Show when={sectionDeleteTarget()}>
          {(section) => (
            <AlertDialog.Portal>
              <AlertDialog.Overlay class="bot-delete-backdrop">
                <AlertDialog.Content class="bot-delete-dialog sidebar-section-delete-dialog">
                  <span class="sidebar-section-delete-icon" aria-hidden="true">
                    <Trash2 class="size-5" />
                  </span>
                  <AlertDialog.Title>Delete {section().name}?</AlertDialog.Title>
                  <AlertDialog.Description>
                    Agents in this section will move to Unassigned. No agents will be deleted.
                  </AlertDialog.Description>
                  <Show when={sectionDeleteError()}>{(message) => <p class="bot-delete-error">{message()}</p>}</Show>
                  <div class="bot-delete-actions">
                    <Button
                      variant="outline"
                      type="button"
                      disabled={deletingSection()}
                      onClick={() => setSectionDeleteTargetId(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      type="button"
                      class="bot-delete-confirm"
                      disabled={deletingSection()}
                      onClick={() => void confirmSectionDelete()}
                    >
                      {deletingSection() ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </AlertDialog.Content>
              </AlertDialog.Overlay>
            </AlertDialog.Portal>
          )}
        </Show>
      </AlertDialog.Root>
    </aside>
  );
}

function sidebarMessageTime(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function botMatchesQuery(bot: BotProfile, query: string): boolean {
  return !query || `${bot.name} ${bot.title} ${bot.description} ${bot.preview}`.toLowerCase().includes(query);
}

function personMatchesQuery(
  member: TeamPresenceMember,
  thread: DirectThreadSummary | undefined,
  query: string,
): boolean {
  return (
    !query ||
    `${teamMemberName(member)} ${member.email ?? member.username} ${thread?.lastMessage.text ?? ""}`
      .toLowerCase()
      .includes(query)
  );
}
