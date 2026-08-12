import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { AgentStatus, AppInfo } from "../../../shared/ipc";
import type { BotProfile } from "../data";
import { GrokMark } from "./GrokMark";

interface SidebarProps {
  bots: BotProfile[];
  activeBotId: string;
  appInfo: AppInfo | null;
  agentStatus: AgentStatus;
  onSelectBot: (botId: string) => void;
  onCreateBot: () => void;
  onEditBot: (botId: string) => void;
  onDeleteBot: (botId: string) => Promise<void>;
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

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = createSignal("");
  const [contextMenu, setContextMenu] = createSignal<BotContextMenu | null>(null);
  const [deleteTargetId, setDeleteTargetId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  let firstMenuItem: HTMLButtonElement | undefined;
  const filteredBots = createMemo(() => {
    const normalizedQuery = query().trim().toLowerCase();
    return normalizedQuery
      ? props.bots.filter((bot) =>
          `${bot.name} ${bot.role} ${bot.preview}`.toLowerCase().includes(normalizedQuery),
        )
      : props.bots;
  });
  const accountLabel = createMemo(() => {
    const auth = props.agentStatus.auth;
    if (auth.kind === "chatgpt") {
      return `ChatGPT${auth.planType ? ` ${auth.planType}` : " subscription"} · Codex ${props.agentStatus.phase}`;
    }
    if (auth.kind === "signed-out") return "ChatGPT sign-in required";
    if (auth.kind === "unsupported") return `Unsupported ${auth.accountType} login`;
    return props.agentStatus.message ?? `Codex ${props.agentStatus.phase}`;
  });
  const deleteTarget = createMemo(() => props.bots.find((bot) => bot.id === deleteTargetId()));

  onMount(() => {
    const closeMenu = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deleteTargetId()) setDeleteTargetId(null);
      else closeMenu();
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    onCleanup(() => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    });
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

  return (
    <aside aria-label="Bot navigation" class="sidebar panel-edge">
      <div class="window-drag sidebar-topbar">
        <button
          type="button"
          class="sidebar-new-button no-drag"
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
          />
        </label>
      </div>

      <nav aria-label="Bot list" class="bot-list">
        <Show when={filteredBots().length > 0} fallback={<p class="empty-search">No matches</p>}>
          <For each={filteredBots()}>
            {(bot) => (
              <button
                type="button"
                class="bot-row"
                classList={{
                  "bot-row-active": props.activeBotId === bot.id,
                  "bot-row-menu-open": contextMenu()?.botId === bot.id,
                }}
                aria-pressed={props.activeBotId === bot.id}
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
                <span class={`bot-avatar bot-avatar-${bot.accent}`}>
                  <GrokMark />
                </span>
                <span class="bot-row-copy">
                  <span class="bot-row-heading">
                    <strong>{bot.name}</strong>
                    <span>{bot.time}</span>
                  </span>
                  <span class="bot-row-preview">{bot.preview}</span>
                </span>
              </button>
            )}
          </For>
        </Show>
      </nav>

      <div class="sidebar-footer">
        <span class="profile-dot">IB</span>
        <span class="profile-copy">
          <strong>Infeld Bot</strong>
          <span data-testid="agent-status" title={props.agentStatus.message ?? undefined}>
            {accountLabel()}
          </span>
          <Show when={props.appInfo}>
            {(info) => (
              <span class="sr-only" data-testid="app-version">
                Version {info().version} · {info().platform}
              </span>
            )}
          </Show>
        </span>
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
                <span
                  class={`bot-avatar bot-avatar-${bot().accent}`}
                  style={{ width: "44px", height: "44px", "margin-bottom": "15px" }}
                >
                  <GrokMark />
                </span>
                <h2 id="bot-delete-title">Delete {bot().name}?</h2>
                <p id="bot-delete-description">
                  This removes the agent and conversation from Infeld. Its local workspace stays on
                  your Mac.
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
