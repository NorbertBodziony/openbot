import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DirectConversationSnapshot, DirectMessage, TeamPresenceMember } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { TypingDots } from "../../components/TypingDots";
import {
  Bubble,
  BubbleContent,
  Button,
  Message,
  MessageContent,
  MessageFooter,
  MessageGroup,
  Textarea,
} from "../../components/ui";
import { TeamPersonAvatar, teamMemberName } from "../team/TeamPersonAvatar";
import { calculateChatScrollMargin, createChatVirtualizer } from "./createChatVirtualizer";
import { ScrollToLatestButton, scrollToLatestMessage } from "./MessageNavigation";
import {
  scrollToUnreadBoundary,
  UnreadMessagesBanner,
  UnreadMessagesDivider,
  unreadMessagesDividerIsVisible,
} from "./UnreadMessages";

interface DirectConversationProps {
  member: TeamPresenceMember;
  currentMemberId: string;
  snapshot: DirectConversationSnapshot | undefined;
  loading: boolean;
  loadError: string | null;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  olderError?: string | null;
  typing: boolean;
  onSend: (text: string, clientMessageId: string) => Promise<{ message: DirectMessage; readError?: string }>;
  onMarkRead: () => Promise<void>;
  onLoadOlder?: () => void;
  onOpenMessage?: (messageId: string) => Promise<void>;
  onTypingChange: (typing: boolean) => void;
}

export function DirectConversation(props: DirectConversationProps) {
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [markingRead, setMarkingRead] = createSignal(false);
  const [showScrollToLatest, setShowScrollToLatest] = createSignal(false);
  const [unreadDividerVisible, setUnreadDividerVisible] = createSignal(false);
  const [virtualScrollMargin, setVirtualScrollMargin] = createSignal(0);
  let messageList: HTMLDivElement | undefined;
  let virtualRoot: HTMLDivElement | undefined;
  let unreadMessagesDivider: HTMLDivElement | undefined;
  let unreadVisibilityFrame: number | undefined;
  let currentUnreadCount = 0;
  let typingIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let stickToLatest = true;
  let lastThreadId: string | undefined;
  const messageVirtualizer = createChatVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: () => props.snapshot?.messages.length ?? 0,
    getScrollElement: () => messageList ?? null,
    estimateSize: () => 56,
    getItemKey: (index) => props.snapshot?.messages[index]?.id ?? index,
    keyVersion: () => {
      const messages = props.snapshot?.messages;
      return `${messages?.[0]?.id ?? ""}:${messages?.at(-1)?.id ?? ""}`;
    },
    scrollMargin: virtualScrollMargin,
    onChange: (instance) => {
      const first = instance.getVirtualItems()[0];
      if (first && first.index <= 5 && props.hasOlder && !props.loadingOlder) props.onLoadOlder?.();
    },
  });
  const virtualMessageRows = createMemo(() => messageVirtualizer.getVirtualItems());
  const unreadBannerReady = (): boolean => {
    const unreadMessageId = props.snapshot?.readState?.firstUnreadMessageId;
    if (!unreadMessageId) return true;
    const unreadIndex = props.snapshot?.messages.findIndex((message) => message.id === unreadMessageId) ?? -1;
    if (unreadIndex < 0) return true;
    return messageVirtualizer.getVirtualItems().some((item) => item.index === unreadIndex);
  };

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
        updateVirtualScrollMargin();
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
    const resizeObserver = new ResizeObserver(() => {
      updateVirtualScrollMargin();
      updateUnreadDividerVisibility();
    });
    if (messageList) resizeObserver.observe(messageList);
    if (virtualRoot) resizeObserver.observe(virtualRoot);
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

  function updateVirtualScrollMargin(): void {
    setVirtualScrollMargin(calculateChatScrollMargin(messageList, virtualRoot));
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

  async function jumpToUnreadMessages(): Promise<void> {
    if (!messageList) return;
    const firstUnreadMessageId = props.snapshot?.readState?.firstUnreadMessageId;
    if (!unreadMessagesDivider && firstUnreadMessageId && props.onOpenMessage) {
      await props.onOpenMessage(firstUnreadMessageId);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (!unreadMessagesDivider) return;
    const divider = unreadMessagesDivider;
    const firstUnreadMessage = divider.nextElementSibling instanceof HTMLElement ? divider.nextElementSibling : divider;
    scrollToUnreadBoundary(messageList, firstUnreadMessage);
    await markUnreadMessages();
    requestAnimationFrame(() => {
      if (!messageList) return;
      const settledBoundary = divider.isConnected ? divider : firstUnreadMessage;
      if (settledBoundary.isConnected) {
        scrollToUnreadBoundary(messageList, settledBoundary);
      }
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

      <Show when={(props.snapshot?.readState?.unreadCount ?? 0) > 0 && !unreadDividerVisible() && unreadBannerReady()}>
        <UnreadMessagesBanner
          count={props.snapshot?.readState?.unreadCount ?? 0}
          busy={markingRead()}
          onJumpToUnread={jumpToUnreadMessages}
          onMarkRead={() => void markUnreadMessages()}
        />
      </Show>

      <div
        ref={(element) => {
          messageList = element;
          updateVirtualScrollMargin();
        }}
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
              <Show when={props.loadingOlder || props.olderError}>
                <div class="conversation-history-status" role={props.olderError ? "alert" : "status"}>
                  <Show when={props.olderError} fallback="Loading older messages…">
                    <span>{props.olderError}</span>
                    <Button type="button" variant="ghost" size="xs" onClick={() => props.onLoadOlder?.()}>
                      Retry
                    </Button>
                  </Show>
                </div>
              </Show>
              <MessageGroup
                ref={(element) => {
                  virtualRoot = element;
                  updateVirtualScrollMargin();
                }}
                class={["virtual-chat-list", { "virtual-chat-list-static": !messageVirtualizer.isVirtualized() }]}
                style={{
                  height: messageVirtualizer.isVirtualized() ? `${messageVirtualizer.getTotalSize()}px` : "auto",
                }}
              >
                <For each={virtualMessageRows()}>
                  {(virtualRow) => {
                    const message = props.snapshot?.messages[virtualRow.index];
                    if (!message) return null;
                    const own = () => message.senderMemberId === props.currentMemberId;
                    const previous = () => props.snapshot?.messages[virtualRow.index - 1];
                    // The unread boundary keeps the full entry gap so its divider stays legible.
                    const grouped = () =>
                      previous()?.senderMemberId === message.senderMemberId &&
                      message.id !== props.snapshot?.readState?.firstUnreadMessageId;
                    return (
                      <div
                        data-index={virtualRow.index}
                        data-grouped={grouped() ? "sender" : undefined}
                        ref={messageVirtualizer.measureElement}
                        class="virtual-chat-row"
                        style={{
                          transform: messageVirtualizer.isVirtualized()
                            ? `translateY(${virtualRow.start - messageVirtualizer.scrollMargin()}px)`
                            : "none",
                        }}
                      >
                        <Show when={message.id === props.snapshot?.readState?.firstUnreadMessageId}>
                          <UnreadMessagesDivider
                            elementRef={(element) => {
                              unreadMessagesDivider = element;
                              scheduleUnreadDividerVisibilityUpdate();
                            }}
                          />
                        </Show>
                        <Message
                          role="article"
                          align={own() ? "end" : "start"}
                          class={["direct-message", { own: own() }]}
                          data-author={own() ? "user" : "member"}
                          aria-label={`${own() ? "You" : teamMemberName(props.member)} at ${messageTime(message.createdAt)}`}
                        >
                          <MessageContent>
                            <Bubble
                              align={own() ? "end" : "start"}
                              variant={own() ? "secondary" : "muted"}
                              data-author={own() ? "user" : "member"}
                            >
                              <BubbleContent>{message.text}</BubbleContent>
                            </Bubble>
                            <MessageFooter>
                              <time datetime={message.createdAt}>{messageTime(message.createdAt)}</time>
                            </MessageFooter>
                          </MessageContent>
                        </Message>
                      </div>
                    );
                  }}
                </For>
              </MessageGroup>
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
            onValueChange={updateText}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
              event.preventDefault();
              void send();
            }}
          />
          <Button
            variant="default"
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
