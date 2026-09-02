import type { AttachmentSummary, InstalledSkill, MessageReaction } from "@openbot/contracts/ipc";
import { MESSAGE_REACTIONS, MORE_MESSAGE_REACTIONS } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type { BotMessage, BotProfile } from "../../data";
import { Button, DropdownMenu } from "../ui";
import { AttachmentCards } from "./AttachmentCards";
import { CodeBlock } from "./CodeBlock";
import { ComparisonTable } from "./ComparisonTable";
import { CheckIcon, CopyIcon, MoreIcon, PlusIcon, ReactionIcon, ReplyIcon } from "./ConversationIcons";
import { createSmoothHeightResize } from "./createSmoothHeightResize";
import { DataTable, type MessageContentBlock, messageContentBlocks } from "./DataTable";
import { messageFileReferences } from "./FileReference";
import { ImageGeneration } from "./ImageGeneration";
import { MarkdownInlineText, MarkdownMessageText } from "./MarkdownMessageText";
import { RichMessageText } from "./RichMessageText";
import { parseSelectionInstruction } from "./SelectionActions";

const STREAMING_TEXT_GAP_FALLBACK_MS = 60;
const STREAMING_WORD_WITH_SEPARATOR = /^(?:\s*(?:(?:#{1,6}|[-+*>]|\d+[.)])\s+)?\S+\s+)/u;

function nextStreamingText(current: string, target: string, streaming: boolean): string {
  if (!target.startsWith(current)) return target;
  const remaining = target.slice(current.length);
  if (!remaining) return current;
  const nextWord = remaining.match(STREAMING_WORD_WITH_SEPARATOR)?.[0];
  if (nextWord) return current + nextWord;
  return streaming ? current : target;
}

function prefersReducedStreamingMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function streamingTextGapMs(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--stream-gap").trim();
  if (!value) return STREAMING_TEXT_GAP_FALLBACK_MS;
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return STREAMING_TEXT_GAP_FALLBACK_MS;
  return value.endsWith("s") && !value.endsWith("ms") ? amount * 1000 : amount;
}

function createStreamingBody(message: () => BotMessage) {
  const initialMessage = untrack(message);
  const animateInitialText =
    initialMessage.author === "bot" &&
    initialMessage.streaming === true &&
    initialMessage.animate === true &&
    !prefersReducedStreamingMotion();
  let targetBody = initialMessage.body;
  let targetStreaming = initialMessage.author === "bot" && initialMessage.streaming === true;
  const [body, setBody] = createSignal(animateInitialText ? "" : initialMessage.body);
  const [animateTail, setAnimateTail] = createSignal(false);
  const [smoothHeight, setSmoothHeight] = createSignal(targetStreaming);
  let smoothingActive = targetStreaming;
  let revealTimer: number | undefined;
  let smoothHeightTimer: number | undefined;

  const clearRevealTimer = () => {
    if (revealTimer === undefined) return;
    window.clearTimeout(revealTimer);
    revealTimer = undefined;
  };
  const keepHeightSmoothingActive = () => {
    if (smoothHeightTimer !== undefined) window.clearTimeout(smoothHeightTimer);
    smoothHeightTimer = undefined;
    setSmoothHeight(true);
  };
  const settleHeightSmoothing = () => {
    if (smoothHeightTimer !== undefined) window.clearTimeout(smoothHeightTimer);
    smoothHeightTimer = window.setTimeout(() => {
      smoothHeightTimer = undefined;
      setSmoothHeight(false);
    }, streamingTextGapMs() * 2);
  };
  const scheduleReveal = () => {
    if (revealTimer !== undefined) return;
    revealTimer = window.setTimeout(() => {
      revealTimer = undefined;
      const current = untrack(body);
      const next = nextStreamingText(current, targetBody, targetStreaming);
      if (next === current) return;
      setAnimateTail(true);
      setBody(next);
      if (next !== targetBody) {
        scheduleReveal();
      } else if (!targetStreaming) {
        smoothingActive = false;
        settleHeightSmoothing();
      }
    }, streamingTextGapMs());
  };

  createEffect(
    () => ({
      body: message().body,
      streaming: message().author === "bot" && message().streaming === true,
    }),
    ({ body: nextBody, streaming }) => {
      targetBody = nextBody;
      targetStreaming = streaming;
      if (streaming) {
        smoothingActive = true;
        keepHeightSmoothingActive();
      }
      const current = untrack(body);
      if (prefersReducedStreamingMotion() || !nextBody.startsWith(current) || (!streaming && !smoothingActive)) {
        clearRevealTimer();
        setAnimateTail(false);
        setBody(nextBody);
        smoothingActive = false;
        settleHeightSmoothing();
        return;
      }
      if (current !== nextBody) {
        scheduleReveal();
      } else if (!streaming) {
        smoothingActive = false;
        settleHeightSmoothing();
      }
    },
  );
  onCleanup(() => {
    clearRevealTimer();
    if (smoothHeightTimer !== undefined) window.clearTimeout(smoothHeightTimer);
  });
  return { animateTail, body, smoothHeight };
}

export function MessageBody(props: {
  message: BotMessage;
  referencedMessage?: BotMessage;
  bots: BotProfile[];
  skills?: InstalledSkill[];
  onSelectAgent: (botId: string) => void;
  onOpenLink: (url: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal" | "download") => void;
  onOpenSharedFile?: (path: string) => void;
  onOpenWorkspaceFile?: (path: string) => void;
  onDownload?: (attachment: AttachmentSummary) => void;
}) {
  const streamingBody = createStreamingBody(() => props.message);
  const streamedBody = streamingBody.body;
  const selectionInstruction = createMemo(() =>
    props.message.author === "you" && props.message.replyToMessageId
      ? parseSelectionInstruction(props.message.body)
      : null,
  );
  const standaloneAttachments = createMemo(() => {
    const referencedIds = new Set(
      messageFileReferences(props.message.body, props.message.attachments ?? [])
        .filter((reference) => reference.kind === "attachment")
        .map((reference) => reference.attachment.id),
    );
    const generatedAttachmentId = props.message.imageGeneration ? props.message.attachments?.[0]?.id : undefined;
    return (props.message.attachments ?? []).filter(
      (attachment) => !referencedIds.has(attachment.id) && attachment.id !== generatedAttachmentId,
    );
  });
  const standaloneImageAttachments = createMemo(() =>
    props.message.author === "bot"
      ? standaloneAttachments().filter((attachment) => attachment.previewKind === "image")
      : [],
  );
  const standaloneFileAttachments = createMemo(() =>
    props.message.author === "bot"
      ? standaloneAttachments().filter((attachment) => attachment.previewKind !== "image")
      : standaloneAttachments(),
  );
  const contentBlocks = createMemo<MessageContentBlock[]>(() =>
    props.message.author === "bot"
      ? messageContentBlocks(streamedBody(), props.message.streaming === true)
      : [{ type: "text", text: selectionInstruction()?.instruction ?? props.message.body }],
  );
  const lastTextBlockIndex = createMemo(() => {
    const blocks = contentBlocks();
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blocks[index]?.type === "text") return index;
    }
    return -1;
  });
  let messageContentResize: HTMLDivElement | undefined;
  let messageContent: HTMLDivElement | undefined;
  createSmoothHeightResize({
    container: () => messageContentResize,
    content: () => messageContent,
    enabled: () => props.message.author === "bot" && streamingBody.smoothHeight(),
  });
  const renderMarkdownInline = (body: string) => (
    <MarkdownInlineText
      body={body}
      bots={props.bots}
      skills={props.skills}
      attachments={props.message.attachments}
      citations={props.message.citations}
      onSelectAgent={props.onSelectAgent}
      onOpenLink={props.onOpenLink}
      onOpenAttachment={(attachment) =>
        attachment.previewKind === "none" ? props.onAttachmentAction(attachment, "open") : props.onPreview(attachment)
      }
      onOpenSharedFile={props.onOpenSharedFile}
      onOpenWorkspaceFile={props.onOpenWorkspaceFile}
    />
  );

  return (
    <>
      <Show when={props.referencedMessage}>
        {(referenced) => (
          <div class="message-reply-context">
            <span>{referenced().author === "you" ? "You" : "Agent"}</span>
            <p>
              <RichMessageText
                body={referenced().body || "Attachment"}
                bots={props.bots}
                skills={props.skills}
                attachments={referenced().attachments}
                citations={referenced().citations}
                onSelectAgent={props.onSelectAgent}
                onOpenLink={props.onOpenLink}
                onOpenAttachment={(attachment) =>
                  attachment.previewKind === "none"
                    ? props.onAttachmentAction(attachment, "open")
                    : props.onPreview(attachment)
                }
                onOpenSharedFile={props.onOpenSharedFile}
                onOpenWorkspaceFile={props.onOpenWorkspaceFile}
                showCitationFooter={false}
              />
            </p>
          </div>
        )}
      </Show>
      <div class="message-content-resize" ref={(element) => (messageContentResize = element)}>
        <div class="message-content-blocks" ref={(element) => (messageContent = element)}>
          <Show when={props.message.author === "bot" ? streamedBody() : props.message.body}>
            <For each={contentBlocks()}>
              {(block, index) => {
                if (block.type === "comparison-table") {
                  return <ComparisonTable table={block} renderCell={renderMarkdownInline} />;
                }
                if (block.type === "table") return <DataTable table={block} renderCell={renderMarkdownInline} />;
                if (block.type === "code") {
                  return (
                    <CodeBlock
                      block={block}
                      streaming={props.message.streaming === true && index() === contentBlocks().length - 1}
                    />
                  );
                }
                if (props.message.author === "bot") {
                  return (
                    <div
                      class={`message-copy message-markdown${streamingBody.animateTail() ? " t-stream" : ""}`}
                      data-selection-message-id={props.message.streaming !== true ? props.message.id : undefined}
                    >
                      <MarkdownMessageText
                        body={block.text}
                        bots={props.bots}
                        skills={props.skills}
                        attachments={props.message.attachments}
                        citations={props.message.citations}
                        onSelectAgent={props.onSelectAgent}
                        onOpenLink={props.onOpenLink}
                        onOpenAttachment={(attachment) =>
                          attachment.previewKind === "none"
                            ? props.onAttachmentAction(attachment, "open")
                            : props.onPreview(attachment)
                        }
                        onOpenSharedFile={props.onOpenSharedFile}
                        onOpenWorkspaceFile={props.onOpenWorkspaceFile}
                        showCitationFooter={index() === lastTextBlockIndex()}
                        streaming={props.message.streaming === true && index() === contentBlocks().length - 1}
                        streamingTail={streamingBody.animateTail() && index() === lastTextBlockIndex()}
                      />
                    </div>
                  );
                }
                return (
                  <p class="message-copy">
                    <RichMessageText
                      body={block.text}
                      bots={props.bots}
                      skills={props.skills}
                      attachments={props.message.attachments}
                      citations={props.message.citations}
                      onSelectAgent={props.onSelectAgent}
                      onOpenLink={props.onOpenLink}
                      onOpenAttachment={(attachment) =>
                        attachment.previewKind === "none"
                          ? props.onAttachmentAction(attachment, "open")
                          : props.onPreview(attachment)
                      }
                      onOpenSharedFile={props.onOpenSharedFile}
                      onOpenWorkspaceFile={props.onOpenWorkspaceFile}
                    />
                  </p>
                );
              }}
            </For>
            <Show when={selectionInstruction()}>
              {(selection) => <blockquote class="message-selection-quote">{selection().quote}</blockquote>}
            </Show>
          </Show>
        </div>
      </div>
      <Show when={props.message.imageGeneration}>
        {(imageGeneration) => (
          <ImageGeneration
            status={imageGenerationStatus(props.message.streaming, props.message.status)}
            prompt={imageGeneration().prompt}
            resolution={imageGeneration().resolution}
            aspectRatio={imageGeneration().aspectRatio}
            attachment={props.message.attachments?.[0]}
            error={imageGeneration().error}
            onPreview={props.onPreview}
            onDownload={props.onDownload}
          />
        )}
      </Show>
      <Show when={standaloneImageAttachments().length > 0}>
        <div class="message-image-attachments">
          <For each={standaloneImageAttachments()}>
            {(attachment) => (
              <ImageGeneration
                presentation="attachment"
                status="completed"
                prompt={attachment.name}
                aspectRatio="square"
                attachment={attachment}
                onPreview={props.onPreview}
                onDownload={props.onDownload}
              />
            )}
          </For>
        </div>
      </Show>
      <Show
        when={props.message.status && !props.message.imageGeneration && props.message.itemType !== "agent_attachment"}
      >
        <div class="message-status">
          <span />
          {props.message.status}
        </div>
      </Show>
      <Show when={standaloneFileAttachments().length > 0}>
        <AttachmentCards
          attachments={standaloneFileAttachments()}
          onPreview={props.onPreview}
          onAction={props.onAttachmentAction}
        />
      </Show>
    </>
  );
}

function imageGenerationStatus(
  streaming: boolean | undefined,
  status: string | undefined,
): "generating" | "completed" | "failed" | "interrupted" {
  if (streaming || status === "streaming") return "generating";
  if (status === "Failed" || status === "failed") return "failed";
  if (status === "Stopped" || status === "interrupted") return "interrupted";
  return "completed";
}

export function MessageActions(props: {
  message: BotMessage;
  pickerOpen: boolean;
  moreOpen: boolean;
  expandedEmoji: boolean;
  copied: boolean;
  onTogglePicker: () => void;
  onToggleMore: () => void;
  onExpandEmoji: () => void;
  onReact: (emoji: MessageReaction | null) => void;
  onReply: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      class={["message-actions", { "message-actions-open": props.pickerOpen || props.moreOpen }]}
      role="toolbar"
      aria-label={`${props.message.author === "you" ? "User" : "Agent"} message actions`}
    >
      <div class="message-action-popover-anchor">
        <DropdownMenu.Root
          open={props.pickerOpen}
          onOpenChange={props.onTogglePicker}
          placement={props.message.author === "you" ? "top-end" : "top-start"}
          gutter={6}
          modal={false}
        >
          <DropdownMenu.Trigger class="message-action-button" aria-label="Add reaction">
            <ReactionIcon />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            class="reaction-picker"
            data-menu-layout="grid"
            aria-label="Choose a reaction"
            aria-hidden={props.pickerOpen ? undefined : "true"}
          >
            <div class="reaction-picker-row">
              <DropdownMenu.RadioGroup class="reaction-picker-options" value={props.message.reaction ?? ""}>
                <For each={MESSAGE_REACTIONS}>
                  {(emoji) => (
                    <DropdownMenu.RadioItem
                      value={emoji}
                      aria-label={`React with ${emoji}`}
                      onSelect={() => props.onReact(props.message.reaction === emoji ? null : emoji)}
                    >
                      {emoji}
                    </DropdownMenu.RadioItem>
                  )}
                </For>
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Item
                class="reaction-more-button"
                aria-label="More emoji"
                closeOnSelect={false}
                onSelect={props.onExpandEmoji}
              >
                <PlusIcon />
              </DropdownMenu.Item>
            </div>
            <Show when={props.expandedEmoji}>
              <div class="reaction-picker-row reaction-picker-more">
                <DropdownMenu.RadioGroup class="reaction-picker-options" value={props.message.reaction ?? ""}>
                  <For each={MORE_MESSAGE_REACTIONS}>
                    {(emoji) => (
                      <DropdownMenu.RadioItem
                        value={emoji}
                        aria-label={`React with ${emoji}`}
                        onSelect={() => props.onReact(props.message.reaction === emoji ? null : emoji)}
                      >
                        {emoji}
                      </DropdownMenu.RadioItem>
                    )}
                  </For>
                </DropdownMenu.RadioGroup>
              </div>
            </Show>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      <Button
        variant="ghost"
        type="button"
        class="message-action-button"
        aria-label={`Reply to ${props.message.author === "you" ? "User" : "Agent"} message`}
        onClick={props.onReply}
      >
        <ReplyIcon />
      </Button>
      <div class="message-action-popover-anchor">
        <DropdownMenu.Root
          open={props.moreOpen}
          onOpenChange={props.onToggleMore}
          placement="top-end"
          gutter={6}
          modal={false}
        >
          <DropdownMenu.Trigger class="message-action-button" aria-label="More message actions">
            <MoreIcon />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="message-more-menu" aria-hidden={props.moreOpen ? undefined : "true"}>
            <DropdownMenu.Item onSelect={props.onCopy}>
              {props.copied ? <CheckIcon /> : <CopyIcon />}
              <span>{props.copied ? "Copied" : "Copy"}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  );
}
