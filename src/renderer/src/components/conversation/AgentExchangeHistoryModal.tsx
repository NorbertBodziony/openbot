import type { AttachmentSummary, QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { createMemo, For, Show } from "solid-js";
import type { BotMessage, BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { CenterMorphModal } from "../CenterMorphModal";
import { MessageBody } from "./MessageRendering";

interface AgentExchangeHistoryModalProps {
  open: boolean;
  currentBot: BotProfile | undefined;
  agent: BotProfile | undefined;
  bots: BotProfile[];
  messages: BotMessage[];
  onOpenChange: (open: boolean) => void;
  onSelectAgent: (botId: string) => void;
  onOpenLink: (url: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal" | "download") => void;
  onOpenSharedFile?: (path: string) => void;
}

export function directAgentExchangeHistory(
  messages: BotMessage[],
  currentBotId: string | undefined,
  agentId: string | undefined,
): BotMessage[] {
  if (!currentBotId || !agentId) return [];
  return messages.filter((message) => {
    const exchange = message.exchange;
    if (exchange?.recipientBotIds.length !== 1) return false;
    const [recipientBotId] = exchange.recipientBotIds;
    return (
      (exchange.senderBotId === currentBotId && recipientBotId === agentId) ||
      (exchange.senderBotId === agentId && recipientBotId === currentBotId)
    );
  });
}

function deliveryStatus(message: BotMessage, recipientBotId: string | undefined): QueueDeliveryStatus | undefined {
  if (!recipientBotId) return undefined;
  return message.exchange?.deliveries.find((delivery) => delivery.recipientBotId === recipientBotId)?.status;
}

function statusLabel(status: QueueDeliveryStatus | undefined) {
  switch (status) {
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return "In progress";
    case "completed":
      return "Delivered";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return undefined;
  }
}

export function AgentExchangeHistoryModal(props: AgentExchangeHistoryModalProps) {
  const history = createMemo(() => directAgentExchangeHistory(props.messages, props.currentBot?.id, props.agent?.id));

  return (
    <CenterMorphModal
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={
        <span class="agent-exchange-history-title-copy">
          <AgentAvatar bot={props.agent} class="agent-exchange-history-title-avatar" />
          <span>Messages with {props.agent?.name ?? "agent"}</span>
        </span>
      }
      description={`Direct exchanges with ${props.currentBot?.name ?? "the current agent"}`}
      closeLabel="Close message history"
      class="agent-exchange-history-modal"
    >
      <div class="agent-exchange-history-list" role="log" aria-label="Direct message history">
        <Show
          when={history().length > 0}
          fallback={<p class="agent-exchange-history-empty">No direct messages between these agents yet.</p>}
        >
          <For each={history()}>
            {(message) => {
              const outgoing = () => message.exchange?.senderBotId === props.currentBot?.id;
              const sender = () => (outgoing() ? props.currentBot : props.agent);
              const recipientId = () => (outgoing() ? props.agent?.id : props.currentBot?.id);
              const status = () => statusLabel(deliveryStatus(message, recipientId()));
              const displayMessage = () => ({ ...message, author: outgoing() ? ("you" as const) : ("bot" as const) });
              return (
                <article
                  class={["agent-exchange-history-entry", { "agent-exchange-history-entry-outgoing": outgoing() }]}
                >
                  <div class="agent-exchange-history-meta">
                    <span class="agent-exchange-history-sender">
                      <AgentAvatar bot={sender()} class="agent-exchange-history-avatar" />
                      <strong>{sender()?.name ?? "Agent"}</strong>
                    </span>
                    <span class="agent-exchange-history-details">
                      <Show when={status()}>{(label) => <span>{label()}</span>}</Show>
                      <time datetime={message.time}>{message.time}</time>
                    </span>
                  </div>
                  <div class={outgoing() ? "user-bubble" : "bot-bubble"}>
                    <MessageBody
                      message={displayMessage()}
                      referencedMessage={props.messages.find((candidate) => candidate.id === message.replyToMessageId)}
                      bots={props.bots}
                      onSelectAgent={props.onSelectAgent}
                      onOpenLink={props.onOpenLink}
                      onPreview={props.onPreview}
                      onAttachmentAction={props.onAttachmentAction}
                      onOpenSharedFile={props.onOpenSharedFile}
                      onDownload={(attachment) => props.onAttachmentAction(attachment, "download")}
                    />
                  </div>
                </article>
              );
            }}
          </For>
        </Show>
      </div>
    </CenterMorphModal>
  );
}
