import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  DirectConversationSnapshot,
  DirectMessage,
  TeamPresenceMember,
} from "@openbot/contracts/ipc";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { SidebarToggleIcon } from "./Sidebar";
import { TeamPersonAvatar, teamMemberName } from "./TeamPersonAvatar";
import { TypingDots } from "./TypingDots";

interface DirectConversationProps {
  member: TeamPresenceMember;
  currentMemberId: string;
  snapshot: DirectConversationSnapshot | undefined;
  loading: boolean;
  loadError: string | null;
  typing: boolean;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebar: () => void;
  onSend: (text: string, clientMessageId: string) => Promise<DirectMessage>;
  onTypingChange: (typing: boolean) => void;
}

export function DirectConversation(props: DirectConversationProps) {
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let messageList: HTMLDivElement | undefined;
  let typingIdleTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(
    () => [props.snapshot?.revision, props.snapshot?.messages.length],
    () => {
      requestAnimationFrame(() => {
        if (messageList) messageList.scrollTop = messageList.scrollHeight;
      });
    },
  );

  onCleanup(() => {
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    props.onTypingChange(false);
  });

  function updateText(value: string): void {
    setText(value);
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    if (!value.trim()) {
      props.onTypingChange(false);
      return;
    }
    props.onTypingChange(true);
    typingIdleTimer = setTimeout(() => props.onTypingChange(false), 3_000);
  }

  async function send(): Promise<void> {
    const body = text().trim();
    if (!body || sending()) return;
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    props.onTypingChange(false);
    setSending(true);
    setError(null);
    try {
      await props.onSend(body, crypto.randomUUID());
      setText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message was not sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main
      class="direct-conversation"
      aria-label={`Direct conversation with ${teamMemberName(props.member)}`}
    >
      <header class="window-drag direct-conversation-header">
        <Show when={props.leftSidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label="Show sidebar"
            aria-controls="bot-sidebar"
            aria-expanded="false"
            onClick={props.onToggleLeftSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
        <div class="direct-conversation-person no-drag">
          <TeamPersonAvatar member={props.member} />
          <div>
            <h1>{teamMemberName(props.member)}</h1>
            <span class={props.member.online ? "online" : undefined}>
              <i aria-hidden="true" />
              {props.member.online ? "Online" : "Offline"}
            </span>
          </div>
        </div>
        <span class="direct-private-label no-drag">
          <LockIcon /> Private
        </span>
      </header>

      <div ref={(element) => (messageList = element)} class="direct-message-list" role="log">
        <Show
          when={!props.loading}
          fallback={<div class="direct-conversation-state">Loading messages…</div>}
        >
          <Show
            when={!props.loadError}
            fallback={
              <div class="direct-conversation-state" role="alert">
                <strong>The messages could not load.</strong>
                <span>{props.loadError}</span>
              </div>
            }
          >
            <Show
              when={(props.snapshot?.messages.length ?? 0) > 0}
              fallback={
                <div class="direct-conversation-empty">
                  <TeamPersonAvatar member={props.member} large />
                  <h2>Message {teamMemberName(props.member)}</h2>
                  <p>This is a private conversation between the two of you.</p>
                </div>
              }
            >
              <For each={props.snapshot?.messages ?? []}>
                {(message, index) => {
                  const own = () => message.senderMemberId === props.currentMemberId;
                  const previous = () => props.snapshot?.messages[index() - 1];
                  const grouped = () => previous()?.senderMemberId === message.senderMemberId;
                  return (
                    <article
                      class={["direct-message", { own: own(), grouped: grouped() }]}
                      aria-label={`${own() ? "You" : teamMemberName(props.member)} at ${messageTime(message.createdAt)}`}
                    >
                      <Show when={!own() && !grouped()}>
                        <TeamPersonAvatar member={props.member} />
                      </Show>
                      <div>
                        <p>{message.text}</p>
                        <time datetime={message.createdAt}>{messageTime(message.createdAt)}</time>
                      </div>
                    </article>
                  );
                }}
              </For>
            </Show>
          </Show>
        </Show>
      </div>

      <div class="direct-composer-wrap">
        <Show when={props.typing}>
          <div class="direct-typing-indicator" role="status" aria-live="polite">
            <TypingDots class="team-typing-dots" />
            {teamMemberName(props.member)} is typing
          </div>
        </Show>
        <Show when={error()}>{(message) => <p class="direct-message-error">{message()}</p>}</Show>
        <div class="direct-composer">
          <textarea
            value={text()}
            rows="1"
            maxlength={INPUT_LIMITS.directMessageText}
            aria-label={`Message ${teamMemberName(props.member)}`}
            placeholder={`Message ${teamMemberName(props.member)}`}
            disabled={sending()}
            onInput={(event) => updateText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
              event.preventDefault();
              void send();
            }}
          />
          <button
            type="button"
            aria-label="Send direct message"
            disabled={!text().trim() || sending()}
            onClick={() => void send()}
          >
            {sending() ? "…" : "↑"}
          </button>
        </div>
      </div>
    </main>
  );
}

function messageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}
