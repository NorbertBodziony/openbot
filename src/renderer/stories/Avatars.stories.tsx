import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AgentAvatar } from "../src/components/AgentAvatar";
import { TeamPersonAvatar } from "../src/components/TeamPersonAvatar";
import { STORY_BOTS, STORY_PRESENCE } from "./fixtures";

const agentMeta = {
  title: "Identity/AgentAvatar",
  component: AgentAvatar,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AgentAvatar>;

export default agentMeta;
type AgentStory = StoryObj<typeof agentMeta>;

export const Generated: AgentStory = {
  args: { bot: STORY_BOTS[0], motion: "hover" },
};

export const Thinking: AgentStory = {
  args: { bot: STORY_BOTS[1], motion: "always", class: "size-12" },
};

export const CustomImageFallback: AgentStory = {
  args: { bot: { ...STORY_BOTS[2], avatarUrl: "mock-avatar://missing" } },
};

export const PersonAvatars: AgentStory = {
  render: () => (
    <div class="flex items-center gap-4">
      {STORY_PRESENCE.members.slice(0, 3).map((member) => (
        <TeamPersonAvatar member={member} large />
      ))}
    </div>
  ),
};
