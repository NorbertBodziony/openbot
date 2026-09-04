import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AvatarHue, DirectThreadSummary, TeamPresenceMember } from "@openbot/contracts/ipc";
import {
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutAction,
  type SidebarLayoutSnapshot,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, createStore, For, onCleanup, Show } from "solid-js";
import type { AgentProfile } from "../data";
import { MAX_SIDEBAR_PINNED_ITEMS, type SidebarPinnedItem, sidebarPinnedItemKey } from "../sidebar-pins";
import { AgentAvatar } from "./AgentAvatar";
import { createBoundedDragPreview } from "./createBoundedDragPreview";
import { createScrollFades } from "./createScrollFades";
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
  Copy,
  Folder,
  FolderInput,
  FolderPlus,
  Input,
  Pencil,
  Pin,
  PinOff,
  Puzzle,
  Trash2,
} from "./ui";

interface SidebarProps {
  serverName: string;
  onOpenServerSettings: (trigger: HTMLElement) => void;
  agents: AgentProfile[];
  activeAgentId: string;
  showPeople?: boolean;
  people: TeamPresenceMember[];
  directThreads: DirectThreadSummary[];
  activeDirectMemberId: string | null;
  agentStates: Record<string, SidebarAgentState>;
  layout: SidebarLayoutSnapshot;
  layoutMutable?: boolean;
  collapsedSectionIds: string[];
  onMutateLayout: (action: SidebarLayoutAction) => Promise<void>;
  onToggleSection: (sectionId: string) => void;
  pinnedItems: SidebarPinnedItem[];
  peopleOrder: string[];
  onPin: (item: SidebarPinnedItem) => void;
  onUnpin: (item: SidebarPinnedItem) => void;
  onReorderPinned: (items: SidebarPinnedItem[]) => void;
  onReorderPeople: (memberIds: string[]) => void;
  onSelectAgent: (agentId: string) => void;
  onSelectPerson: (memberId: string) => void;
  onPreloadDirectConversation?: () => void;
  onCreateAgent: () => void;
  onEditAgent: (agentId: string) => void;
  duplicateSupported?: boolean;
  duplicatingAgentIds?: ReadonlySet<string>;
  onDuplicateAgent?: (agentId: string) => Promise<void>;
  onDeleteAgent: (agentId: string) => Promise<void>;
  compact: boolean;
  onExpand: () => void;
  onOpenMarketplace: () => void;
  emptyAction?: {
    label: string;
    avatarSeed: string;
    avatarHue: AvatarHue | null;
    onSelect: () => void;
  };
}

export type SidebarAgentState = { kind: "working" } | { kind: "responded" } | { kind: "unread"; count: number };

type ResolvedPinnedItem = { ref: SidebarPinnedItem; agent: AgentProfile };

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
interface SidebarDrag {
  /** The empty pinned row, held open so an agent dragged out of a section has somewhere to land. */
  emptyPinnedDropVisible: boolean;
  /** How far each section has shifted to make room for the section being dragged. */
  sectionOffsets: Record<string, number>;
  /** What is being dragged. Every dragged id below is one arm of this union. */
  source: SidebarDragSource | null;
  /** Where it would land. Every drop highlight below is one arm of this union. */
  target: SidebarDropTarget | null;
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
    <span class={`agent-row-agent-status agent-row-agent-status-${props.state.kind}`} aria-hidden="true">
      <Show when={props.state.kind === "working"}>
        <TypingDots class="agent-row-thinking-dots" />
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
    <span class="agent-row-avatar sidebar-pinned-avatar">
      {/* A resting agent holds its pose. `"idle"` morphed for as long as the sidebar was on
          screen, which is all day, and bought nothing: the shape is 24 px and nobody is
          looking at it while they work in the pane next to it. `"hover"` brings it back the
          moment a pointer arrives, and real work still animates on its own. */}
      <AgentAvatar agent={props.item.agent} motion={props.agentState()?.kind === "working" ? "working" : "hover"} />
      <Show when={props.agentState()}>{(state) => <SidebarAgentIndicator state={state()} />}</Show>
    </span>
  );
}

function createSidebarAgentDragCard(source: HTMLElement): HTMLElement {
  const card = document.createElement("div");
  card.className = "agent-row sidebar-pinned-row sidebar-agent-drag-card";

  const sourceAvatar = source.querySelector(".agent-row-avatar")?.cloneNode(true);
  if (sourceAvatar instanceof HTMLElement) {
    sourceAvatar.classList.add("sidebar-pinned-avatar");
    card.append(sourceAvatar);
  }

  const copy = document.createElement("span");
  copy.className = "agent-row-copy sidebar-pinned-copy";
  const name = document.createElement("strong");
  name.className = "sidebar-pinned-name";
  name.textContent =
    source
      .querySelector(".sidebar-pinned-name, .agent-row-title strong, .agent-row-heading > strong")
      ?.textContent?.trim() ?? "Chat";
  copy.append(name);

  const titleText = source.querySelector(".sidebar-pinned-title, .agent-role-badge")?.textContent?.trim();
  if (titleText) {
    const title = document.createElement("span");
    title.className = "z-badge z-badge-variant-secondary sidebar-pinned-title";
    title.dataset.slot = "badge";
    title.dataset.variant = "secondary";
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
    <svg aria-hidden="true" viewBox="0 0 20 20" class="agent-context-icon size-4 fill-none stroke-current">
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
      class="agent-context-icon agent-context-danger-icon size-4 fill-none stroke-current"
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
  const layoutMutable = () => props.layoutMutable !== false;
  const [query, setQuery] = createSignal("");
  const [pending, setPending] = createStore<SidebarPending>({ deletion: null, sectionEditor: null });
  // Both dialogs read these: only one confirmation exists, and each dialog only renders while it is
  // the one. That is also why a section delete no longer needs its own pair of flags.
  const deleting = () => pending.deletion?.deleting === true;
  const deleteError = () => pending.deletion?.error ?? null;
  const scrollFades = createScrollFades();
  const [drag, setDrag] = createStore<SidebarDrag>({
    emptyPinnedDropVisible: false,
    sectionOffsets: {},
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
  const dragOverAgentId = createMemo(() => {
    const target = drag.target;
    return target?.kind === "agent" ? target.target.agentId : null;
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
  const [reorderAnnouncement, setReorderAnnouncement] = createSignal("");
  let agentList: HTMLElement | undefined;
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
  const agentById = createMemo(() => new Map(props.agents.map((agent) => [agent.id, agent])));
  const personById = createMemo(() => new Map(props.people.map((member) => [member.id, member])));
  const resolvedPinnedItems = createMemo<ResolvedPinnedItem[]>(() => {
    const items: ResolvedPinnedItem[] = [];
    for (const ref of agentPinnedItems()) {
      if (ref.kind === "agent") {
        const agent = agentById().get(ref.id);
        if (agent && agentMatchesQuery(agent, normalizedQuery())) items.push({ ref, agent });
      }
    }
    return items;
  });
  const filteredAgents = createMemo(() => {
    const orderIndex = new Map(props.layout.agentOrder.map((agentId, index) => [agentId, index]));
    const naturalIndex = new Map(props.agents.map((agent, index) => [agent.id, index]));
    return props.agents
      .filter(
        (agent) =>
          !pinnedKeys().has(sidebarPinnedItemKey({ kind: "agent", id: agent.id })) &&
          agentMatchesQuery(agent, normalizedQuery()),
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
    return deletion?.kind === "agent" ? props.agents.find((agent) => agent.id === deletion.id) : undefined;
  });
  const customSectionById = createMemo(() => new Map(props.layout.sections.map((section) => [section.id, section])));
  const collapsedSectionIds = createMemo(() => new Set(props.collapsedSectionIds));
  const filteredAgentsBySection = createMemo(() => {
    const groups = new Map<string, AgentProfile[]>();
    for (const agent of filteredAgents()) {
      const assigned = props.layout.agentAssignments[agent.id];
      const sectionId = assigned && customSectionById().has(assigned) ? assigned : SIDEBAR_UNASSIGNED_SECTION_ID;
      groups.set(sectionId, [...(groups.get(sectionId) ?? []), agent]);
    }
    return groups;
  });
  const visibleSectionIds = createMemo(() =>
    props.layout.order.filter((sectionId) => {
      if (sectionId === SIDEBAR_PEOPLE_SECTION_ID) return props.showPeople !== false && filteredPeople().length > 0;
      if (customSectionById().has(sectionId)) {
        return !normalizedQuery() || (filteredAgentsBySection().get(sectionId)?.length ?? 0) > 0;
      }
      if (sectionId !== SIDEBAR_UNASSIGNED_SECTION_ID) return false;
      return (filteredAgentsBySection().get(sectionId)?.length ?? 0) > 0;
    }),
  );
  const sectionDeleteTarget = createMemo(() => {
    const deletion = pending.deletion;
    return deletion?.kind === "section"
      ? props.layout.sections.find((section) => section.id === deletion.id)
      : undefined;
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
      await props.onDeleteAgent(deletion.id);
      closeDelete();
    } catch (error) {
      failDelete(error);
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
    currentSectionDropTarget = null;
    currentPersonDropTarget = null;
    setDrag((state) => {
      state.emptyPinnedDropVisible = false;
      state.sectionOffsets = {};
      state.source = null;
      state.target = null;
    });
    applyPersonDragOffsets({});
    agentList?.querySelector(".sidebar-pinned-group")?.classList.remove("sidebar-pinned-group-agent-drop-target");
    for (const section of agentList?.querySelectorAll<HTMLElement>(".sidebar-section") ?? []) {
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
  }

  function sidebarClickIsSuppressed(event: MouseEvent): boolean {
    if (Date.now() >= suppressSidebarClickUntil) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function measureSidebarDragTargets(): void {
    sectionDragSlots = new Map();
    agentDragSlots = new Map();
    personDragSlots = new Map();
    pinnedDragSlots = [];
    const startScrollTop = agentList?.scrollTop ?? 0;
    sectionDragStartScrollTop = startScrollTop;
    agentDragStartScrollTop = startScrollTop;
    if (!agentList) return;
    const pinnedGroup = agentList.querySelector<HTMLElement>(".sidebar-pinned-group");
    const pinnedTarget = pinnedGroup?.querySelector<HTMLElement>(".sidebar-pinned-empty-drop") ?? pinnedGroup;
    dragGeometry = {
      list: agentList.getBoundingClientRect(),
      pinned: pinnedTarget?.getBoundingClientRect() ?? null,
    };
    for (const section of agentList.querySelectorAll<HTMLElement>("[data-section-id]")) {
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
    for (const row of agentList.querySelectorAll<HTMLElement>("[data-agent-id]")) {
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
    for (const row of agentList.querySelectorAll<HTMLElement>("[data-person-id]")) {
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
    for (const item of agentList.querySelectorAll<HTMLElement>("[data-pinned-key]")) {
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
    dragSession = { source: options.source, startScrollTop: agentList?.scrollTop ?? 0 };
    dragPoint = { clientX: event.clientX, clientY: event.clientY };
    dragTarget = null;
    setDrag((state) => {
      state.sectionOffsets = {};
      state.source = options.source;
      state.target = null;
    });
    measureSidebarDragTargets();
    if (!agentList) return;
    dragPreview.start({
      bounds: agentList,
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
    if (props.compact) return;
    startNativeItemDragging(event, {
      className: "sidebar-agent-drag-preview",
      createPreview: createSidebarAgentDragCard,
      data: `openbot-agent:${agent.id}`,
      previewSize: { height: 94, width: 72 },
      source: { kind: "agent", id: agent.id, origin: "section" },
    });
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
  }

  function computePersonDragOffsets(target: PersonDropTarget | null): Record<string, number> {
    // From the session rather than from `drag.source`: this runs in the same tick as the target
    // writes that drive it, and a store publishes a write only at the next flush.
    const source = dragSession?.source;
    const sourceMemberId = source?.kind === "person" ? source.id : null;
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
    const source = dragSession?.source;
    const sourceSectionId = source?.kind === "section" ? source.id : null;
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
    const offsets = computeSectionDragOffsets(target);
    setDrag((state) => {
      state.sectionOffsets = offsets;
    });
  }

  function targetAgentAt(sourceAgentId: string, agentId: string, clientY: number): AgentDropTarget | null {
    if (sourceAgentId === agentId) return null;
    const sourceSlot = agentDragSlots.get(sourceAgentId);
    const slot = agentDragSlots.get(agentId);
    if (!slot) return null;
    const scrollDelta = (agentList?.scrollTop ?? 0) - agentDragStartScrollTop;
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
        () =>
          setReorderAnnouncement(
            `Moved ${agentById().get(agentId)?.name ?? "agent"} in ${sectionLabel(target.sectionId)}.`,
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
    const agentId = draggedAgentId();
    return agentId ? { kind: "agent", id: agentId } : null;
  }

  function pinDraggedSidebarItem(): boolean {
    const item = draggedSidebarItem();
    if (!item || !canPinDraggedSidebarItem()) return false;
    props.onPin(item);
    const name = agentById().get(item.id)?.name ?? "agent";
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
    const scrollDelta = (agentList?.scrollTop ?? 0) - sectionDragStartScrollTop;
    return closestVerticalSlot(sectionDragSlots.values(), point.clientY, scrollDelta);
  }

  function agentAtPoint(point: SidebarDragPoint, sectionId: string): AgentDragSlot | null {
    const scrollDelta = (agentList?.scrollTop ?? 0) - agentDragStartScrollTop;
    return closestVerticalSlot(
      agentDragSlots.values(),
      point.clientY,
      scrollDelta,
      (slot) => slot.sectionId === sectionId,
    );
  }

  function personAtPoint(point: SidebarDragPoint): PersonDragSlot | null {
    const scrollDelta = (agentList?.scrollTop ?? 0) - (dragSession?.startScrollTop ?? 0);
    return closestVerticalSlot(personDragSlots.values(), point.clientY, scrollDelta);
  }

  function pinnedTargetAtPoint(point: SidebarDragPoint): SidebarDropTarget | null {
    const scrollDelta = (agentList?.scrollTop ?? 0) - (dragSession?.startScrollTop ?? 0);
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
      const scrollDelta = (agentList?.scrollTop ?? 0) - sectionDragStartScrollTop;
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
    setDrag((state) => {
      state.target = target;
    });
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
    if (!agentList || !dragSession || !dragPoint || dragScrollSpeed === 0) return;
    const previousScrollTop = agentList.scrollTop;
    agentList.scrollTop += dragScrollSpeed;
    if (agentList.scrollTop === previousScrollTop) {
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
      if (action) await props.onMutateLayout(action);
      props.onUnpin({ kind: "agent", id: source.id });
      setReorderAnnouncement(`Moved ${agentById().get(source.id)?.name ?? "agent"} to ${sectionLabel(sectionId)}.`);
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
              `Moved ${agentById().get(source.id)?.name ?? "agent"} to ${sectionLabel(target.sectionId)}.`,
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

  function sectionDragOffset(sectionId: string): number {
    return drag.sectionOffsets[sectionId] ?? 0;
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
    const keys = (filteredAgentsBySection().get(sourceSlot.sectionId) ?? []).map((agent) => agent.id);
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

  function agentActions(agent: AgentProfile, pinned: boolean) {
    const ref: SidebarPinnedItem = { kind: "agent", id: agent.id };
    const pinLimitReached = !pinned && agentPinnedItems().length >= MAX_SIDEBAR_PINNED_ITEMS;
    const assignedSectionId = () =>
      customSectionById().has(props.layout.agentAssignments[agent.id] ?? "")
        ? props.layout.agentAssignments[agent.id]
        : null;
    const assign = (sectionId: string | null) => {
      void props.onMutateLayout({ type: "assign", agentId: agent.id, sectionId }).catch((error) => {
        setReorderAnnouncement(error instanceof Error ? error.message : String(error));
      });
    };
    return (
      <ContextMenu.Portal>
        <ContextMenu.Content class="agent-context-menu" aria-label="Agent actions">
          <ContextMenu.Item
            disabled={pinLimitReached}
            title={pinLimitReached ? `Maximum ${MAX_SIDEBAR_PINNED_ITEMS} pinned chats` : undefined}
            onSelect={() => (pinned ? props.onUnpin(ref) : props.onPin(ref))}
          >
            <Show when={pinned} fallback={<Pin class="agent-context-icon size-4" aria-hidden="true" />}>
              <PinOff class="agent-context-icon size-4" aria-hidden="true" />
            </Show>
            <span>{pinned ? "Unpin" : "Pin"}</span>
          </ContextMenu.Item>
          <Show when={layoutMutable()}>
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger>
                <FolderInput class="agent-context-icon size-4" aria-hidden="true" />
                <span>Move to</span>
                <ChevronRight class="agent-context-submenu-chevron size-4" aria-hidden="true" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent
                  class="ui-action-menu agent-context-menu agent-context-submenu"
                  aria-label="Move to"
                >
                  <For each={props.layout.sections}>
                    {(section) => (
                      <ContextMenu.Item onSelect={() => assign(section.id)}>
                        <Show
                          when={assignedSectionId() === section.id}
                          fallback={<Folder class="agent-context-icon size-4" aria-hidden="true" />}
                        >
                          <Check class="agent-context-icon size-4" aria-hidden="true" />
                        </Show>
                        <span>{section.name}</span>
                      </ContextMenu.Item>
                    )}
                  </For>
                  <ContextMenu.Item onSelect={() => assign(null)}>
                    <Show
                      when={assignedSectionId() === null}
                      fallback={<Folder class="agent-context-icon size-4" aria-hidden="true" />}
                    >
                      <Check class="agent-context-icon size-4" aria-hidden="true" />
                    </Show>
                    <span>Unassigned</span>
                  </ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onSelect={() => startCreateSection(agent.id)}>
                    <FolderPlus class="agent-context-icon size-4" aria-hidden="true" />
                    <span>New section</span>
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          </Show>
          <ContextMenu.Item onSelect={() => props.onEditAgent(agent.id)}>
            <EditIcon />
            <span>Edit agent</span>
          </ContextMenu.Item>
          <Show when={props.duplicateSupported !== false && props.onDuplicateAgent}>
            <ContextMenu.Item
              disabled={props.duplicatingAgentIds?.has(agent.id)}
              onSelect={() => void props.onDuplicateAgent?.(agent.id).catch(() => undefined)}
            >
              <Copy class="agent-context-icon size-4" aria-hidden="true" />
              <span>{props.duplicatingAgentIds?.has(agent.id) ? "Duplicating…" : "Duplicate agent"}</span>
            </ContextMenu.Item>
          </Show>
          <ContextMenu.Separator />
          <ContextMenu.Item
            class="ui-action-menu-danger agent-context-danger"
            onSelect={() => openDelete("agent", agent.id)}
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
      <Show when={layoutMutable()}>
        <ContextMenu.Portal>
          <ContextMenu.Content class="agent-context-menu" aria-label="Section actions">
            <Show when={custom()}>
              <ContextMenu.Item onSelect={() => startRenameSection(sectionId)}>
                <Pencil class="agent-context-icon size-4" aria-hidden="true" />
                <span>Rename</span>
              </ContextMenu.Item>
            </Show>
            <ContextMenu.Item disabled={position() <= 0} onSelect={() => moveSection(sectionId, "up")}>
              <ArrowUp class="agent-context-icon size-4" aria-hidden="true" />
              <span>Move up</span>
            </ContextMenu.Item>
            <ContextMenu.Item
              disabled={position() < 0 || position() >= visibleSectionIds().length - 1}
              onSelect={() => moveSection(sectionId, "down")}
            >
              <ArrowDown class="agent-context-icon size-4" aria-hidden="true" />
              <span>Move down</span>
            </ContextMenu.Item>
            <Show when={custom()}>
              <ContextMenu.Separator />
              <ContextMenu.Item
                class="ui-action-menu-danger agent-context-danger"
                onSelect={() => openDelete("section", sectionId)}
              >
                <Trash2 class="agent-context-icon agent-context-danger-icon size-4" aria-hidden="true" />
                <span>Delete</span>
              </ContextMenu.Item>
            </Show>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </Show>
    );
  }

  function sectionEditorHeader() {
    const editor = () => pending.sectionEditor;
    return (
      <header class="sidebar-section-editor-wrap">
        <Input
          ref={(element) => (sectionNameInput = element)}
          class="sidebar-section-editor"
          value={editor()?.name ?? ""}
          onValueChange={(value) => {
            setPending((state) => {
              if (!state.sectionEditor) return;
              state.sectionEditor.name = value;
              state.sectionEditor.error = null;
            });
          }}
          maxlength={INPUT_LIMITS.sidebarSectionName}
          aria-label={editor()?.target.kind === "rename" ? "Rename section" : "New section name"}
          aria-invalid={editor()?.error ? "true" : undefined}
          title={editor()?.error ?? undefined}
          disabled={editor()?.saving === true}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveSectionEditor();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelSectionEditor();
            }
          }}
          onBlur={cancelSectionEditor}
        />
        <ChevronDown class="sidebar-section-editor-chevron size-4" aria-hidden="true" />
        <Show when={editor()?.error}>
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
      const target = pending.sectionEditor?.target;
      return target?.kind === "rename" && target.sectionId === sectionId;
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
              draggable={!layoutMutable() || props.compact ? "false" : "true"}
              title={!layoutMutable() ? "This host does not support sidebar layout changes." : undefined}
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

  function agentRow(agent: AgentProfile) {
    const title = () => agent.title.trim();
    const working = () => props.agentStates[agent.id]?.kind === "working";
    const dragOffset = createMemo(() => agentDragOffset(agent.id));
    return (
      /* biome-ignore lint/a11y/noStaticElementInteractions: Native drag belongs to the wrapper around the accessible button. */
      <div
        class={[
          "sidebar-agent-item",
          {
            "sidebar-agent-item-dragging": draggedAgentId() === agent.id,
            "sidebar-agent-item-shifting": dragOffset().y !== 0,
          },
        ]}
        style={`--sidebar-agent-drag-y: ${dragOffset().y}px;`}
        data-agent-id={agent.id}
        draggable={!layoutMutable() || props.compact ? "false" : "true"}
        onDragStart={(event: DragEvent & { currentTarget: HTMLElement }) => startAgentDragging(event, agent)}
        onDragEnd={endAgentDragging}
      >
        <ContextMenu.Root modal={false}>
          <ContextMenu.Trigger
            as="button"
            type="button"
            class={[
              buttonVariants({ variant: "ghost" }),
              "agent-row agent-row",
              {
                "agent-row-active": props.activeAgentId === agent.id,
                "sidebar-agent-row-dragging": draggedAgentId() === agent.id,
              },
            ]}
            aria-label={`${agent.name}${title() ? `, ${title()}` : ""}. ${agent.preview}`}
            aria-pressed={props.activeAgentId === agent.id ? "true" : "false"}
            onClick={(event: MouseEvent) => {
              if (!sidebarClickIsSuppressed(event)) props.onSelectAgent(agent.id);
            }}
          >
            <span class="agent-row-avatar">
              <AgentAvatar agent={agent} motion={working() ? "working" : "hover"} />
              <Show when={props.agentStates[agent.id]}>{(state) => <SidebarAgentIndicator state={state()} />}</Show>
            </span>
            <span class="agent-row-copy">
              <span class="agent-row-heading">
                <span class="agent-row-title">
                  <strong>{agent.name}</strong>
                  <Show when={title()}>
                    {(label) => (
                      <Badge class="agent-role-badge" size="sm" title={label()}>
                        <span>{label()}</span>
                      </Badge>
                    )}
                  </Show>
                </span>
                <span class="agent-row-time">{agent.time}</span>
              </span>
              <span class="agent-row-preview">{agent.preview}</span>
            </span>
            <Show when={props.agentStates[agent.id]}>
              {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
            </Show>
          </ContextMenu.Trigger>
          {agentActions(agent, false)}
        </ContextMenu.Root>
      </div>
    );
  }

  return (
    <aside
      id="agent-sidebar"
      aria-label="Agent navigation"
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
            class={[
              "sidebar-icon-button no-drag",
              props.compact ? "sidebar-toggle-button" : "sidebar-marketplace-button",
            ]}
            onClick={() => (props.compact ? props.onExpand() : props.onOpenMarketplace())}
            aria-label={props.compact ? "Expand sidebar" : "Open Marketplace"}
            aria-controls={props.compact ? "agent-sidebar" : undefined}
            aria-expanded={props.compact ? "false" : undefined}
            title={props.compact ? "Expand sidebar" : "Marketplace"}
          >
            <Show when={props.compact} fallback={<Puzzle aria-hidden="true" />}>
              <SidebarToggleIcon />
            </Show>
          </Button>
          <Button
            variant="ghost"
            type="button"
            class="sidebar-icon-button sidebar-new-button no-drag"
            onClick={props.onCreateAgent}
            aria-label="Create new agent"
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
        ref={(element) => {
          agentList = element;
          scrollFades.bind(element);
        }}
        aria-label="Chat list"
        class={["agent-list", scrollFades.classes()]}
        data-sidebar-dragging={draggingKind()}
        onDragOver={updateSidebarNativeDrag}
        onDragLeave={(event) => {
          const point = { clientX: event.clientX, clientY: event.clientY };
          if (pointInRect(point, dragGeometry.list)) return;
          scheduleSidebarDragTarget(point);
        }}
        onDrop={dropSidebarNativeDrag}
        onScroll={scrollFades.measure}
      >
        <div class="agent-list-content">
          <Show
            when={
              resolvedPinnedItems().length > 0 ||
              filteredAgents().length > 0 ||
              (props.showPeople !== false && filteredPeople().length > 0) ||
              pending.sectionEditor?.target.kind === "create"
            }
            fallback={
              <Show
                when={!query().trim() && props.emptyAction}
                fallback={
                  <p class="empty-search">
                    {query().trim() ? "No matches" : props.agents.length ? "No matches" : "No agents yet"}
                  </p>
                }
              >
                {(action) => (
                  <div class="sidebar-first-agent-state">
                    <Button
                      variant="ghost"
                      type="button"
                      class="agent-row agent-row-active sidebar-first-agent-action"
                      aria-label={action().label}
                      aria-pressed="true"
                      data-avatar-seed={action().avatarSeed}
                      data-avatar-hue={action().avatarHue ?? "automatic"}
                      onClick={action().onSelect}
                    >
                      <span class="agent-row-avatar">
                        <AgentAvatar seed={action().avatarSeed} hue={action().avatarHue} motion="hover" />
                      </span>
                      <span class="agent-row-copy">
                        <span class="agent-row-heading">
                          <span class="agent-row-title">
                            <strong>{action().label}</strong>
                          </span>
                        </span>
                      </span>
                    </Button>
                    <p class="sidebar-first-agent-empty">No chats yet</p>
                  </div>
                )}
              </Show>
            }
          >
            <Show when={resolvedPinnedItems().length > 0 || drag.emptyPinnedDropVisible}>
              <section
                class={[
                  "sidebar-chat-group sidebar-pinned-group",
                  {
                    "sidebar-pinned-group-agent-drop-target": pinnedDropActive(),
                    "sidebar-pinned-group-empty-target": drag.emptyPinnedDropVisible,
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
                  <Show when={drag.emptyPinnedDropVisible}>
                    <li class="sidebar-pinned-empty-drop">Drag here to pin</li>
                  </Show>
                  <For each={resolvedPinnedItems()}>
                    {(item) => {
                      const key = () => sidebarPinnedItemKey(item.ref);
                      const dragOffset = createMemo(() => pinnedDragOffset(key()));
                      const name = () => item.agent.name;
                      const title = () => item.agent.title.trim();
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
                              source: { kind: "agent", id: item.agent.id, key: key(), origin: "pinned" },
                            });
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
                                "agent-row sidebar-pinned-row",
                                "agent-row",
                                { "agent-row-active": props.activeAgentId === item.agent.id },
                              ]}
                              aria-label={`${item.agent.name}, pinned agent`}
                              aria-pressed={props.activeAgentId === item.agent.id ? "true" : "false"}
                              onClick={() => props.onSelectAgent(item.agent.id)}
                            >
                              <SidebarPinnedAvatar item={item} agentState={() => props.agentStates[item.agent.id]} />
                              <span class="agent-row-copy sidebar-pinned-copy">
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
                              <Show when={props.agentStates[item.agent.id]}>
                                {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
                              </Show>
                            </ContextMenu.Trigger>
                            {agentActions(item.agent, true)}
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
                    <Show when={props.showPeople !== false && filteredPeople().length > 0}>
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
                                        "agent-row person-row",
                                        { "agent-row-active": props.activeDirectMemberId === member.id },
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
                                      <span class="agent-row-avatar">
                                        <TeamPersonAvatar member={member} motion="hover" />
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
                                      <span class="agent-row-copy">
                                        <span class="agent-row-heading">
                                          <strong>{teamMemberName(member)}</strong>
                                          <span>{thread() ? sidebarMessageTime(thread()?.updatedAt ?? "") : ""}</span>
                                        </span>
                                        <span class="agent-row-preview">
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

                const agents = () => filteredAgentsBySection().get(sectionId) ?? [];
                const name = () =>
                  sectionId === SIDEBAR_UNASSIGNED_SECTION_ID
                    ? "Unassigned"
                    : (customSectionById().get(sectionId)?.name ?? "");
                return (
                  <Show
                    when={name() && (agents().length > 0 || (customSectionById().has(sectionId) && !normalizedQuery()))}
                  >
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
                          <For each={agents()}>{(agent) => agentRow(agent)}</For>
                        </div>
                      </div>
                    </section>
                  </Show>
                );
              }}
            </For>
            <Show when={pending.sectionEditor?.target.kind === "create"}>
              <section class="sidebar-chat-group sidebar-section sidebar-section-draft" aria-label="New section">
                {sectionEditorHeader()}
              </section>
            </Show>
          </Show>
          <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {reorderAnnouncement()}
          </span>
        </div>
        <Show when={layoutMutable()}>
          <ContextMenu.Root modal={false}>
            <ContextMenu.Trigger class="sidebar-list-context-trigger" aria-label="Sidebar free area" />
            <ContextMenu.Portal>
              <ContextMenu.Content class="agent-context-menu" aria-label="Sidebar actions">
                <ContextMenu.Item onSelect={() => startCreateSection()}>
                  <FolderPlus class="agent-context-icon size-4" aria-hidden="true" />
                  <span>New section</span>
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        </Show>
      </nav>

      <AlertDialog.Root
        open={Boolean(deleteTarget())}
        onOpenChange={(open) => {
          if (!open && !deleting()) closeDelete();
        }}
      >
        <Show when={deleteTarget()}>
          {(agent) => (
            <AlertDialog.Portal>
              <AlertDialog.Overlay class="agent-delete-backdrop">
                <AlertDialog.Content class="agent-delete-dialog">
                  <AgentAvatar
                    agent={agent()}
                    style={{
                      width: "44px",
                      height: "44px",
                      "margin-bottom": "15px",
                    }}
                  />
                  <AlertDialog.Title>Delete {agent().name}?</AlertDialog.Title>
                  <AlertDialog.Description>
                    This removes the agent and its OpenBot conversation from the app. Its queue, memories, routines, and
                    workspace are deleted. History stored separately by the connected CLI provider is not deleted.
                  </AlertDialog.Description>
                  <Show when={deleteError()}>{(message) => <p class="agent-delete-error">{message()}</p>}</Show>
                  <div class="agent-delete-actions">
                    <Button variant="outline" type="button" disabled={deleting()} onClick={closeDelete}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      type="button"
                      class="agent-delete-confirm"
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
          if (!open && !deleting()) closeDelete();
        }}
      >
        <Show when={sectionDeleteTarget()}>
          {(section) => (
            <AlertDialog.Portal>
              <AlertDialog.Overlay class="agent-delete-backdrop">
                <AlertDialog.Content class="agent-delete-dialog sidebar-section-delete-dialog">
                  <span class="sidebar-section-delete-icon" aria-hidden="true">
                    <Trash2 class="size-5" />
                  </span>
                  <AlertDialog.Title>Delete {section().name}?</AlertDialog.Title>
                  <AlertDialog.Description>
                    Agents in this section will move to Unassigned. No agents will be deleted.
                  </AlertDialog.Description>
                  <Show when={deleteError()}>{(message) => <p class="agent-delete-error">{message()}</p>}</Show>
                  <div class="agent-delete-actions">
                    <Button variant="outline" type="button" disabled={deleting()} onClick={closeDelete}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      type="button"
                      class="agent-delete-confirm"
                      disabled={deleting()}
                      onClick={() => void confirmSectionDelete()}
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

function agentMatchesQuery(agent: AgentProfile, query: string): boolean {
  return !query || `${agent.name} ${agent.title} ${agent.description} ${agent.preview}`.toLowerCase().includes(query);
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
