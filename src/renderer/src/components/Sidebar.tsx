import { Portal } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { INPUT_LIMITS } from "../../../shared/input-limits";
import type {
  AccountUsage,
  AgentStatus,
  AppInfo,
  ExternalDestination,
  UpdateStatus,
} from "../../../shared/ipc";
import type { BotProfile } from "../data";
import { AgentAvatar } from "./AgentAvatar";

interface SidebarProps {
  bots: BotProfile[];
  activeBotId: string;
  appInfo: AppInfo | null;
  agentStatus: AgentStatus;
  accountUsage: AccountUsage | null;
  updateStatus: UpdateStatus;
  agentStates: Record<string, SidebarAgentState>;
  onSelectBot: (botId: string) => void;
  onCreateBot: () => void;
  onEditBot: (botId: string) => void;
  onDeleteBot: (botId: string) => Promise<void>;
  onRefreshUsage: () => Promise<AccountUsage>;
  onUpdateAction: () => Promise<void>;
  onOpenExternal: (destination: ExternalDestination) => Promise<void>;
  onOpenPermissions: () => void;
  onCollapse: () => void;
}

export type SidebarAgentState =
  | { kind: "working" }
  | { kind: "responded" }
  | { kind: "unread"; count: number };

function sidebarAgentStateLabel(state: SidebarAgentState): string {
  if (state.kind === "working") return "Thinking";
  if (state.kind === "responded") return "Responded";
  return `${state.count} new ${state.count === 1 ? "reply" : "replies"}`;
}

function SidebarAgentIndicator(props: { state: SidebarAgentState }) {
  const unreadCount = () => (props.state.kind === "unread" ? props.state.count : 0);
  return (
    <span
      class={`bot-row-agent-status bot-row-agent-status-${props.state.kind}`}
      aria-hidden="true"
    >
      <Show when={props.state.kind === "working"}>
        <span class="bot-row-thinking-dots">
          <i />
          <i />
          <i />
        </span>
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

interface BotContextMenu {
  botId: string;
  x: number;
  y: number;
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
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      class="bot-context-icon size-4 fill-none stroke-current"
    >
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

function UsageIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M4.2 13.9a6.5 6.5 0 1 1 11.6 0" />
      <path d="m10 10 3.1-2.3" />
      <circle cx="10" cy="10" r="1" class="account-menu-icon-fill" />
    </svg>
  );
}

function FeedbackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M4 5.2h12v8.6H9l-3.5 2.4v-2.4H4V5.2Z" />
      <path d="M7 8.2h6M7 10.8h4" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M3.8 4.8h12.4v10.4H3.8V4.8Z" />
      <path d="m4.5 5.6 5.5 4.2 5.5-4.2" />
    </svg>
  );
}

function UpdateIcon(props: { active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      class={["account-menu-icon", { "account-menu-icon-spinning": props.active }]}
    >
      <path d="M15.4 6.8A6 6 0 1 0 16 10" />
      <path d="M15.4 3.8v3h-3" />
    </svg>
  );
}

function PermissionsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M10 2.9 15.5 5v4.6c0 3.6-2.2 6.3-5.5 7.5-3.3-1.2-5.5-3.9-5.5-7.5V5L10 2.9Z" />
      <path d="m7.6 9.9 1.5 1.5 3.3-3.4" />
    </svg>
  );
}

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<BotContextMenu | null>(null);
  const [deleteTargetId, setDeleteTargetId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  const [accountMenuOpen, setAccountMenuOpen] = createSignal(false);
  const [usageLoading, setUsageLoading] = createSignal(false);
  const [accountError, setAccountError] = createSignal<string | null>(null);
  let firstMenuItem: HTMLButtonElement | undefined;
  let botList: HTMLElement | undefined;
  const filteredBots = createMemo(() => {
    const normalizedQuery = query().trim().toLowerCase();
    return normalizedQuery
      ? props.bots.filter((bot) =>
          `${bot.name} ${bot.role} ${bot.preview}`.toLowerCase().includes(normalizedQuery),
        )
      : props.bots;
  });
  const accountEmail = createMemo(() => {
    const auth = props.agentStatus.auth;
    return auth.kind === "chatgpt" || auth.kind === "claude" ? auth.email : null;
  });
  const accountName = createMemo(() => accountEmail() ?? "OpenBot");
  const accountInitials = createMemo(() => {
    const localPart = accountEmail()?.split("@")[0] ?? "OpenBot";
    const parts = localPart.split(/[._\-\s]+/).filter(Boolean);
    return (
      parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : localPart.slice(0, 2)
    ).toUpperCase();
  });
  const weeklyUsage = createMemo(() => {
    const limit =
      props.accountUsage?.limits.find((candidate) => candidate.id === "codex") ??
      props.accountUsage?.limits[0];
    if (!limit) return null;
    return (
      [limit.primary, limit.secondary].find((window) => window?.windowDurationMins === 10_080) ??
      limit.secondary ??
      limit.primary
    );
  });
  const weeklyUsageRemaining = createMemo(() => {
    const usage = weeklyUsage();
    return usage ? Math.max(0, Math.round(100 - usage.usedPercent)) : null;
  });
  const deleteTarget = createMemo(() => props.bots.find((bot) => bot.id === deleteTargetId()));
  const updateAvailable = createMemo(() =>
    ["available", "downloading", "ready", "installing"].includes(props.updateStatus.phase),
  );
  const updateBusy = createMemo(() =>
    ["checking", "downloading", "installing"].includes(props.updateStatus.phase),
  );
  const updateLabel = createMemo(() => {
    switch (props.updateStatus.phase) {
      case "checking":
        return "Checking for updates…";
      case "available":
        return "Download update";
      case "downloading":
        return "Downloading update…";
      case "ready":
        return "Restart to update";
      case "installing":
        return "Restarting…";
      case "up-to-date":
        return "Check for updates";
      case "error":
        return "Check for updates";
      default:
        return "Check for updates";
    }
  });
  const updateDetail = createMemo(() => {
    const status = props.updateStatus;
    if (status.phase === "downloading" && status.progress !== null) {
      return `${Math.round(status.progress)}%`;
    }
    if (status.availableVersion) return `v${status.availableVersion}`;
    if (status.phase === "up-to-date") return "Up to date";
    return status.currentVersion ? `v${status.currentVersion}` : "";
  });
  const popoverError = createMemo(
    () =>
      accountError() ?? (props.updateStatus.phase === "error" ? props.updateStatus.message : null),
  );

  function updateScrollFade() {
    if (!botList) return;
    const remaining = botList.scrollHeight - botList.scrollTop - botList.clientHeight;
    setFadeAtTop(botList.scrollTop > 2);
    setFadeAtBottom(remaining > 2);
  }

  createEffect(
    () => filteredBots(),
    () => {
      requestAnimationFrame(updateScrollFade);
    },
  );

  onSettled(() => {
    const closeMenu = () => {
      setContextMenu(null);
      setAccountMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deleteTargetId()) setDeleteTargetId(null);
      else if (accountMenuOpen()) setAccountMenuOpen(false);
      else closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    const resizeObserver = new ResizeObserver(updateScrollFade);
    if (botList) resizeObserver.observe(botList);
    requestAnimationFrame(updateScrollFade);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  });

  function openContextMenu(botId: string, x: number, y: number) {
    setDeleteError(null);
    setContextMenu({
      botId,
      x: Math.max(8, Math.min(x, window.innerWidth - 190)),
      y: Math.max(8, Math.min(y, window.innerHeight - 116)),
    });
    requestAnimationFrame(() => firstMenuItem?.focus());
  }

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

  async function refreshUsage() {
    if (usageLoading() || props.agentStatus.phase !== "ready") return;
    setUsageLoading(true);
    setAccountError(null);
    try {
      await props.onRefreshUsage();
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : "Usage is unavailable.");
    } finally {
      setUsageLoading(false);
    }
  }

  function toggleAccountMenu() {
    const opening = !accountMenuOpen();
    setAccountMenuOpen(opening);
    setAccountError(null);
    if (opening) void refreshUsage();
  }

  function openExternal(destination: ExternalDestination) {
    setAccountError(null);
    void props
      .onOpenExternal(destination)
      .then(() => setAccountMenuOpen(false))
      .catch((error) =>
        setAccountError(error instanceof Error ? error.message : "Could not open the link."),
      );
  }

  function runUpdateAction() {
    setAccountError(null);
    void props
      .onUpdateAction()
      .catch((error) =>
        setAccountError(error instanceof Error ? error.message : "Could not update OpenBot."),
      );
  }

  return (
    <aside id="bot-sidebar" aria-label="Bot navigation" class="sidebar panel-edge">
      <div class="window-drag sidebar-topbar">
        <button
          type="button"
          class="sidebar-icon-button sidebar-toggle-button no-drag"
          onClick={props.onCollapse}
          aria-label="Hide sidebar"
          aria-controls="bot-sidebar"
          aria-expanded="true"
          title="Hide sidebar"
        >
          <SidebarToggleIcon />
        </button>
        <button
          type="button"
          class="sidebar-icon-button sidebar-new-button no-drag"
          onClick={props.onCreateBot}
          aria-label="New agent"
        >
          <PlusIcon />
        </button>
      </div>

      <div class="sidebar-search-wrap">
        <label class="search-field">
          <span class="sr-only">Search chats</span>
          <SearchIcon />
          <input
            type="search"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search"
            aria-label="Search chats"
            maxlength={INPUT_LIMITS.agentName}
          />
        </label>
      </div>

      <nav
        ref={(element) => (botList = element)}
        aria-label="Bot list"
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
          when={filteredBots().length > 0}
          fallback={
            <p class="empty-search">{props.bots.length ? "No matches" : "No agents yet"}</p>
          }
        >
          <For each={filteredBots()}>
            {(bot) => (
              <button
                type="button"
                class={[
                  "bot-row",
                  {
                    "bot-row-active": props.activeBotId === bot.id,
                    "bot-row-menu-open": contextMenu()?.botId === bot.id,
                  },
                ]}
                aria-pressed={props.activeBotId === bot.id ? "true" : "false"}
                onClick={() => props.onSelectBot(bot.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openContextMenu(bot.id, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
                    return;
                  }
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openContextMenu(bot.id, bounds.left + 28, bounds.top + 32);
                }}
              >
                <span class="bot-row-avatar">
                  <AgentAvatar bot={bot} />
                  <Show when={props.agentStates[bot.id]}>
                    {(state) => <SidebarAgentIndicator state={state()} />}
                  </Show>
                </span>
                <span class="bot-row-copy">
                  <span class="bot-row-heading">
                    <strong>{bot.name}</strong>
                    <span>{bot.time}</span>
                  </span>
                  <span class="bot-row-preview">{bot.preview}</span>
                </span>
                <Show when={props.agentStates[bot.id]}>
                  {(state) => <span class="sr-only">{sidebarAgentStateLabel(state())}</span>}
                </Show>
              </button>
            )}
          </For>
        </Show>
      </nav>

      <div class="sidebar-account">
        <Show when={accountMenuOpen()}>
          <div
            class="account-popover"
            role="menu"
            aria-label="Account menu"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Show when={props.updateStatus.phase !== "unsupported"}>
              <button
                type="button"
                role="menuitem"
                class="account-menu-row account-update-row"
                onClick={runUpdateAction}
                disabled={updateBusy()}
              >
                <UpdateIcon active={updateBusy()} />
                <span>{updateLabel()}</span>
                <small>{updateDetail()}</small>
              </button>
              <div class="account-menu-separator" />
            </Show>
            <button
              type="button"
              role="menuitem"
              class="account-menu-row"
              onClick={() => void refreshUsage()}
              disabled={usageLoading() || props.agentStatus.phase !== "ready"}
            >
              <UsageIcon />
              <span>{usageLoading() ? "Updating usage…" : "Weekly usage"}</span>
              <small>{weeklyUsageRemaining() === null ? "—" : `${weeklyUsageRemaining()}%`}</small>
            </button>
            <div class="account-menu-separator" />
            <button
              type="button"
              role="menuitem"
              class="account-menu-row"
              onClick={() => {
                setAccountMenuOpen(false);
                props.onOpenPermissions();
              }}
            >
              <PermissionsIcon />
              <span>Providers &amp; permissions</span>
            </button>
            <div class="account-menu-separator" />
            <button
              type="button"
              role="menuitem"
              class="account-menu-row"
              onClick={() => openExternal("feedback")}
            >
              <FeedbackIcon />
              <span>Send feedback</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="account-menu-row"
              onClick={() => openExternal("message")}
            >
              <MessageIcon />
              <span>Message</span>
            </button>
            <Show when={popoverError()}>
              {(message) => <p class="account-popover-error">{message()}</p>}
            </Show>
          </div>
        </Show>

        <button
          type="button"
          class="sidebar-footer"
          aria-label="Open account menu"
          aria-expanded={accountMenuOpen() ? "true" : "false"}
          onClick={toggleAccountMenu}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span class="profile-dot">{accountInitials()}</span>
          <span class="profile-copy">
            <strong>{accountName()}</strong>
            <Show when={props.appInfo}>
              {(info) => (
                <span class="sr-only" data-testid="app-version">
                  Version {info().version} · {info().platform}
                </span>
              )}
            </Show>
          </span>
          <Show when={updateAvailable()}>
            <span class="sidebar-update-pill">Update</span>
            <span class="sr-only">OpenBot update available</span>
          </Show>
        </button>
      </div>

      <Show when={contextMenu()}>
        {(menu) => (
          <Portal>
            <div
              class="bot-context-menu"
              role="menu"
              aria-label="Agent actions"
              style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                ref={(element) => (firstMenuItem = element)}
                type="button"
                role="menuitem"
                onClick={() => {
                  const botId = menu().botId;
                  setContextMenu(null);
                  props.onEditBot(botId);
                }}
              >
                <EditIcon />
                <span>Edit agent</span>
              </button>
              <div class="bot-context-separator" />
              <button
                type="button"
                role="menuitem"
                class="bot-context-danger"
                onClick={() => {
                  const botId = menu().botId;
                  setContextMenu(null);
                  setDeleteTargetId(botId);
                }}
              >
                <DeleteIcon />
                <span>Delete agent</span>
              </button>
            </div>
          </Portal>
        )}
      </Show>

      <Show when={deleteTarget()}>
        {(bot) => (
          <Portal>
            <div
              class="bot-delete-backdrop"
              role="presentation"
              onPointerDown={(event) => {
                if (event.currentTarget === event.target && !deleting()) setDeleteTargetId(null);
              }}
            >
              <section
                class="bot-delete-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="bot-delete-title"
                aria-describedby="bot-delete-description"
              >
                <AgentAvatar
                  bot={bot()}
                  style={{ width: "44px", height: "44px", "margin-bottom": "15px" }}
                />
                <h2 id="bot-delete-title">Delete {bot().name}?</h2>
                <p id="bot-delete-description">
                  This removes the agent, its OpenBot queue, and managed files used only by that
                  conversation. Its workspace and CLI history stay on your Mac.
                </p>
                <Show when={deleteError()}>
                  {(message) => <p class="bot-delete-error">{message()}</p>}
                </Show>
                <div class="bot-delete-actions">
                  <button
                    type="button"
                    disabled={deleting()}
                    onClick={() => setDeleteTargetId(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="bot-delete-confirm"
                    disabled={deleting()}
                    onClick={() => void confirmDelete()}
                  >
                    {deleting() ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </section>
            </div>
          </Portal>
        )}
      </Show>
    </aside>
  );
}
