import { attachmentReferenceIds } from "@openbot/contracts/attachment-references";
import type { AttachmentSummary, MessageReaction } from "@openbot/contracts/ipc";
import { MESSAGE_REACTIONS, MORE_MESSAGE_REACTIONS } from "@openbot/contracts/ipc";
import { createMemo, createSignal, For, Show } from "solid-js";
import { avatarHeadColor } from "../../blobatar";
import type { BotMessage, BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { AttachmentCards } from "./AttachmentCards";
import { CheckIcon, CopyIcon, MoreIcon, PlusIcon, ReactionIcon, ReplyIcon } from "./ConversationIcons";
import { ImageGeneration } from "./ImageGeneration";
import { RichMessageText } from "./RichMessageText";

function ExchangeAgentAvatar(props: { bot: BotProfile | undefined }) {
  return <AgentAvatar bot={props.bot} class="exchange-agent-avatar" />;
}

function exchangeAgentStyle(bot: BotProfile | undefined): string | undefined {
  return bot ? `--exchange-agent-color: ${avatarHeadColor(bot.avatarSeed, bot.avatarHue)}` : undefined;
}

function exchangeAgentsStyle(bots: Array<BotProfile | undefined>): string | undefined {
  const colors = bots.flatMap((bot) => (bot ? [avatarHeadColor(bot.avatarSeed, bot.avatarHue)] : []));
  const mixedColor = colors.reduce<string | undefined>((mix, color, index) => {
    if (!mix) return color;
    const previousColorsWeight = Math.round((index / (index + 1)) * 10_000) / 100;
    return `color-mix(in oklab, ${mix} ${previousColorsWeight}%, ${color})`;
  }, undefined);
  return mixedColor ? `--exchange-agent-color: ${mixedColor}` : undefined;
}

export function ExchangeSystemRow(props: {
  message: BotMessage;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
}) {
  const [agentsOpen, setAgentsOpen] = createSignal(false);
  const exchange = () => props.message.exchange;
  const recipients = () => exchange()?.recipientBotIds ?? [];
  const sender = () => {
    const senderId = exchange()?.senderBotId;
    return props.bots.find((bot) => bot.id === senderId);
  };
  const singleRecipient = () => {
    const recipientId = recipients()[0];
    return recipientId ? props.bots.find((bot) => bot.id === recipientId) : undefined;
  };
  const agentCountLabel = () => `${recipients().length} agents`;

  return (
    <div class="exchange-system-row">
      <Show
        when={exchange()?.direction === "outgoing"}
        fallback={
          <>
            <span class="exchange-system-label">Message from</span>
            <button
              type="button"
              class="exchange-agent-trigger exchange-agent-trigger-incoming"
              style={exchangeAgentStyle(sender())}
              aria-label={`Open exchange with ${sender()?.name ?? exchange()?.senderBotId ?? "agent"}`}
              onClick={() => {
                const senderId = exchange()?.senderBotId;
                if (senderId) props.onSelectAgent(senderId);
              }}
            >
              <ExchangeAgentAvatar bot={sender()} />
              <span>{sender()?.name ?? exchange()?.senderBotId ?? "Agent"}</span>
            </button>
          </>
        }
      >
        <span class="exchange-system-label">Messaged</span>
        <Show
          when={recipients().length === 1}
          fallback={
            <div class="exchange-agent-picker">
              <button
                type="button"
                class="exchange-agent-trigger exchange-agent-trigger-outgoing"
                style={exchangeAgentsStyle(
                  recipients().map((recipientId) => props.bots.find((bot) => bot.id === recipientId)),
                )}
                aria-haspopup="menu"
                aria-expanded={agentsOpen() ? "true" : "false"}
                aria-label={`${agentCountLabel()}, show list`}
                onClick={() => setAgentsOpen((open) => !open)}
              >
                <span class="exchange-avatar-stack" aria-hidden="true">
                  <For each={recipients().slice(0, 3)}>
                    {(recipientId) => <ExchangeAgentAvatar bot={props.bots.find((bot) => bot.id === recipientId)} />}
                  </For>
                </span>
                <span>{agentCountLabel()}</span>
              </button>
              <Show when={agentsOpen()}>
                <div class="exchange-agent-menu" role="menu">
                  <For each={recipients()}>
                    {(recipientId) => {
                      const recipient = () => props.bots.find((bot) => bot.id === recipientId);
                      return (
                        <button
                          type="button"
                          role="menuitem"
                          class="exchange-agent-menu-item"
                          onClick={() => {
                            setAgentsOpen(false);
                            props.onSelectAgent(recipientId);
                          }}
                        >
                          <ExchangeAgentAvatar bot={recipient()} />
                          <span>{recipient()?.name ?? recipientId}</span>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
          }
        >
          <button
            type="button"
            class="exchange-agent-trigger exchange-agent-trigger-single"
            style={exchangeAgentStyle(singleRecipient())}
            aria-label={`Open exchange with ${singleRecipient()?.name ?? recipients()[0] ?? "agent"}`}
            title={singleRecipient()?.name ?? recipients()[0] ?? "Agent"}
            onClick={() => {
              const recipientId = recipients()[0];
              if (recipientId) props.onSelectAgent(recipientId);
            }}
          >
            <ExchangeAgentAvatar bot={singleRecipient()} />
            <span>{singleRecipient()?.name ?? recipients()[0] ?? "Agent"}</span>
          </button>
        </Show>
      </Show>
      <time datetime={props.message.time}>{props.message.time}</time>
    </div>
  );
}

export function MessageBody(props: {
  message: BotMessage;
  referencedMessage?: BotMessage;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
  onOpenLink: (url: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal" | "download") => void;
  onDownload?: (attachment: AttachmentSummary) => void;
  onRetry?: () => void;
}) {
  const standaloneAttachments = createMemo(() => {
    const referencedIds = attachmentReferenceIds(props.message.body);
    const generatedAttachmentId = props.message.imageGeneration ? props.message.attachments?.[0]?.id : undefined;
    return (props.message.attachments ?? []).filter(
      (attachment) => !referencedIds.has(attachment.id) && attachment.id !== generatedAttachmentId,
    );
  });

  return (
    <>
      <Show when={props.referencedMessage}>
        {(referenced) => (
          <div class="message-reply-context">
            <span>{referenced().author === "you" ? "You" : "Agent"}</span>
            <p>{referenced().body || "Attachment"}</p>
          </div>
        )}
      </Show>
      <Show when={props.message.body}>
        <p class="message-copy">
          <RichMessageText
            body={props.message.body}
            bots={props.bots}
            attachments={props.message.attachments}
            citations={props.message.citations}
            onSelectAgent={props.onSelectAgent}
            onOpenLink={props.onOpenLink}
            onOpenAttachment={(attachment) =>
              attachment.previewKind === "none"
                ? props.onAttachmentAction(attachment, "open")
                : props.onPreview(attachment)
            }
          />
        </p>
      </Show>
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
            onRetry={props.onRetry}
          />
        )}
      </Show>
      <Show when={props.message.status && !props.message.imageGeneration}>
        <div class="message-status">
          <span />
          {props.message.status}
        </div>
      </Show>
      <Show when={standaloneAttachments().length > 0}>
        <AttachmentCards
          attachments={standaloneAttachments()}
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
        <button
          type="button"
          class="message-action-button"
          aria-label="Add reaction"
          aria-expanded={props.pickerOpen ? "true" : "false"}
          onClick={props.onTogglePicker}
        >
          <ReactionIcon />
        </button>
        <Show when={props.pickerOpen}>
          <div class="reaction-picker" role="menu" aria-label="Choose a reaction">
            <div class="reaction-picker-row">
              <For each={MESSAGE_REACTIONS}>
                {(emoji) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={props.message.reaction === emoji ? "true" : "false"}
                    aria-label={`React with ${emoji}`}
                    onClick={() => props.onReact(props.message.reaction === emoji ? null : emoji)}
                  >
                    {emoji}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="reaction-more-button"
                aria-label="More emoji"
                aria-expanded={props.expandedEmoji ? "true" : "false"}
                onClick={props.onExpandEmoji}
              >
                <PlusIcon />
              </button>
            </div>
            <Show when={props.expandedEmoji}>
              <div class="reaction-picker-row reaction-picker-more">
                <For each={MORE_MESSAGE_REACTIONS}>
                  {(emoji) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={props.message.reaction === emoji ? "true" : "false"}
                      aria-label={`React with ${emoji}`}
                      onClick={() => props.onReact(props.message.reaction === emoji ? null : emoji)}
                    >
                      {emoji}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <button
        type="button"
        class="message-action-button"
        aria-label={`Reply to ${props.message.author === "you" ? "User" : "Agent"} message`}
        onClick={props.onReply}
      >
        <ReplyIcon />
      </button>
      <div class="message-action-popover-anchor">
        <button
          type="button"
          class="message-action-button"
          aria-label="More message actions"
          aria-expanded={props.moreOpen ? "true" : "false"}
          onClick={props.onToggleMore}
        >
          <MoreIcon />
        </button>
        <Show when={props.moreOpen}>
          <div class="message-more-menu" role="menu">
            <button type="button" role="menuitem" onClick={props.onCopy}>
              {props.copied ? <CheckIcon /> : <CopyIcon />}
              <span>{props.copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
