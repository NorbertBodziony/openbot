import type { StateId } from "@norbert_bodziony/bloub";
import { For } from "solid-js";
import type { BotMessage, BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { Button } from "../ui/button";
import { ChevronDown, Sparkles } from "../ui/icons";

export const AGENT_ACTIVITY_ANIMATIONS = [
  "thinking",
  "orbit",
  "comet",
  "swirl",
  "burst",
  "wide",
] as const satisfies readonly StateId[];

export const AGENT_ACTIVITY_LABELS = [
  "Working on it…",
  "Thinking it through…",
  "Connecting the dots…",
  "Checking the details…",
  "Putting the answer together…",
  "Making sense of it…",
  "One step at a time…",
  "Tiny gears are turning…",
  "Consulting the inner council…",
  "Cooking up something useful…",
] as const;

const FACTUAL_ACTIVITY_LABELS = AGENT_ACTIVITY_LABELS.slice(0, 7);
const PLAYFUL_ACTIVITY_LABELS = AGENT_ACTIVITY_LABELS.slice(7);

export interface AgentActivityPresentation {
  animation: (typeof AGENT_ACTIVITY_ANIMATIONS)[number];
  label: (typeof AGENT_ACTIVITY_LABELS)[number];
}

export function nextAgentActivityPresentation(
  previous?: AgentActivityPresentation,
  random: () => number = Math.random,
): AgentActivityPresentation {
  return {
    animation: pickDifferent(AGENT_ACTIVITY_ANIMATIONS, previous?.animation, random),
    label: pickActivityLabel(previous?.label, random),
  };
}

export function AgentActivityIndicator(props: {
  bot: BotProfile | undefined;
  detail?: string | null;
  presentation: AgentActivityPresentation;
  phase?: "active" | "exiting";
}) {
  const label = () => props.detail ?? props.presentation.label;
  return (
    <div class="agent-activity-entry" data-state={props.phase ?? "active"}>
      <span class="sr-only" role="status" aria-label={`${props.bot?.name ?? "Agent"} is working`} />
      <section class="agent-activity-content" aria-label="Current activity">
        <AgentAvatar
          bot={props.bot}
          url={null}
          motion="working"
          animationState={props.presentation.animation}
          class="agent-activity-avatar"
        />
        <span class="agent-activity-label">{label()}</span>
      </section>
    </div>
  );
}

function pickDifferent<T>(items: readonly T[], previous: T | undefined, random: () => number): T {
  const choices = previous === undefined ? items : items.filter((item) => item !== previous);
  const value = random();
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999_999) : 0;
  const selected = choices[Math.floor(normalized * choices.length)];
  if (selected === undefined) throw new Error("Agent activity options are empty.");
  return selected;
}

function pickActivityLabel(
  previous: AgentActivityPresentation["label"] | undefined,
  random: () => number,
): AgentActivityPresentation["label"] {
  const tone = random();
  const pool = Number.isFinite(tone) && tone >= 0.7 ? PLAYFUL_ACTIVITY_LABELS : FACTUAL_ACTIVITY_LABELS;
  return pickDifferent(pool, previous, random);
}

export function ThinkingDisclosure(props: {
  message: BotMessage;
  working: boolean;
  open: boolean | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const steps = () => props.message.items?.filter((item) => item.trim()) ?? [];
  /* Open while the agent reasons so the trace reads as it arrives, closed once it has answered —
     until the reader decides otherwise. */
  const expanded = () => props.open ?? props.working;
  return (
    <article class="thinking-entry">
      <div class="thinking-disclosure" data-expanded={expanded()}>
        <Button
          variant="ghost"
          size="xs"
          class="thinking-summary"
          aria-expanded={expanded() ? "true" : "false"}
          aria-label="Show thinking details"
          onClick={() => props.onOpenChange(!expanded())}
        >
          <Sparkles class="thinking-mark" aria-hidden="true" />
          <span class="thinking-label" role="status" data-working={props.working}>
            {props.working ? "Thinking" : "Thought it through"}
          </span>
          <ChevronDown class="thinking-chevron" aria-hidden="true" />
        </Button>
        <div class="thinking-panel" aria-hidden={expanded() ? undefined : "true"}>
          <div class="thinking-panel-clip">
            <div class="thinking-details">
              <For each={steps()}>
                {(item, index) => (
                  <p class="thinking-step" style={{ "--thinking-step-index": String(index()) }}>
                    {item}
                  </p>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
