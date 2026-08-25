import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { BotAvatarHue, DirectThreadSummary, TeamPresenceMember } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import type { BotProfile } from "../data";
import { MAX_SIDEBAR_PINNED_ITEMS, type SidebarPinnedItem, sidebarPinnedItemKey } from "../sidebar-pins";
import { AgentAvatar } from "./AgentAvatar";
import { createBoundedDragPreview } from "./createBoundedDragPreview";
import { TeamPersonAvatar, teamMemberName } from "./TeamPersonAvatar";
import { TypingDots } from "./TypingDots";
import { AlertDialog, Badge, Button, ContextMenu, Input, Pin, PinOff } from "./ui";

interface SidebarProps {
  serverName: string;
  bots: BotProfile[];
  activeBotId: string;
  people: TeamPresenceMember[];
  directThreads: DirectThreadSummary[];
  activeDirectMemberId: string | null;
  agentStates: Record<string, SidebarAgentState>;
  pinnedItems: SidebarPinnedItem[];
  onPin: (item: SidebarPinnedItem) => void;
  onUnpin: (item: SidebarPinnedItem) => void;
  onReorderPinned: (items: SidebarPinnedItem[]) => void;
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

type ResolvedPinnedItem =
  | { ref: SidebarPinnedItem; kind: "agent"; bot: BotProfile }
  | { ref: SidebarPinnedItem; kind: "person"; member: TeamPresenceMember };

interface DragSlot {
  key: string;
  left: number;
  top: number;
  centerX: number;
  centerY: number;
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

function SidebarPinnedAvatar(props: {
  item: ResolvedPinnedItem;
  thread: () => DirectThreadSummary | undefined;
  agentState: () => SidebarAgentState | undefined;
}) {
  if (props.item.kind === "person") {
    return (
      <span class="bot-row-avatar sidebar-pinned-avatar">
        <TeamPersonAvatar member={props.item.member} />
        <Show when={(props.thread()?.unreadCount ?? 0) > 0}>
          <Badge class="person-unread-badge" tone="accent" shape="pill" aria-hidden="true">
            {Math.min(props.thread()?.unreadCount ?? 0, 99)}
          </Badge>
        </Show>
      </span>
    );
  }
  return (
    <span class="bot-row-avatar sidebar-pinned-avatar">
      <AgentAvatar bot={props.item.bot} motion={props.agentState()?.kind === "working" ? "working" : "idle"} />
      <Show when={props.agentState()}>{(state) => <SidebarAgentIndicator state={state()} />}</Show>
    </span>
  );
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
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  const [draggedPinnedKey, setDraggedPinnedKey] = createSignal<string | null>(null);
  const [dragOverPinnedKey, setDragOverPinnedKey] = createSignal<string | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = createSignal("");
  let botList: HTMLElement | undefined;
  let pinnedList: HTMLUListElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let pinnedDragSlots: DragSlot[] = [];
  const pinnedDragPreview = createBoundedDragPreview();
  const directThreadByMember = createMemo(
    () => new Map(props.directThreads.map((thread) => [thread.otherMemberId, thread])),
  );
  const normalizedQuery = createMemo(() => query().trim().toLowerCase());
  const pinnedKeys = createMemo(() => new Set(props.pinnedItems.map(sidebarPinnedItemKey)));
  const botById = createMemo(() => new Map(props.bots.map((bot) => [bot.id, bot])));
  const personById = createMemo(() => new Map(props.people.map((member) => [member.id, member])));
  const resolvedPinnedItems = createMemo<ResolvedPinnedItem[]>(() => {
    const items: ResolvedPinnedItem[] = [];
    for (const ref of props.pinnedItems) {
      if (ref.kind === "agent") {
        const bot = botById().get(ref.id);
        if (bot && botMatchesQuery(bot, normalizedQuery())) items.push({ ref, kind: "agent", bot });
        continue;
      }
      const member = personById().get(ref.id);
      if (member && personMatchesQuery(member, directThreadByMember().get(member.id), normalizedQuery())) {
        items.push({ ref, kind: "person", member });
      }
    }
    return items;
  });
  const filteredBots = createMemo(() =>
    props.bots.filter(
      (bot) =>
        !pinnedKeys().has(sidebarPinnedItemKey({ kind: "agent", id: bot.id })) &&
        botMatchesQuery(bot, normalizedQuery()),
    ),
  );
  const filteredPeople = createMemo(() => {
    return [...props.people]
      .filter((member) => {
        if (pinnedKeys().has(sidebarPinnedItemKey({ kind: "person", id: member.id }))) return false;
        const thread = directThreadByMember().get(member.id);
        return personMatchesQuery(member, thread, normalizedQuery());
      })
      .sort((left, right) => {
        const leftThread = directThreadByMember().get(left.id);
        const rightThread = directThreadByMember().get(right.id);
        if (leftThread || rightThread) {
          return (rightThread?.updatedAt ?? "").localeCompare(leftThread?.updatedAt ?? "");
        }
        if (left.online !== right.online) return left.online ? -1 : 1;
        return teamMemberName(left).localeCompare(teamMemberName(right));
      });
  });
  const deleteTarget = createMemo(() => props.bots.find((bot) => bot.id === deleteTargetId()));

  onCleanup(() => pinnedDragPreview.stop());

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

  function expandToSearch(): void {
    props.onExpand();
    queueMicrotask(() => searchInput?.focus());
  }

  function visiblePinnedKeys(): string[] {
    return resolvedPinnedItems().map((item) => sidebarPinnedItemKey(item.ref));
  }

  function measurePinnedDragSlots(): void {
    if (!pinnedList) return;
    pinnedDragSlots = Array.from(pinnedList.querySelectorAll<HTMLElement>("[data-pinned-key]")).map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        key: element.dataset.pinnedKey ?? "",
        left: bounds.left,
        top: bounds.top,
        centerX: bounds.left + bounds.width / 2,
        centerY: bounds.top + bounds.height / 2,
      };
    });
  }

  function updatePinnedDragTarget(clientX: number, clientY: number): string | null {
    if (pinnedDragSlots.length === 0) return null;
    const target = pinnedDragSlots.reduce((closest, slot) =>
      Math.hypot(slot.centerX - clientX, slot.centerY - clientY) <
      Math.hypot(closest.centerX - clientX, closest.centerY - clientY)
        ? slot
        : closest,
    );
    setDragOverPinnedKey(target.key);
    return target.key;
  }

  function pinnedKeyFromEventTarget(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>("[data-pinned-key]")?.dataset.pinnedKey ?? null;
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

  function reorderPinnedItem(sourceKey: string, targetKey: string): void {
    if (sourceKey === targetKey) return;
    const items = [...props.pinnedItems];
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

  function stopPinnedDragging(): void {
    setDraggedPinnedKey(null);
    setDragOverPinnedKey(null);
    pinnedDragPreview.stop();
  }

  function personActions(member: TeamPresenceMember, pinned: boolean) {
    const ref: SidebarPinnedItem = { kind: "person", id: member.id };
    const pinLimitReached = !pinned && props.pinnedItems.length >= MAX_SIDEBAR_PINNED_ITEMS;
    return (
      <ContextMenu.Portal>
        <ContextMenu.Content class="bot-context-menu" aria-label="Person actions">
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
        </ContextMenu.Content>
      </ContextMenu.Portal>
    );
  }

  function agentActions(bot: BotProfile, pinned: boolean) {
    const ref: SidebarPinnedItem = { kind: "agent", id: bot.id };
    const pinLimitReached = !pinned && props.pinnedItems.length >= MAX_SIDEBAR_PINNED_ITEMS;
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

  return (
    <aside
      id="bot-sidebar"
      aria-label="Bot navigation"
      class={["sidebar panel-edge", { "sidebar-compact": props.compact }]}
    >
      <div class="window-drag sidebar-topbar">
        <span class="sidebar-server-name" title={props.serverName} aria-hidden={props.compact ? "true" : undefined}>
          {props.serverName}
        </span>
        <div class="sidebar-topbar-actions">
          <Button
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
        onScroll={() => updateScrollFade()}
      >
        <Show
          when={resolvedPinnedItems().length > 0 || filteredBots().length > 0 || filteredPeople().length > 0}
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
          <Show when={resolvedPinnedItems().length > 0}>
            <section class="sidebar-chat-group sidebar-pinned-group" aria-label="Pinned chats">
              <ul
                ref={(element) => (pinnedList = element)}
                class="sidebar-pinned-list"
                data-dragging={draggedPinnedKey() ? "" : undefined}
                onDragOver={(event) => {
                  if (!draggedPinnedKey()) return;
                  event.preventDefault();
                  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                  pinnedDragPreview.move(event.clientX, event.clientY);
                  const targetKey =
                    pinnedKeyFromEventTarget(event.target) ?? updatePinnedDragTarget(event.clientX, event.clientY);
                  if (targetKey) setDragOverPinnedKey(targetKey);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const targetKey =
                    pinnedKeyFromEventTarget(event.target) ??
                    updatePinnedDragTarget(event.clientX, event.clientY) ??
                    dragOverPinnedKey();
                  const sourceKey = draggedPinnedKey();
                  if (sourceKey && targetKey) reorderPinnedItem(sourceKey, targetKey);
                  stopPinnedDragging();
                }}
              >
                <For each={resolvedPinnedItems()}>
                  {(item) => {
                    const key = () => sidebarPinnedItemKey(item.ref);
                    const dragOffset = createMemo(() => pinnedDragOffset(key()));
                    const name = () => (item.kind === "person" ? teamMemberName(item.member) : item.bot.name);
                    const title = () => (item.kind === "agent" ? item.bot.title.trim() : "");
                    const thread = () =>
                      item.kind === "person" ? directThreadByMember().get(item.member.id) : undefined;
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
                        onDragOver={(event) => {
                          if (!draggedPinnedKey()) return;
                          event.preventDefault();
                          event.stopPropagation();
                          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                          pinnedDragPreview.move(event.clientX, event.clientY);
                          setDragOverPinnedKey(key());
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const sourceKey = draggedPinnedKey();
                          if (sourceKey) reorderPinnedItem(sourceKey, key());
                          stopPinnedDragging();
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer?.setData("text/plain", key());
                          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                          measurePinnedDragSlots();
                          if (pinnedList) {
                            pinnedDragPreview.start({
                              bounds: pinnedList,
                              className: "sidebar-pinned-drag-preview",
                              event,
                              source: event.currentTarget,
                            });
                          }
                          setDraggedPinnedKey(key());
                          setDragOverPinnedKey(key());
                        }}
                        onDragEnd={stopPinnedDragging}
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
                            as={Button}
                            type="button"
                            class={[
                              "bot-row sidebar-pinned-row",
                              item.kind === "person" ? "person-row" : "agent-row",
                              {
                                "bot-row-active":
                                  item.kind === "person"
                                    ? props.activeDirectMemberId === item.member.id
                                    : props.activeBotId === item.bot.id,
                              },
                            ]}
                            aria-label={
                              item.kind === "person"
                                ? `${teamMemberName(item.member)}, pinned person`
                                : `${item.bot.name}, pinned agent`
                            }
                            aria-pressed={
                              item.kind === "person"
                                ? props.activeDirectMemberId === item.member.id
                                  ? "true"
                                  : "false"
                                : props.activeBotId === item.bot.id
                                  ? "true"
                                  : "false"
                            }
                            onClick={() => {
                              if (item.kind === "person") {
                                props.onPreloadDirectConversation?.();
                                props.onSelectPerson(item.member.id);
                              } else {
                                props.onSelectBot(item.bot.id);
                              }
                            }}
                          >
                            <SidebarPinnedAvatar
                              item={item}
                              thread={thread}
                              agentState={() => (item.kind === "agent" ? props.agentStates[item.bot.id] : undefined)}
                            />
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
                            <Show when={item.kind === "agent" ? props.agentStates[item.bot.id] : undefined}>
                              {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
                            </Show>
                            <Show when={item.kind === "person" && (thread()?.unreadCount ?? 0) > 0}>
                              <span class="sr-only">{thread()?.unreadCount} unread direct messages</span>
                            </Show>
                          </ContextMenu.Trigger>
                          {item.kind === "person" ? personActions(item.member, true) : agentActions(item.bot, true)}
                        </ContextMenu.Root>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </section>
          </Show>
          <Show when={filteredPeople().length > 0}>
            <section
              class="sidebar-chat-group"
              aria-labelledby="sidebar-people-heading"
              onFocusIn={() => props.onPreloadDirectConversation?.()}
              onPointerEnter={() => props.onPreloadDirectConversation?.()}
            >
              <header>
                <h2 id="sidebar-people-heading">People</h2>
              </header>
              <For each={filteredPeople()}>
                {(member) => {
                  const thread = () => directThreadByMember().get(member.id);
                  return (
                    <ContextMenu.Root modal={false}>
                      <ContextMenu.Trigger
                        as={Button}
                        type="button"
                        class={[
                          "bot-row person-row",
                          {
                            "bot-row-active": props.activeDirectMemberId === member.id,
                          },
                        ]}
                        aria-label={`${teamMemberName(member)}. ${thread()?.lastMessage.text ?? (member.online ? "Online now" : "Offline")}`}
                        aria-pressed={props.activeDirectMemberId === member.id ? "true" : "false"}
                        onClick={() => {
                          props.onPreloadDirectConversation?.();
                          props.onSelectPerson(member.id);
                        }}
                      >
                        <span class="bot-row-avatar">
                          <TeamPersonAvatar member={member} />
                          <Show when={(thread()?.unreadCount ?? 0) > 0}>
                            <Badge class="person-unread-badge" tone="accent" shape="pill" aria-hidden="true">
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
                      </ContextMenu.Trigger>
                      {personActions(member, false)}
                    </ContextMenu.Root>
                  );
                }}
              </For>
            </section>
          </Show>
          <Show when={filteredBots().length > 0}>
            <section
              class="sidebar-chat-group"
              aria-label={filteredPeople().length > 0 || resolvedPinnedItems().length > 0 ? undefined : "Agents"}
              aria-labelledby={
                filteredPeople().length > 0 || resolvedPinnedItems().length > 0 ? "sidebar-agents-heading" : undefined
              }
            >
              <Show when={filteredPeople().length > 0 || resolvedPinnedItems().length > 0}>
                <header>
                  <h2 id="sidebar-agents-heading">Agents</h2>
                </header>
              </Show>
              <For each={filteredBots()}>
                {(bot) => {
                  const title = () => bot.title.trim();
                  const working = () => props.agentStates[bot.id]?.kind === "working";
                  return (
                    <ContextMenu.Root modal={false}>
                      <ContextMenu.Trigger
                        as={Button}
                        type="button"
                        class={["bot-row agent-row", { "bot-row-active": props.activeBotId === bot.id }]}
                        aria-label={`${bot.name}${title() ? `, ${title()}` : ""}. ${bot.preview}`}
                        aria-pressed={props.activeBotId === bot.id ? "true" : "false"}
                        onClick={() => props.onSelectBot(bot.id)}
                      >
                        <span class="bot-row-avatar">
                          <AgentAvatar bot={bot} motion={working() ? "working" : "idle"} />
                          <Show when={props.agentStates[bot.id]}>
                            {(state) => <SidebarAgentIndicator state={state()} />}
                          </Show>
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
                  );
                }}
              </For>
            </section>
          </Show>
        </Show>
        <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {reorderAnnouncement()}
        </span>
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
                    <Button type="button" disabled={deleting()} onClick={() => setDeleteTargetId(null)}>
                      Cancel
                    </Button>
                    <Button
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
