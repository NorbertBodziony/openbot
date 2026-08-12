import { createMemo, createSignal, For, Show } from "solid-js";
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

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = createSignal("");
  const filteredBots = createMemo(() => {
    const normalizedQuery = query().trim().toLowerCase();
    return normalizedQuery
      ? props.bots.filter((bot) =>
          `${bot.name} ${bot.role} ${bot.preview}`.toLowerCase().includes(normalizedQuery),
        )
      : props.bots;
  });

  return (
    <aside aria-label="Bot navigation" class="sidebar panel-edge">
      <div class="window-drag sidebar-topbar">
        <div class="fake-traffic-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
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
                classList={{ "bot-row-active": props.activeBotId === bot.id }}
                aria-pressed={props.activeBotId === bot.id}
                onClick={() => props.onSelectBot(bot.id)}
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
        <span class="profile-dot">AS</span>
        <span class="profile-copy">
          <strong>Armand Segall</strong>
          <span
            class="sr-only"
            data-testid="agent-status"
            title={props.agentStatus.message ?? undefined}
          >
            Full access · Codex {props.agentStatus.phase}
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
    </aside>
  );
}
