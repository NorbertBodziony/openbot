import { createMemo, For, Loading, lazy, Show, untrack } from "solid-js";
import type { AgentMessage, ChatActionMarkerModel } from "../../data";
import { BrowserTakeoverCard } from "../ConversationPrompts";
import type { ConversationProps } from "../ConversationView";
import { Bubble, BubbleContent, BubbleReactions, type BubbleVariant, Button, Message, MessageContent } from "../ui";
import { AgentActivityIndicator, ThinkingDisclosure } from "./AgentActivity";
import { AttachmentCards } from "./AttachmentCards";
import { ChatActionMarker } from "./ChatActionMarker";
import { ChatSearch } from "./ChatSearch";
import { useConversationViewScope } from "./conversation-scope";
import { messageContentBlocks } from "./DataTable";
import { ScrollToLatestButton } from "./MessageNavigation";
import { MessageActions, MessageBody } from "./MessageRendering";
import { UnreadMessagesBanner, UnreadMessagesDivider } from "./UnreadMessages";

function conversationBubbleVariant(message: AgentMessage): BubbleVariant {
  if (message.author === "you") return "secondary";
  if (message.imageGeneration || (!message.body.trim() && message.attachments?.length)) return "ghost";
  const contentBlocks = messageContentBlocks(message.body, message.streaming === true);
  if (contentBlocks.some((block) => block.type === "table" || block.type === "comparison-table")) return "muted";
  return contentBlocks.some((block) => block.type !== "text") ? "ghost" : "muted";
}

/** A message that renders only an action marker, with no bubble of its own. */
function markerOnlyMessage(message: AgentMessage): boolean {
  const marker = message.actionMarker;
  if (!marker) return false;
  return (
    Boolean(message.exchange) ||
    !message.routine ||
    marker.kind === "routine-lifecycle" ||
    marker.kind === "unavailable"
  );
}

/** Marker-only rows that render attachment cards below the marker do not end with one. */
function markerRowEndsWithMarker(message: AgentMessage): boolean {
  if (!markerOnlyMessage(message)) return false;
  return !(message.exchange?.direction === "incoming" && (message.attachments?.length ?? 0) > 0);
}

function routineMarkerAvailable(
  marker: ChatActionMarkerModel,
  availableRoutineIds: readonly string[] | undefined,
): boolean {
  if (!("routineId" in marker)) return true;
  if (marker.kind === "routine-lifecycle" && marker.action === "deleted") return false;
  return availableRoutineIds?.includes(marker.routineId) === true;
}

/** @internal Stable HMR boundary for conversation timeline. */
export function ConversationTimeline() {
  const {
    activeChatSearchIndex,
    agentActivitySpaceReserved,
    agentReady,
    attachmentAction,
    browserTakeoverPreview,
    browserTakeoverResolution,
    browserTakeoverTab,
    chatSearchMatches,
    chatSearchOpen,
    chatSearchQuery,
    chatSearchTotal,
    closeChatSearch,
    copiedMessageId,
    copyMessage,
    expandedEmojiMessageId,
    expandedThinkingMessages,
    installedSkills,
    scrollFades,
    jumpToLatestMessage,
    jumpToUnreadMessages,
    markMessageSeen,
    markUnreadMessages,
    markingRead,
    messageVirtualizer,
    moveChatSearch,
    openExternalMessageUrl,
    openMoreMessageId,
    openReactionMessageId,
    openRoutineSettings,
    openSharedFile,
    openWorkspaceFile,
    previewAttachment,
    props,
    reactToMessage,
    renderedAgentActivity,
    respondToBrowserTakeover,
    replyToMessage,
    scheduleUnreadDividerVisibilityUpdate,
    setChatSearchQuery,
    setComposerError,
    setExpandedEmojiMessageId,
    setExpandedThinkingMessages,
    setOpenMoreMessageId,
    setOpenReactionMessageId,
    showScrollToLatest,
    unreadDividerVisible,
    updateScrollFade,
    updateUnreadDividerVisibility,
    setAgentActivitySlotElement,
    setChatSearchInputElement,
    setScrollElement,
    setStickToLatest,
    setUnreadMessagesDividerElement,
    setVirtualRootElement,
  } = useConversationViewScope();
  const virtualMessageRows = createMemo(() => messageVirtualizer.getVirtualItems());
  let cachedPrompt: { key: string; prompt: NonNullable<ConversationProps["prompt"]> } | null = null;
  const keyedPrompt = createMemo(() => {
    const prompt = props.prompt;
    if (!prompt) {
      cachedPrompt = null;
      return null;
    }
    const key = JSON.stringify([prompt.turnId, String(prompt.requestId)]);
    if (cachedPrompt?.key === key) return cachedPrompt;
    cachedPrompt = { key, prompt };
    return cachedPrompt;
  });
  return (
    <>
      <Show when={chatSearchOpen()}>
        <ChatSearch
          query={chatSearchQuery()}
          current={activeChatSearchIndex()}
          total={props.onSearchMessages ? chatSearchTotal() : chatSearchMatches().length}
          inputRef={setChatSearchInputElement}
          onQueryChange={setChatSearchQuery}
          onPrevious={() => moveChatSearch(-1)}
          onNext={() => moveChatSearch(1)}
          onClose={closeChatSearch}
        />
      </Show>

      <Show when={props.unreadCount > 0 && !unreadDividerVisible()}>
        <UnreadMessagesBanner
          count={props.unreadCount}
          busy={markingRead()}
          onJumpToUnread={jumpToUnreadMessages}
          onMarkRead={() => void markUnreadMessages()}
        />
      </Show>

      <div
        class={["conversation-scroll", scrollFades.classes()]}
        ref={setScrollElement}
        onScroll={(event) => {
          const element = event.currentTarget;
          setStickToLatest(element.scrollHeight - element.scrollTop - element.clientHeight <= 80);
          updateScrollFade(element);
          updateUnreadDividerVisibility();
        }}
      >
        <Show when={showScrollToLatest() || props.discontinuous}>
          <ScrollToLatestButton onClick={() => void jumpToLatestMessage()} />
        </Show>
        <Show when={props.loaded}>
          <Show when={!agentReady()}>
            <section class="agent-setup-card" role="status">
              <div>
                <strong>
                  {props.agentStatus.phase === "starting" || props.agentStatus.phase === "restarting"
                    ? "Connecting to agent CLIs…"
                    : "Agent CLI setup required"}
                </strong>
                <p>
                  {props.agentStatus.message ??
                    "Install and sign in to Codex CLI, Claude CLI, or Grok CLI, then restart OpenBot."}
                </p>
              </div>
              <Show when={props.agentStatus.phase !== "starting" && props.agentStatus.phase !== "restarting"}>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() =>
                    void props
                      .onOpenAgentSetup()
                      .catch((error) => setComposerError(error instanceof Error ? error.message : String(error)))
                  }
                >
                  Setup guide
                </Button>
              </Show>
            </section>
          </Show>
          <Show when={props.messages.length > 0}>
            <div class="time-marker">
              <span>{props.messages[0]?.time ?? "now"}</span>
            </div>
          </Show>
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
          <div
            ref={setVirtualRootElement}
            class={["virtual-chat-list", { "virtual-chat-list-static": !messageVirtualizer.isVirtualized() }]}
            style={{ height: messageVirtualizer.isVirtualized() ? `${messageVirtualizer.getTotalSize()}px` : "auto" }}
          >
            <For each={virtualMessageRows()}>
              {(virtualRow) => {
                const message = createMemo(() => props.messages[virtualRow.index]);
                const initialMessage = untrack(message);
                if (!initialMessage) return null;
                const animateEntrance = initialMessage.animate === true && markMessageSeen(initialMessage.id);
                const initialActionMarker = initialMessage.actionMarker;
                const markerOnly = markerOnlyMessage(initialMessage);
                // Consecutive markers keep the tighter marker gap so they read as one group.
                const groupedWithMarker = createMemo(() => {
                  const current = message();
                  if (!current?.actionMarker) return false;
                  if (current.id === props.firstUnreadMessageId) return false;
                  const previous = props.messages[virtualRow.index - 1];
                  return previous !== undefined && markerRowEndsWithMarker(previous);
                });
                if (markerOnly) {
                  return (
                    <div
                      data-index={virtualRow.index}
                      data-grouped={groupedWithMarker() ? "marker" : undefined}
                      ref={messageVirtualizer.measureElement}
                      class="virtual-chat-row"
                      style={{
                        transform: messageVirtualizer.isVirtualized()
                          ? `translateY(${virtualRow.start - messageVirtualizer.scrollMargin()}px)`
                          : "none",
                      }}
                    >
                      <Show when={message()?.id === props.firstUnreadMessageId}>
                        <UnreadMessagesDivider
                          elementRef={(element) => {
                            setUnreadMessagesDividerElement(element);
                            scheduleUnreadDividerVisibilityUpdate();
                          }}
                        />
                      </Show>
                      <article
                        data-chat-search-message={message()?.id}
                        class={{ "chat-action-entry-animated": animateEntrance }}
                      >
                        <Show when={message()?.actionMarker ?? initialActionMarker}>
                          {(marker) => (
                            <ChatActionMarker
                              marker={marker()}
                              agents={props.agents}
                              announce={animateEntrance}
                              routineAvailable={routineMarkerAvailable(marker(), props.availableRoutineIds)}
                              onSelectAgent={props.onSelectAgent}
                              onOpenRoutine={openRoutineSettings}
                              onOpenHostedSite={(url) => void openExternalMessageUrl(url)}
                            />
                          )}
                        </Show>
                        <Show
                          when={
                            initialMessage.exchange?.direction === "incoming" &&
                            (message()?.attachments?.length ?? 0) > 0
                          }
                        >
                          <div class="chat-action-attachments">
                            <AttachmentCards
                              attachments={message()?.attachments ?? []}
                              onPreview={(attachment) => void previewAttachment(attachment)}
                              onAction={attachmentAction}
                            />
                          </div>
                        </Show>
                      </article>
                    </div>
                  );
                }
                const displayedReactions = createMemo(() => {
                  const currentMessage = message();
                  if (currentMessage?.reactions?.length) return currentMessage.reactions;
                  if (currentMessage?.reaction) {
                    return [{ emoji: currentMessage.reaction, actor: { kind: "user" as const } }];
                  }
                  return (currentMessage?.reactionSummary?.emojis ?? []).map((emoji) => ({
                    emoji,
                    actor: { kind: "user" as const },
                  }));
                });
                return (
                  <div
                    data-index={virtualRow.index}
                    data-grouped={groupedWithMarker() ? "marker" : undefined}
                    ref={messageVirtualizer.measureElement}
                    class="virtual-chat-row"
                    style={{
                      transform: messageVirtualizer.isVirtualized()
                        ? `translateY(${virtualRow.start - messageVirtualizer.scrollMargin()}px)`
                        : "none",
                    }}
                  >
                    <Show when={message()?.id === props.firstUnreadMessageId}>
                      <UnreadMessagesDivider
                        elementRef={(element) => {
                          setUnreadMessagesDividerElement(element);
                          scheduleUnreadDividerVisibilityUpdate();
                        }}
                      />
                    </Show>
                    <Show
                      when={message()?.questionPrompt}
                      fallback={
                        <Show
                          when={message()?.kind === "thinking"}
                          fallback={
                            <>
                              <Show when={message()?.routine && message()?.actionMarker}>
                                {(marker) => (
                                  <ChatActionMarker
                                    marker={marker()}
                                    agents={props.agents}
                                    announce={animateEntrance}
                                    routineAvailable={routineMarkerAvailable(marker(), props.availableRoutineIds)}
                                    onSelectAgent={props.onSelectAgent}
                                    onOpenRoutine={openRoutineSettings}
                                    onOpenHostedSite={(url) => void openExternalMessageUrl(url)}
                                  />
                                )}
                              </Show>
                              <Message
                                role="article"
                                align={message()?.author === "you" ? "end" : "start"}
                                data-chat-search-message={message()?.id}
                                data-author={message()?.author === "you" ? "user" : "assistant"}
                                class={[
                                  "message-entry",
                                  {
                                    "message-entry-animated": animateEntrance,
                                    "message-entry-user": message()?.author === "you",
                                    "message-entry-bot": message()?.author === "agent",
                                  },
                                ]}
                              >
                                <MessageContent>
                                  <div class="message-shell">
                                    <Bubble
                                      align={message()?.author === "you" ? "end" : "start"}
                                      variant={conversationBubbleVariant(message() ?? initialMessage)}
                                      data-author={message()?.author === "you" ? "user" : "assistant"}
                                      data-streaming={message()?.streaming === true ? "" : undefined}
                                    >
                                      <BubbleContent>
                                        <MessageBody
                                          message={message() ?? initialMessage}
                                          referencedMessage={
                                            props.messages.find(
                                              (candidate) => candidate.id === message()?.replyToMessageId,
                                            ) ??
                                            (message()?.replyToMessageId
                                              ? props.messageReferences?.[message()?.replyToMessageId ?? ""]
                                              : undefined)
                                          }
                                          agents={props.agents}
                                          skills={installedSkills()}
                                          onSelectAgent={props.onSelectAgent}
                                          onOpenLink={(url) => void openExternalMessageUrl(url)}
                                          onPreview={(attachment) => void previewAttachment(attachment)}
                                          onAttachmentAction={attachmentAction}
                                          onOpenSharedFile={openSharedFile}
                                          onOpenWorkspaceFile={openWorkspaceFile}
                                          onDownload={(attachment) => attachmentAction(attachment, "download")}
                                        />
                                      </BubbleContent>
                                      <Show when={displayedReactions().length > 0}>
                                        <BubbleReactions
                                          class="message-reaction-anchor"
                                          align={message()?.author === "you" ? "start" : "end"}
                                          overflowCount={message()?.reactionSummary?.overflowCount}
                                          role="group"
                                          aria-label={`Reactions: ${displayedReactions()
                                            .map((reaction) => reaction.emoji)
                                            .join(", ")}`}
                                        >
                                          <For each={displayedReactions()}>
                                            {(reaction) => (
                                              <Show
                                                when={reaction.actor.kind === "user"}
                                                fallback={
                                                  <span
                                                    class="message-reaction-pill message-reaction-pill-readonly"
                                                    role="img"
                                                    aria-label={`${
                                                      props.agents.find(
                                                        (agent) =>
                                                          reaction.actor.kind === "agent" &&
                                                          agent.id === reaction.actor.agentId,
                                                      )?.name ?? "Agent"
                                                    } reacted with ${reaction.emoji}`}
                                                  >
                                                    <span aria-hidden="true">{reaction.emoji}</span>
                                                  </span>
                                                }
                                              >
                                                <Button
                                                  variant="ghost"
                                                  type="button"
                                                  class="message-reaction-pill"
                                                  aria-label={`Remove your reaction ${reaction.emoji}`}
                                                  onClick={() => {
                                                    const currentMessage = message();
                                                    if (currentMessage) void reactToMessage(currentMessage, null);
                                                  }}
                                                >
                                                  <span aria-hidden="true">{reaction.emoji}</span>
                                                </Button>
                                              </Show>
                                            )}
                                          </For>
                                        </BubbleReactions>
                                      </Show>
                                    </Bubble>
                                    <MessageActions
                                      message={message() ?? initialMessage}
                                      pickerOpen={openReactionMessageId() === message()?.id}
                                      moreOpen={openMoreMessageId() === message()?.id}
                                      expandedEmoji={expandedEmojiMessageId() === message()?.id}
                                      copied={copiedMessageId() === message()?.id}
                                      onTogglePicker={() => {
                                        const messageId = message()?.id;
                                        if (!messageId) return;
                                        setOpenReactionMessageId((current) =>
                                          current === messageId ? null : messageId,
                                        );
                                        setOpenMoreMessageId(null);
                                        setExpandedEmojiMessageId(null);
                                      }}
                                      onToggleMore={() => {
                                        const messageId = message()?.id;
                                        if (!messageId) return;
                                        setOpenMoreMessageId((current) => (current === messageId ? null : messageId));
                                        setOpenReactionMessageId(null);
                                        setExpandedEmojiMessageId(null);
                                      }}
                                      onExpandEmoji={() => {
                                        const messageId = message()?.id;
                                        if (!messageId) return;
                                        setExpandedEmojiMessageId((current) =>
                                          current === messageId ? null : messageId,
                                        );
                                      }}
                                      onReact={(emoji) => {
                                        const currentMessage = message();
                                        if (currentMessage) void reactToMessage(currentMessage, emoji);
                                      }}
                                      onReply={() => {
                                        const currentMessage = message();
                                        if (currentMessage) replyToMessage(currentMessage);
                                      }}
                                      onCopy={() => {
                                        const currentMessage = message();
                                        if (currentMessage) void copyMessage(currentMessage);
                                      }}
                                    />
                                  </div>
                                </MessageContent>
                              </Message>
                            </>
                          }
                        >
                          <div
                            data-chat-search-message={message()?.id}
                            class={{ "thinking-entry-animated": animateEntrance }}
                          >
                            <ThinkingDisclosure
                              message={message() ?? initialMessage}
                              working={Boolean(props.activeTurnId && message()?.turnId === props.activeTurnId)}
                              open={expandedThinkingMessages()[`${props.agent?.id ?? ""}:${message()?.id ?? ""}`]}
                              onOpenChange={(open) => {
                                const key = `${props.agent?.id ?? ""}:${message()?.id ?? ""}`;
                                setExpandedThinkingMessages((current) =>
                                  current[key] === open ? current : { ...current, [key]: open },
                                );
                              }}
                            />
                          </div>
                        </Show>
                      }
                    >
                      {(questionPrompt) => (
                        <Show when={questionPrompt().resolution}>
                          {(resolution) => (
                            <article data-chat-search-message={message()?.id} class="question-prompt-history-entry">
                              <QuestionPromptBubble
                                questions={questionPrompt().questions}
                                resolution={resolution()}
                                onSubmit={async () => false}
                              />
                            </article>
                          )}
                        </Show>
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
          <div
            class="agent-activity-slot"
            data-reserved={agentActivitySpaceReserved() ? "true" : "false"}
            ref={setAgentActivitySlotElement}
          >
            <Show when={renderedAgentActivity()}>
              {(activity) => (
                <AgentActivityIndicator
                  agent={activity().agent}
                  detail={activity().detail}
                  presentation={activity().presentation}
                  phase={activity().phase}
                />
              )}
            </Show>
          </div>
          <Show when={keyedPrompt()} keyed>
            {(entry) => (
              <Loading>
                <QuestionPromptBubble
                  questions={entry.prompt.questions}
                  onSubmit={props.onAnswerPrompt}
                  onResolutionPresented={() =>
                    props.onPromptResolutionPresented?.(
                      entry.prompt.agentId,
                      entry.prompt.turnId,
                      entry.prompt.requestId,
                    )
                  }
                />
              </Loading>
            )}
          </Show>
          <Show when={props.approval}>
            {(approval) => (
              <Loading>
                <ApprovalCard
                  approval={approval()}
                  onApprove={() => props.onRespondToApproval("accept")}
                  onReject={() => props.onRespondToApproval("decline")}
                />
              </Loading>
            )}
          </Show>
          <Show when={props.browserTakeover}>
            <Loading>
              <BrowserTakeoverCard
                agentName={props.agent?.name ?? "the agent"}
                tab={browserTakeoverTab()}
                preview={browserTakeoverPreview().preview}
                previewStatus={browserTakeoverPreview().status}
                onComplete={() => respondToBrowserTakeover("complete")}
                onCancel={() => respondToBrowserTakeover("cancel")}
              />
            </Loading>
          </Show>
          <Show when={!props.browserTakeover && browserTakeoverResolution()}>
            {(resolution) => (
              <BrowserTakeoverCard
                agentName={props.agent?.name ?? "the agent"}
                tab={resolution().tab}
                preview={resolution().preview}
                previewStatus={resolution().previewStatus}
                decision={resolution().decision}
                onComplete={async () => false}
                onCancel={async () => false}
              />
            )}
          </Show>
        </Show>
      </div>
    </>
  );
}

const ApprovalCard = lazy(() => import("../ConversationPrompts").then((module) => ({ default: module.ApprovalCard })));
const QuestionPromptBubble = lazy(() =>
  import("../QuestionPromptBubble").then((module) => ({ default: module.QuestionPromptBubble })),
);
