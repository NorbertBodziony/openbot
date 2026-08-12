import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { BotMessage, BotProfile } from "../data";
import { GrokMark } from "./GrokMark";

interface ConversationProps {
  bot: BotProfile | undefined;
  bots: BotProfile[];
  messages: BotMessage[];
  activeTurnId: string | null | undefined;
  agentPickerOpen: boolean;
  creatingAgent: boolean;
  onCloseAgentPicker: () => void;
  onCreateAgent: () => void;
  onSelectAgent: (botId: string) => void;
  onSendMessage: (body: string) => void;
  onStop: () => void;
}

function ComputerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <rect x="2.5" y="3" width="15" height="10" rx="1.5" stroke-width="1.3" />
      <path d="M7 17h6M10 13v4" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <path d="m5 5 10 10M15 5 5 15" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <path d="M10 4v12M4 10h12" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  );
}

function VoiceIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <rect x="7" y="2.5" width="6" height="10" rx="3" stroke-width="1.4" />
      <path
        d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7.5 17.5h5"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="check-icon fill-none stroke-current">
      <path
        d="m4 10.5 4.1 4L16 5.7"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="clock-icon fill-none stroke-current">
      <circle cx="10" cy="10" r="7.2" stroke-width="1.3" />
      <path d="M10 6v4l2.7 1.7" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function MessageBody(props: { message: BotMessage; onOpenScreen: () => void }) {
  return (
    <>
      <Show when={props.message.kind === "computer"}>
        <div class="computer-card">
          <div class="computer-card-heading">
            <strong>Computer</strong>
            <span class="done-chip">
              <span />
              {props.message.status ?? "Done"}
            </span>
          </div>
          <p>{props.message.body}</p>
          <div class="computer-art" aria-hidden="true">
            <div class="computer-art-window">
              <span />
              <i />
              <i />
              <div>
                <b />
                <b />
                <b />
              </div>
            </div>
          </div>
          <button type="button" class="computer-open-button" onClick={props.onOpenScreen}>
            Open screen
          </button>
        </div>
      </Show>
      <Show when={props.message.kind === "checklist"}>
        <div class="checklist-message">
          <For each={props.message.items ?? props.message.body.split("\n")}>
            {(item) => (
              <p>
                <span>
                  <CheckIcon />
                </span>
                {item}
              </p>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.message.kind === "multi"}>
        <p class="multi-message">
          <span class="multi-agent multi-agent-purple">
            <GrokMark />
            Account Manager
          </span>{" "}
          sent over the Acme + Globex threads and{" "}
          <span class="multi-agent multi-agent-teal">
            <GrokMark />
            Chief
          </span>{" "}
          flagged the priority accounts. Both are folded into tonight&apos;s list.
        </p>
      </Show>
      <Show
        when={
          props.message.kind !== "computer" &&
          props.message.kind !== "checklist" &&
          props.message.kind !== "routine" &&
          props.message.kind !== "multi"
        }
      >
        <p class="message-copy">{props.message.body}</p>
      </Show>
      <Show when={props.message.kind === "routine"}>
        <div class="routine-message">
          <span>
            <ClockIcon />
          </span>
          {props.message.routine}
        </div>
      </Show>
      <Show when={props.message.status && props.message.kind !== "computer"}>
        <div class="message-status">
          <span />
          {props.message.status}
        </div>
      </Show>
    </>
  );
}

export function Conversation(props: ConversationProps) {
  const [draft, setDraft] = createSignal("");
  const [isVoiceActive, setIsVoiceActive] = createSignal(false);
  const [showAttachments, setShowAttachments] = createSignal(false);
  const [screenOpen, setScreenOpen] = createSignal(false);
  const [pickerQuery, setPickerQuery] = createSignal("");
  const [activePickerOption, setActivePickerOption] = createSignal(0);
  const filteredPickerBots = createMemo(() => {
    const query = pickerQuery().trim().toLowerCase();
    return query
      ? props.bots.filter((bot) => `${bot.name} ${bot.role}`.toLowerCase().includes(query))
      : props.bots;
  });
  let scrollElement: HTMLDivElement | undefined;
  let browserSurface: HTMLDivElement | undefined;
  let browserResizeObserver: ResizeObserver | undefined;
  let pickerRoot: HTMLDivElement | undefined;
  let pickerInput: HTMLInputElement | undefined;

  function scrollToLatest() {
    requestAnimationFrame(() => {
      if (scrollElement) scrollElement.scrollTop = scrollElement.scrollHeight;
    });
  }

  onMount(() => {
    scrollToLatest();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setScreenOpen(false);
      props.onCloseAgentPicker();
    };
    const closePickerOutside = (event: PointerEvent) => {
      if (
        props.agentPickerOpen &&
        pickerRoot &&
        event.target instanceof Node &&
        !pickerRoot.contains(event.target)
      ) {
        props.onCloseAgentPicker();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closePickerOutside);
    onCleanup(() => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closePickerOutside);
    });
  });
  createEffect(() => {
    props.bot?.id;
    props.messages.length;
    scrollToLatest();
  });

  createEffect(() => {
    if (!props.agentPickerOpen) return;
    setPickerQuery("");
    setActivePickerOption(0);
    setScreenOpen(false);
    requestAnimationFrame(() => pickerInput?.focus());
  });

  createEffect(() => {
    const visible = screenOpen();
    browserResizeObserver?.disconnect();
    browserResizeObserver = undefined;

    if (!visible) {
      void window.infeld.browser.setVisible({ visible: false });
      return;
    }

    requestAnimationFrame(() => {
      if (!browserSurface) return;
      const syncBounds = () => {
        if (!browserSurface) return;
        const bounds = browserSurface.getBoundingClientRect();
        void window.infeld.browser.setVisible({
          visible: true,
          bounds: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          },
        });
      };
      syncBounds();
      if (typeof ResizeObserver !== "undefined") {
        browserResizeObserver = new ResizeObserver(syncBounds);
        browserResizeObserver.observe(browserSurface);
      }
    });
  });

  onCleanup(() => {
    browserResizeObserver?.disconnect();
    void window.infeld.browser.setVisible({ visible: false });
  });

  function submitMessage() {
    if (!draft().trim()) return;
    props.onSendMessage(draft());
    setDraft("");
  }

  function handlePickerKeyDown(event: KeyboardEvent) {
    const optionCount = filteredPickerBots().length + 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActivePickerOption((current) => (current + 1) % optionCount);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActivePickerOption((current) => (current - 1 + optionCount) % optionCount);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const index = activePickerOption();
      if (index === 0) props.onCreateAgent();
      else {
        const bot = filteredPickerBots()[index - 1];
        if (bot) props.onSelectAgent(bot.id);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCloseAgentPicker();
    }
  }

  return (
    <main aria-label="Conversation" class="conversation-panel">
      <header class="window-drag conversation-header">
        <Show
          when={props.agentPickerOpen}
          fallback={
            <>
              <Show when={props.bot}>
                {(bot) => (
                  <button type="button" class="conversation-title no-drag">
                    <span class={`bot-avatar bot-avatar-${bot().accent}`}>
                      <GrokMark />
                    </span>
                    <h1>{bot().name}</h1>
                  </button>
                )}
              </Show>
              <button
                type="button"
                class="computer-button no-drag"
                onClick={() => setScreenOpen(true)}
              >
                <ComputerIcon />
                <span class="sr-only">Open computer</span>
              </button>
            </>
          }
        >
          <div class="agent-picker-root no-drag" ref={(element) => (pickerRoot = element)}>
            <label class="agent-recipient-field">
              <span>To:</span>
              <input
                ref={(element) => (pickerInput = element)}
                role="combobox"
                aria-label="To:"
                aria-expanded="true"
                aria-controls="agent-recipient-list"
                aria-activedescendant={`agent-picker-option-${activePickerOption()}`}
                placeholder="Search or create agents"
                value={pickerQuery()}
                onInput={(event) => {
                  setPickerQuery(event.currentTarget.value);
                  setActivePickerOption(0);
                }}
                onKeyDown={handlePickerKeyDown}
              />
            </label>
            <div id="agent-recipient-list" class="agent-picker-menu" role="listbox">
              <button
                id="agent-picker-option-0"
                type="button"
                role="option"
                aria-selected={activePickerOption() === 0}
                class="agent-picker-option agent-picker-create"
                classList={{ "agent-picker-option-active": activePickerOption() === 0 }}
                disabled={props.creatingAgent}
                onMouseEnter={() => setActivePickerOption(0)}
                onClick={props.onCreateAgent}
              >
                <span class="agent-picker-plus">
                  <PlusIcon />
                </span>
                <span>{props.creatingAgent ? "Creating agent…" : "Create new agent"}</span>
              </button>
              <For each={filteredPickerBots()}>
                {(bot, index) => {
                  const optionIndex = () => index() + 1;
                  return (
                    <button
                      id={`agent-picker-option-${optionIndex()}`}
                      type="button"
                      role="option"
                      aria-selected={activePickerOption() === optionIndex()}
                      class="agent-picker-option"
                      classList={{
                        "agent-picker-option-active": activePickerOption() === optionIndex(),
                      }}
                      onMouseEnter={() => setActivePickerOption(optionIndex())}
                      onClick={() => props.onSelectAgent(bot.id)}
                    >
                      <span class={`bot-avatar bot-avatar-${bot.accent}`}>
                        <GrokMark />
                      </span>
                      <span>{bot.name}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>
      </header>

      <div class="conversation-scroll" ref={(element) => (scrollElement = element)}>
        <Show when={!props.agentPickerOpen}>
          <div class="time-marker">
            <span>{props.messages[0]?.time ?? "now"}</span>
          </div>
          <For each={props.messages}>
            {(message, index) => (
              <article
                class="message-entry"
                classList={{
                  "message-entry-user": message.author === "you",
                  "message-entry-bot": message.author === "bot",
                  "message-entry-system": message.kind === "routine",
                }}
                style={{ "animation-delay": `${Math.min(index() * 45, 500)}ms` }}
              >
                <Show
                  when={message.kind !== "routine"}
                  fallback={
                    <MessageBody message={message} onOpenScreen={() => setScreenOpen(true)} />
                  }
                >
                  <div class={message.author === "you" ? "user-bubble" : "bot-bubble"}>
                    <MessageBody message={message} onOpenScreen={() => setScreenOpen(true)} />
                  </div>
                </Show>
              </article>
            )}
          </For>
        </Show>
      </div>

      <div class="composer-wrap">
        <Show when={showAttachments()}>
          <div class="attachment-menu">
            <button type="button">Upload file</button>
            <button type="button">Add from computer</button>
          </div>
        </Show>
        <div class="composer" classList={{ "composer-recording": isVoiceActive() }}>
          <button
            type="button"
            class="composer-button"
            aria-label="Attach a file"
            disabled={props.agentPickerOpen}
            onClick={() => setShowAttachments((value) => !value)}
          >
            <PlusIcon />
          </button>
          <label class="composer-input-label">
            <span class="sr-only">Message {props.bot?.name}</span>
            <textarea
              rows="1"
              value={draft()}
              disabled={props.agentPickerOpen}
              placeholder={`Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`}
              aria-label={`Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitMessage();
                }
              }}
            />
          </label>
          <Show
            when={props.activeTurnId}
            fallback={
              <button
                type="button"
                class="voice-button"
                classList={{ "voice-button-active": isVoiceActive() }}
                aria-label="Voice message"
                aria-pressed={isVoiceActive()}
                disabled={props.agentPickerOpen}
                onClick={() => setIsVoiceActive((value) => !value)}
              >
                <VoiceIcon />
              </button>
            }
          >
            <button
              type="button"
              class="voice-button voice-button-active"
              aria-label="Stop agent"
              onClick={props.onStop}
            >
              <CloseIcon />
            </button>
          </Show>
        </div>
      </div>

      <Show when={screenOpen()}>
        <div class="screen-backdrop" role="presentation">
          <button
            type="button"
            class="screen-dismiss"
            aria-label="Close screen backdrop"
            onClick={() => setScreenOpen(false)}
          />
          <section
            class="screen-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${props.bot?.name}'s screen`}
          >
            <button
              type="button"
              class="screen-close"
              aria-label="Close screen"
              onClick={() => setScreenOpen(false)}
            >
              <CloseIcon />
            </button>
            <div class="screen-terminal" ref={(element) => (browserSurface = element)}>
              <div class="screen-window-toolbar">
                <i />
                <i />
                <i />
              </div>
              <div class="screen-window-body">
                <aside class="screen-window-sidebar">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </aside>
                <div class="screen-window-content">
                  <div class="screen-content-toolbar">
                    <span />
                    <i />
                    <i />
                  </div>
                  <div class="screen-queue">
                    <strong>Outreach queue</strong>
                    <span>
                      <b />
                      Priya Natarajan
                      <i />
                    </span>
                    <span>
                      <b />
                      Marcus Webb
                      <i />
                    </span>
                    <span>
                      <b />
                      Elena Sørensen
                      <i />
                    </span>
                    <span>
                      <b />
                      Daniel Alvarez
                      <i />
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div class="screen-dock">
              <span>↗</span>
              <span>◉</span>
            </div>
          </section>
        </div>
      </Show>
    </main>
  );
}
