import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DirectThreadSummary, TeamPresenceMember } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { BotProfile } from "../data";
import { AgentAvatar } from "./AgentAvatar";
import { TeamPersonAvatar, teamMemberName } from "./TeamPersonAvatar";
import { TypingDots } from "./TypingDots";
import { AlertDialog, Badge, Button, ContextMenu, Input } from "./ui";

interface SidebarProps {
  serverName: string;
  bots: BotProfile[];
  activeBotId: string;
  people: TeamPresenceMember[];
  directThreads: DirectThreadSummary[];
  activeDirectMemberId: string | null;
  agentStates: Record<string, SidebarAgentState>;
  onSelectBot: (botId: string) => void;
  onSelectPerson: (memberId: string) => void;
  onPreloadDirectConversation?: () => void;
  onCreateBot: () => void;
  onEditBot: (botId: string) => void;
  onDeleteBot: (botId: string) => Promise<void>;
  compact: boolean;
  onCollapse: () => void;
  onExpand: () => void;
}

export type SidebarAgentState = { kind: "working" } | { kind: "responded" } | { kind: "unread"; count: number };

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
  let botList: HTMLElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  const filteredBots = createMemo(() => {
    const normalizedQuery = query().trim().toLowerCase();
    return normalizedQuery
      ? props.bots.filter((bot) =>
          `${bot.name} ${bot.title} ${bot.description} ${bot.preview}`.toLowerCase().includes(normalizedQuery),
        )
      : props.bots;
  });
  const directThreadByMember = createMemo(
    () => new Map(props.directThreads.map((thread) => [thread.otherMemberId, thread])),
  );
  const filteredPeople = createMemo(() => {
    const normalizedQuery = query().trim().toLowerCase();
    return [...props.people]
      .filter((member) => {
        if (!normalizedQuery) return true;
        const thread = directThreadByMember().get(member.id);
        return `${teamMemberName(member)} ${member.email ?? member.username} ${thread?.lastMessage.text ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery);
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

  function updateScrollFade() {
    if (!botList) return;
    const remaining = botList.scrollHeight - botList.scrollTop - botList.clientHeight;
    setFadeAtTop(botList.scrollTop > 2);
    setFadeAtBottom(remaining > 2);
  }

  createEffect(
    () => [filteredBots(), filteredPeople()],
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
            aria-label="New agent"
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
          when={filteredBots().length > 0 || filteredPeople().length > 0}
          fallback={
            <p class="empty-search">
              {query().trim() ? "No matches" : props.bots.length ? "No matches" : "No agents yet"}
            </p>
          }
        >
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
                    <Button
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
                    </Button>
                  );
                }}
              </For>
            </section>
          </Show>
          <Show when={filteredBots().length > 0}>
            <section
              class="sidebar-chat-group"
              aria-label={filteredPeople().length > 0 ? undefined : "Agents"}
              aria-labelledby={filteredPeople().length > 0 ? "sidebar-agents-heading" : undefined}
            >
              <Show when={filteredPeople().length > 0}>
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
                      <ContextMenu.Portal>
                        <ContextMenu.Content class="bot-context-menu" aria-label="Agent actions">
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
                    </ContextMenu.Root>
                  );
                }}
              </For>
            </section>
          </Show>
        </Show>
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
