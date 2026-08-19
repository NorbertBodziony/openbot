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
  args: { bot: STORY_BOTS[0], state: "Working" },
};

export const Queued: IndicatorStory = {
  args: { bot: STORY_BOTS[1], state: "Queued" },
};

export const Hidden: IndicatorStory = {
  args: { bot: STORY_BOTS[2], state: null },
};

export const ThinkingDetails: IndicatorStory = {
  args: { bot: STORY_BOTS[0], state: null },
  render: () => (
    <ThinkingDisclosure
      message={{
        id: "thinking-story",
        author: "bot",
        body: "",
        time: "10:00",
        kind: "thinking",
        items: ["Read the brief", "Compared owners", "Drafted next steps"],
      }}
    />
  ),
};
