import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DirectConversationSnapshot, DirectMessage, TeamPresenceMember } from "@openbot/contracts/ipc";
import { createEffect, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { ScrollToLatestButton, scrollToLatestMessage } from "./conversation/MessageNavigation";
import {
  scrollToUnreadBoundary,
  UnreadMessagesBanner,
  UnreadMessagesDivider,
  unreadMessagesDividerIsVisible,
} from "./conversation/UnreadMessages";
import { TeamPersonAvatar, teamMemberName } from "./TeamPersonAvatar";
import { TypingDots } from "./TypingDots";
import { Button, Textarea } from "./ui";

interface DirectConversationProps {
  member: TeamPresenceMember;
  currentMemberId: string;
  snapshot: DirectConversationSnapshot | undefined;
  loading: boolean;
  loadError: string | null;
  typing: boolean;
  onSend: (text: string, clientMessageId: string) => Promise<{ message: DirectMessage; readError?: string }>;
  onMarkRead: () => Promise<void>;
  onTypingChange: (typing: boolean) => void;
}

export function DirectConversation(props: DirectConversationProps) {
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [markingRead, setMarkingRead] = createSignal(false);
  const [showScrollToLatest, setShowScrollToLatest] = createSignal(false);
  const [unreadDividerVisible, setUnreadDividerVisible] = createSignal(false);
  let messageList: HTMLDivElement | undefined;
  let unreadMessagesDivider: HTMLDivElement | undefined;
  let unreadVisibilityFrame: number | undefined;
  let currentUnreadCount = 0;
  let typingIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let stickToLatest = true;
  let lastThreadId: string | undefined;

  createEffect(
    () => ({
      threadId: props.snapshot?.threadId,
      revision: props.snapshot?.revision ?? -1,
      messageCount: props.snapshot?.messages.length ?? 0,
      unreadCount: props.snapshot?.readState?.unreadCount ?? 0,
    }),
    ({ threadId, unreadCount }) => {
      currentUnreadCount = unreadCount;
      if (threadId !== lastThreadId) {
        lastThreadId = threadId;
        stickToLatest = true;
      }
      requestAnimationFrame(() => {
        if (!messageList) return;
        if (stickToLatest) messageList.scrollTop = messageList.scrollHeight;
        updateScrollState(messageList);
        updateUnreadDividerVisibility();
      });
    },
  );

  onCleanup(() => {
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    if (unreadVisibilityFrame !== undefined) cancelAnimationFrame(unreadVisibilityFrame);
    props.onTypingChange(false);
  });

  onSettled(() => {
    const resizeObserver = new ResizeObserver(updateUnreadDividerVisibility);
    if (messageList) resizeObserver.observe(messageList);
    return () => resizeObserver.disconnect();
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

  function updateScrollState(element: HTMLElement): void {
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    setShowScrollToLatest(remaining > 80);
  }

  function updateUnreadDividerVisibility(): void {
    setUnreadDividerVisible(
      Boolean(
        currentUnreadCount > 0 &&
          messageList &&
          unreadMessagesDivider &&
          unreadMessagesDividerIsVisible(messageList, unreadMessagesDivider),
      ),
    );
  }

  function scheduleUnreadDividerVisibilityUpdate(): void {
    if (unreadVisibilityFrame !== undefined) cancelAnimationFrame(unreadVisibilityFrame);
    unreadVisibilityFrame = requestAnimationFrame(() => {
      unreadVisibilityFrame = undefined;
      updateUnreadDividerVisibility();
    });
  }

  async function send(): Promise<void> {
    const body = text().trim();
    if (!body || sending()) return;
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    props.onTypingChange(false);
    setSending(true);
    setError(null);
    try {
      const result = await props.onSend(body, crypto.randomUUID());
      setText("");
      if (result.readError) setError(result.readError);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message was not sent.");
    } finally {
      setSending(false);
    }
  }

  async function markUnreadMessages(): Promise<void> {
    if (markingRead()) return;
    setMarkingRead(true);
    setError(null);
    try {
      await props.onMarkRead();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not mark messages as read.");
    } finally {
      setMarkingRead(false);
    }
  }

  function jumpToUnreadMessages(): void {
    if (!messageList || !unreadMessagesDivider) return;
    const divider = unreadMessagesDivider;
    const firstUnreadMessage = divider.nextElementSibling instanceof HTMLElement ? divider.nextElementSibling : divider;
    scrollToUnreadBoundary(messageList, firstUnreadMessage);
    void markUnreadMessages().then(() => {
      requestAnimationFrame(() => {
        if (!messageList) return;
        const settledBoundary = divider.isConnected ? divider : firstUnreadMessage;
        if (settledBoundary.isConnected) {
          scrollToUnreadBoundary(messageList, settledBoundary);
        }
      });
    });
  }

  function jumpToLatestMessage(): void {
    if (!messageList) return;
    stickToLatest = true;
    scrollToLatestMessage(messageList);
  }

  return (
    <main class="direct-conversation" aria-label={`Direct conversation with ${teamMemberName(props.member)}`}>
      <header class="window-drag direct-conversation-header">
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

      <Show when={(props.snapshot?.readState?.unreadCount ?? 0) > 0 && !unreadDividerVisible()}>
        <UnreadMessagesBanner
          count={props.snapshot?.readState?.unreadCount ?? 0}
          busy={markingRead()}
          onJumpToUnread={jumpToUnreadMessages}
          onMarkRead={() => void markUnreadMessages()}
        />
      </Show>

      <div
        ref={(element) => (messageList = element)}
        class="direct-message-list"
        role="log"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
          updateScrollState(element);
          updateUnreadDividerVisibility();
        }}
      >
        <Show when={showScrollToLatest()}>
          <ScrollToLatestButton onClick={jumpToLatestMessage} />
        </Show>
        <Show when={!props.loading} fallback={<div class="direct-conversation-state">Loading messages…</div>}>
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
                    <>
                      <Show when={message.id === props.snapshot?.readState?.firstUnreadMessageId}>
                        <UnreadMessagesDivider
                          elementRef={(element) => {
                            unreadMessagesDivider = element;
                            scheduleUnreadDividerVisibilityUpdate();
                          }}
                        />
                      </Show>
                      <article
                        class={["direct-message", { own: own(), grouped: grouped() }]}
                        aria-label={`${own() ? "You" : teamMemberName(props.member)} at ${messageTime(message.createdAt)}`}
                      >
                        <div>
                          <p>{message.text}</p>
                          <time datetime={message.createdAt}>{messageTime(message.createdAt)}</time>
                        </div>
                      </article>
                    </>
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
          <Textarea
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
          <Button
            type="button"
            aria-label="Send direct message"
            disabled={!text().trim() || sending()}
            onClick={() => void send()}
          >
            {sending() ? "…" : "↑"}
          </Button>
        </div>
      </div>
    </main>
  );
}

function messageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}
