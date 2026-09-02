import type { QueueDeliveryStatus } from "@openbot/contracts/ipc";
import { Dynamic } from "@solidjs/web";
import { For, Show } from "solid-js";
import { avatarHeadColor } from "../../bloub-avatar";
import type { BotProfile, ChatActionMarkerModel, ChatActionMarkerStatus } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import {
  Button,
  CalendarClock,
  CircleCheck,
  CirclePause,
  Clock3,
  DropdownMenu,
  Globe2,
  LoaderCircle,
  Marker,
  MarkerContent,
  MarkerIcon,
  MessageCircle,
  TriangleAlert,
  X,
} from "../ui";

interface ChatActionMarkerProps {
  marker: ChatActionMarkerModel;
  bots: BotProfile[];
  announce?: boolean;
  routineAvailable?: boolean;
  onOpenAgentThread: (selection: { agentId: string; messageId: string }) => void;
  onOpenRoutine?: (routine: { routineId: string; name: string }) => void;
  onOpenHostedSite?: (url: string) => void;
}

const STATUS_LABELS: Record<ChatActionMarkerStatus, string> = {
  queued: "Queued",
  "in-progress": "In progress",
  "needs-attention": "Needs attention",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  unavailable: "Unavailable",
};

export function ChatActionMarker(props: ChatActionMarkerProps) {
  const label = () => markerLabel(props.marker);
  return (
    <Marker
      class={`chat-action-marker chat-action-marker-${props.marker.kind}`}
      role={props.announce ? "status" : "group"}
      aria-live={props.announce ? "polite" : "off"}
      aria-label={markerAccessibleLabel(props.marker, props.bots)}
    >
      <MarkerContent class="chat-action-marker-content">
        <span class="chat-action-marker-label">{label()}</span>
        <Show when={props.marker.kind === "agent-message" && props.marker}>
          {(marker) => <AgentTarget marker={marker()} bots={props.bots} onOpenThread={props.onOpenAgentThread} />}
        </Show>
        <Show when={props.marker.kind === "routine-lifecycle" && props.marker}>
          {(marker) => (
            <RoutineTarget
              routineId={marker().routineId}
              routineName={marker().routineName}
              available={marker().action !== "deleted" && props.routineAvailable !== false}
              onOpenRoutine={props.onOpenRoutine}
            />
          )}
        </Show>
        <Show when={props.marker.kind === "routine-run" && props.marker}>
          {(marker) => (
            <RoutineTarget
              routineId={marker().routineId}
              routineName={marker().routineName}
              icon={statusIcon(routineMarkerStatus(marker().status))}
              status={routineMarkerStatus(marker().status)}
              available={props.routineAvailable !== false}
              onOpenRoutine={props.onOpenRoutine}
            />
          )}
        </Show>
        <Show when={props.marker.kind === "hosted-site" && props.marker}>
          {(marker) => <HostedSiteTarget marker={marker()} onOpenHostedSite={props.onOpenHostedSite} />}
        </Show>
        <time class="chat-action-marker-time" datetime={props.marker.timestamp}>
          {formatMarkerTime(props.marker.timestamp)}
        </time>
      </MarkerContent>
    </Marker>
  );
}

function HostedSiteTarget(props: {
  marker: Extract<ChatActionMarkerModel, { kind: "hosted-site" }>;
  onOpenHostedSite?: (url: string) => void;
}) {
  const name = () => props.marker.hostname ?? props.marker.title;
  const status = () => hostedSiteMarkerStatus(props.marker.status);
  const interactive = () =>
    props.marker.status === "succeeded" &&
    props.marker.action !== "delete" &&
    Boolean(props.marker.url) &&
    Boolean(props.onOpenHostedSite);
  const content = (
    <>
      <MarkerIcon>
        <Dynamic component={hostedSiteIcon(props.marker.status)} aria-hidden="true" />
      </MarkerIcon>
      <span class="chat-action-target-name">{name()}</span>
    </>
  );
  return (
    <Show
      when={interactive()}
      fallback={<span class={`chat-action-target chat-action-target-status-${status()}`}>{content}</span>}
    >
      <Button
        variant="ghost"
        type="button"
        class={`chat-action-target chat-action-target-status-${status()}`}
        aria-label={`Open site ${name()}`}
        onClick={() => {
          if (props.marker.url) props.onOpenHostedSite?.(props.marker.url);
        }}
      >
        {content}
      </Button>
    </Show>
  );
}

function AgentTarget(props: {
  marker: Extract<ChatActionMarkerModel, { kind: "agent-message" }>;
  bots: BotProfile[];
  onOpenThread: (selection: { agentId: string; messageId: string }) => void;
}) {
  const source = () => props.bots.find((bot) => bot.id === props.marker.sourceAgentId);
  const recipients = () => props.marker.targetDeliveries;
  const singleRecipient = () => {
    const delivery = recipients()[0];
    return delivery ? props.bots.find((bot) => bot.id === delivery.agentId) : undefined;
  };
  return (
    <Show
      when={props.marker.direction === "outgoing"}
      fallback={
        <AgentButton
          bot={source()}
          fallbackId={props.marker.sourceAgentId}
          messageId={props.marker.messageId}
          onOpenThread={props.onOpenThread}
        />
      }
    >
      <Show
        when={recipients().length > 1}
        fallback={
          <AgentButton
            bot={singleRecipient()}
            fallbackId={recipients()[0]?.agentId}
            messageId={props.marker.messageId}
            onOpenThread={props.onOpenThread}
          />
        }
      >
        <DropdownMenu.Root placement="bottom" gutter={8} modal={false}>
          <DropdownMenu.Trigger
            class="chat-action-target chat-action-agent-menu-trigger"
            style={agentTargetsStyle(
              recipients().map((delivery) => props.bots.find((bot) => bot.id === delivery.agentId)),
            )}
          >
            <span class="chat-action-avatar-stack" aria-hidden="true">
              <For each={recipients().slice(0, 3)}>
                {(delivery) => (
                  <AgentAvatar
                    bot={props.bots.find((bot) => bot.id === delivery.agentId)}
                    class="chat-action-agent-avatar"
                  />
                )}
              </For>
            </span>
            <span>{recipients().length} agents</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="chat-action-agent-menu">
            <For each={recipients()}>
              {(delivery) => {
                const bot = () => props.bots.find((candidate) => candidate.id === delivery.agentId);
                return (
                  <DropdownMenu.Item
                    class="chat-action-agent-menu-item"
                    disabled={!bot()}
                    onSelect={() =>
                      props.onOpenThread({ agentId: delivery.agentId, messageId: props.marker.messageId })
                    }
                  >
                    <AgentAvatar bot={bot()} class="chat-action-agent-avatar" />
                    <span>{bot()?.name ?? "Unavailable agent"}</span>
                    <span class="chat-action-agent-menu-status">{deliveryStatusLabel(delivery.status)}</span>
                  </DropdownMenu.Item>
                );
              }}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Show>
    </Show>
  );
}

function AgentButton(props: {
  bot: BotProfile | undefined;
  fallbackId: string | undefined;
  messageId: string;
  onOpenThread: (selection: { agentId: string; messageId: string }) => void;
}) {
  return (
    <Show
      when={props.bot}
      fallback={
        <span class="chat-action-target chat-action-target-unavailable" title={props.fallbackId}>
          <AgentAvatar class="chat-action-agent-avatar" />
          <span>Unavailable agent</span>
        </span>
      }
    >
      {(bot) => (
        <Button
          variant="ghost"
          type="button"
          class="chat-action-target"
          style={agentTargetStyle(bot())}
          aria-label={`Open message thread with ${bot().name}`}
          onClick={() => props.onOpenThread({ agentId: bot().id, messageId: props.messageId })}
        >
          <AgentAvatar bot={bot()} class="chat-action-agent-avatar" />
          <span>{bot().name}</span>
        </Button>
      )}
    </Show>
  );
}

function RoutineTarget(props: {
  routineId: string;
  routineName: string;
  icon?: ReturnType<typeof statusIcon>;
  status?: ChatActionMarkerStatus;
  available: boolean;
  onOpenRoutine?: (routine: { routineId: string; name: string }) => void;
}) {
  const interactive = () => props.available && Boolean(props.onOpenRoutine);
  const content = (
    <>
      <MarkerIcon>
        <Dynamic component={props.icon ?? CalendarClock} aria-hidden="true" />
      </MarkerIcon>
      <span class="chat-action-target-name">{props.routineName}</span>
    </>
  );
  return (
    <Show
      when={interactive()}
      fallback={
        <span
          class={`chat-action-target chat-action-target-unavailable${props.status ? ` chat-action-target-status-${props.status}` : ""}`}
        >
          {content}
          <span class="sr-only">Unavailable</span>
        </span>
      }
    >
      <Button
        variant="ghost"
        type="button"
        class={`chat-action-target${props.status ? ` chat-action-target-status-${props.status}` : ""}`}
        aria-label={`Open routine ${props.routineName}`}
        onClick={() => props.onOpenRoutine?.({ routineId: props.routineId, name: props.routineName })}
      >
        {content}
      </Button>
    </Show>
  );
}

function markerLabel(marker: ChatActionMarkerModel): string {
  if (marker.kind === "unavailable") return marker.label;
  if (marker.kind === "agent-message") return marker.direction === "outgoing" ? "Messaged" : "Message from";
  if (marker.kind === "routine-lifecycle") {
    return marker.action === "created"
      ? "Created routine"
      : marker.action === "updated"
        ? "Updated routine"
        : "Deleted routine";
  }
  if (marker.kind === "hosted-site") {
    if (marker.action === "publish") {
      if (marker.status === "running") return "Deploying site";
      if (marker.status === "succeeded") return "Published site";
      if (marker.status === "failed") return "Site deploy failed";
      if (marker.status === "interrupted") return "Site deploy interrupted";
      return "Site deploy cancelled";
    }
    if (marker.action === "replace") {
      if (marker.status === "running") return "Updating site";
      if (marker.status === "succeeded") return "Updated site";
      if (marker.status === "failed") return "Site update failed";
      if (marker.status === "interrupted") return "Site update interrupted";
      return "Site update cancelled";
    }
    if (marker.status === "running") return "Deleting site";
    if (marker.status === "succeeded") return "Deleted site";
    if (marker.status === "failed") return "Site deletion failed";
    if (marker.status === "interrupted") return "Site deletion interrupted";
    return "Site deletion cancelled";
  }
  if (marker.status === "queued") return "Invoked routine";
  if (marker.status === "running") return "Running routine";
  if (marker.status === "needs-attention") return "Routine needs attention";
  if (marker.status === "succeeded") return "Completed routine";
  if (marker.status === "failed") return "Routine failed";
  if (marker.status === "interrupted") return "Routine interrupted";
  return "Cancelled routine";
}

function agentTargetStyle(bot: BotProfile | undefined): string | undefined {
  return bot ? `--chat-action-agent-color: ${avatarHeadColor(bot.avatarSeed, bot.avatarHue)}` : undefined;
}

function agentTargetsStyle(bots: Array<BotProfile | undefined>): string | undefined {
  const colors = bots.flatMap((bot) => (bot ? [avatarHeadColor(bot.avatarSeed, bot.avatarHue)] : []));
  const mixedColor = colors.reduce<string | undefined>((mix, color, index) => {
    if (!mix) return color;
    const previousColorsWeight = Math.round((index / (index + 1)) * 10_000) / 100;
    return `color-mix(in oklab, ${mix} ${previousColorsWeight}%, ${color})`;
  }, undefined);
  return mixedColor ? `--chat-action-agent-color: ${mixedColor}` : undefined;
}

function markerAccessibleLabel(marker: ChatActionMarkerModel, bots: BotProfile[]): string {
  const label = markerLabel(marker);
  if (marker.kind === "unavailable") return label;
  if (marker.kind === "agent-message") {
    const agentLabel =
      marker.direction === "incoming"
        ? (bots.find((bot) => bot.id === marker.sourceAgentId)?.name ?? "Unavailable agent")
        : marker.targetDeliveries.length === 1
          ? (bots.find((bot) => bot.id === marker.targetDeliveries[0]?.agentId)?.name ?? "Unavailable agent")
          : `${marker.targetDeliveries.length} agents`;
    return `${label} ${agentLabel}, ${STATUS_LABELS[marker.status]}`;
  }
  if (marker.kind === "hosted-site") return `${label}, ${marker.hostname ?? marker.title}`;
  return `${label}, ${marker.routineName}`;
}

function hostedSiteMarkerStatus(
  status: Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["status"],
): ChatActionMarkerStatus {
  if (status === "running") return "in-progress";
  if (status === "succeeded") return "completed";
  return status;
}

function hostedSiteIcon(status: Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["status"]) {
  if (status === "running") return LoaderCircle;
  if (status === "succeeded") return Globe2;
  if (status === "failed") return X;
  return CirclePause;
}

function routineMarkerStatus(
  status: Extract<ChatActionMarkerModel, { kind: "routine-run" }>["status"],
): ChatActionMarkerStatus {
  if (status === "running") return "in-progress";
  if (status === "succeeded") return "completed";
  return status;
}

function deliveryStatusLabel(status: QueueDeliveryStatus): string {
  if (status === "starting" || status === "running") return "In progress";
  return STATUS_LABELS[status];
}

function statusIcon(status: ChatActionMarkerStatus) {
  if (status === "completed") return CircleCheck;
  if (status === "failed") return X;
  if (status === "cancelled" || status === "interrupted") return CirclePause;
  if (status === "partial" || status === "needs-attention" || status === "unavailable") return TriangleAlert;
  if (status === "in-progress") return LoaderCircle;
  if (status === "queued") return Clock3;
  return MessageCircle;
}

function formatMarkerTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}
