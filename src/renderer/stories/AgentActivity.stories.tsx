import { createSignal, onSettled } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AgentActivityIndicator, ThinkingDisclosure } from "../src/components/conversation/AgentActivity";
import { STORY_BOTS } from "./fixtures";

const indicatorMeta = {
  title: "Conversation/AgentActivityIndicator",
  component: AgentActivityIndicator,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AgentActivityIndicator>;

export default indicatorMeta;
type IndicatorStory = StoryObj<typeof indicatorMeta>;

export const Working: IndicatorStory = {
  args: {
    bot: STORY_BOTS[0],
    presentation: { animation: "orbit", label: "Connecting the dots…" },
  },
};

export const Playful: IndicatorStory = {
  args: {
    bot: STORY_BOTS[1],
    presentation: { animation: "comet", label: "Tiny gears are turning…" },
  },
};

export const TransitionLoop: IndicatorStory = {
  args: {
    bot: STORY_BOTS[0],
    presentation: { animation: "wide", label: "Putting the answer together…" },
  },
  render: (args) => {
    const [phase, setPhase] = createSignal<"active" | "exiting">("active");
    onSettled(() => {
      const timer = window.setInterval(
        () => setPhase((current) => (current === "active" ? "exiting" : "active")),
        1_400,
      );
      return () => window.clearInterval(timer);
    });
    return <AgentActivityIndicator {...args} phase={phase()} />;
  },
};

const THINKING_STEPS = [
  "Summer demand spikes for stone-fruit flavors — peach and apricot lead.",
  "I should check cone inventory before promoting a waffle-bowl special.",
  "Joy Cone ships in two days, so the special can start on Friday.",
];

/* Streaming: the header shimmers while the answer is still coming. */
export const ThinkingLive: IndicatorStory = {
  args: {
    bot: STORY_BOTS[0],
    presentation: { animation: "thinking", label: "Thinking it through…" },
  },
  render: () => {
    const [open, setOpen] = createSignal<boolean | undefined>(undefined);
    return (
      <ThinkingDisclosure
        message={{
          id: "thinking-live",
          author: "bot",
          body: "",
          time: "10:00",
          kind: "thinking",
          streaming: true,
          items: THINKING_STEPS,
        }}
        working={true}
        open={open()}
        onOpenChange={setOpen}
      />
    );
  },
};

/* Settled: the trace collapses and reopens on demand. */
export const ThinkingDetails: IndicatorStory = {
  args: {
    bot: STORY_BOTS[0],
    presentation: { animation: "thinking", label: "Thinking it through…" },
  },
  render: () => {
    const [open, setOpen] = createSignal<boolean | undefined>(undefined);
    return (
      <ThinkingDisclosure
        message={{
          id: "thinking-story",
          author: "bot",
          body: "",
          time: "10:00",
          kind: "thinking",
          items: THINKING_STEPS,
        }}
        working={false}
        open={open()}
        onOpenChange={setOpen}
      />
    );
  },
};
