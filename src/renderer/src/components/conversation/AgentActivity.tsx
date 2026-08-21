import { For, Show } from "solid-js";
import type { BotMessage, BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { ChevronIcon, ThinkingIcon } from "./ConversationIcons";

export function AgentActivityIndicator(props: { bot: BotProfile | undefined; state: "Queued" | "Working" | null }) {
  return (
    <Show when={props.state !== null}>
      <div
        class="agent-activity-entry agent-activity-entry-visible"
        role="status"
        aria-label={`${props.bot?.name ?? "Agent"} is ${props.state?.toLowerCase()}`}
      >
        <Show
          when={props.state === "Working"}
          fallback={
            <>
              <AgentAvatar bot={props.bot} class="agent-activity-avatar" />
              <div class="agent-activity-bubble" aria-hidden="true">
                <span>{props.state}</span>
                <span class="agent-activity-dots">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </>
          }
        >
          <AgentAvatar bot={props.bot} url={null} motion="always" class="agent-activity-avatar" />
        </Show>
      </div>
    </Show>
  );
}

export function ThinkingDisclosure(props: { message: BotMessage }) {
  const stepCount = () => props.message.items?.length ?? 0;
  return (
    <article class="thinking-entry">
      <details class="thinking-disclosure">
        <summary aria-label="Show thinking details">
          <span class="thinking-mark" aria-hidden="true">
            <ThinkingIcon />
          </span>
          <span>Thinking</span>
          <Show when={props.message.streaming}>
            <span class="thinking-live-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </Show>
          <Show when={!props.message.streaming && stepCount() > 1}>
            <small>{stepCount()} steps</small>
          </Show>
          <span class="thinking-chevron" aria-hidden="true">
            <ChevronIcon />
          </span>
        </summary>
        <div class="thinking-details">
          <For each={props.message.items ?? []}>{(item) => <p>{item}</p>}</For>
        </div>
      </details>
    </article>
  );
}
