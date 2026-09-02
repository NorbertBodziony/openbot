import type { AttachmentSummary, InstalledSkill } from "@openbot/contracts/ipc";
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js";
import type { BotMessage, BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { Bubble, BubbleContent, Dialog, IconButton, X } from "../ui";
import { MessageBody } from "./MessageRendering";

interface AgentExchangeThreadModalProps {
  open: boolean;
  messageId: string | null;
  selectedAgent: BotProfile | undefined;
  currentBot: BotProfile | undefined;
  bots: BotProfile[];
  messages: BotMessage[];
  skills?: InstalledSkill[];
  onOpenChange: (open: boolean) => void;
  onSelectAgent: (botId: string) => void;
  onOpenLink: (url: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal" | "download") => void;
  onOpenSharedFile?: (path: string) => void;
  onOpenWorkspaceFile?: (path: string) => void;
}

export function exchangeThreadMessages(messages: BotMessage[], selectedMessageId: string | null): BotMessage[] {
  if (!selectedMessageId) return [];
  const exchangeMessages = messages.filter((message) => message.exchange);
  const byMessageId = new Map(
    exchangeMessages.flatMap((message) => (message.exchange ? [[message.exchange.messageId, message] as const] : [])),
  );
  if (!byMessageId.has(selectedMessageId)) return [];

  const includedIds = new Set<string>();
  let ancestorId: string | null = selectedMessageId;
  while (ancestorId && !includedIds.has(ancestorId)) {
    includedIds.add(ancestorId);
    ancestorId = byMessageId.get(ancestorId)?.exchange?.replyToMessageId ?? null;
  }

  let foundDescendant = true;
  while (foundDescendant) {
    foundDescendant = false;
    for (const message of exchangeMessages) {
      const exchange = message.exchange;
      if (!exchange || includedIds.has(exchange.messageId) || !exchange.replyToMessageId) continue;
      if (!includedIds.has(exchange.replyToMessageId)) continue;
      includedIds.add(exchange.messageId);
      foundDescendant = true;
    }
  }

  return exchangeMessages.filter((message) => includedIds.has(message.exchange?.messageId ?? ""));
}

export function AgentExchangeThreadModal(props: AgentExchangeThreadModalProps) {
  const thread = createMemo(() => exchangeThreadMessages(props.messages, props.messageId));
  let restoreTarget: HTMLElement | null = null;
  let restoreFrame: number | undefined;
  createEffect(
    () => props.open,
    (open, previousOpen) => {
      if (open) {
        restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return;
      }
      if (!previousOpen || !restoreTarget?.isConnected) return;
      const target = restoreTarget;
      restoreFrame = window.requestAnimationFrame(() => target.focus());
    },
  );
  onCleanup(() => {
    if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame);
  });
  const referencedMessage = (message: BotMessage) => {
    const replyToMessageId = message.exchange?.replyToMessageId;
    return replyToMessageId
      ? props.messages.find((candidate) => candidate.exchange?.messageId === replyToMessageId)
      : undefined;
  };

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="agent-exchange-thread-overlay" />
        <Dialog.Content as="section" class="agent-exchange-thread-modal">
          <header class="agent-exchange-thread-header">
            <div class="agent-exchange-thread-heading">
              <span class="agent-exchange-thread-title-copy">
                <AgentAvatar bot={props.selectedAgent} class="agent-exchange-thread-title-avatar" />
                <Dialog.Title>Agent message thread</Dialog.Title>
              </span>
              <Dialog.Description>
                Reply-linked messages involving {props.selectedAgent?.name ?? "the selected agent"}
              </Dialog.Description>
            </div>
            <IconButton label="Close message thread" variant="ghost" onClick={() => props.onOpenChange(false)}>
              <X aria-hidden="true" />
            </IconButton>
          </header>

          <div class="agent-exchange-thread-list" role="log" aria-label="Agent message thread">
            <Show
              when={thread().length > 0}
              fallback={<p class="agent-exchange-thread-empty">This message thread is not in the loaded history.</p>}
            >
              <For each={thread()}>
                {(message) => {
                  const sender = () => props.bots.find((bot) => bot.id === message.exchange?.senderBotId);
                  const fromCurrentAgent = () => message.exchange?.senderBotId === props.currentBot?.id;
                  return (
                    <article class="agent-exchange-thread-entry" data-align={fromCurrentAgent() ? "end" : "start"}>
                      <div class="agent-exchange-thread-meta">
                        <AgentAvatar bot={sender()} class="agent-exchange-thread-avatar" />
                        <strong>{sender()?.name ?? "Unavailable agent"}</strong>
                        <time datetime={message.createdAt ?? message.time}>{message.time}</time>
                      </div>
                      <Bubble align={fromCurrentAgent() ? "end" : "start"} variant="secondary">
                        <BubbleContent>
                          <MessageBody
                            message={{ ...message, author: "bot" }}
                            referencedMessage={referencedMessage(message)}
                            bots={props.bots}
                            skills={props.skills}
                            onSelectAgent={props.onSelectAgent}
                            onOpenLink={props.onOpenLink}
                            onPreview={props.onPreview}
                            onAttachmentAction={props.onAttachmentAction}
                            onOpenSharedFile={props.onOpenSharedFile}
                            onOpenWorkspaceFile={props.onOpenWorkspaceFile}
                            onDownload={(attachment) => props.onAttachmentAction(attachment, "download")}
                          />
                        </BubbleContent>
                      </Bubble>
                    </article>
                  );
                }}
              </For>
            </Show>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
