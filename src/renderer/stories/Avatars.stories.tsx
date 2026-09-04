import { BloubBot, POSES, type StateId } from "@norbert_bodziony/bloub";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { bloubAvatarProfile } from "../src/bloub-avatar";
import { AgentAvatar } from "../src/components/AgentAvatar";
import { TeamPersonAvatar } from "../src/components/TeamPersonAvatar";
import { STORY_AGENTS, STORY_PRESENCE } from "./fixtures";

const agentMeta = {
  title: "Identity/AgentAvatar",
  component: AgentAvatar,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AgentAvatar>;

export default agentMeta;
type AgentStory = StoryObj<typeof agentMeta>;

export const Generated: AgentStory = {
  args: { agent: STORY_AGENTS[0], motion: "hover" },
};

export const Thinking: AgentStory = {
  args: { agent: STORY_AGENTS[1], motion: "always", class: "size-12" },
};

export const CustomImageFallback: AgentStory = {
  args: { agent: { ...STORY_AGENTS[2], avatarUrl: "mock-avatar://missing" } },
};

const AVATAR_SIZES = [16, 18, 24, 32, 36, 42, 62] as const;
const AVATAR_STATES = ["idle", "thinking", "wink", "orbit"] as const satisfies readonly StateId[];

export const SizesAndStates: AgentStory = {
  render: () => {
    const profile = bloubAvatarProfile("story-avatar", 215);
    return (
      <div
        class="grid gap-6 p-8"
        style={{ background: "var(--openbot-bg-canvas)", color: "var(--openbot-text-primary)" }}
      >
        {AVATAR_STATES.map((state) => (
          <section class="grid gap-3" aria-label={`${state} avatar sizes`}>
            <strong class="text-sm capitalize">{state}</strong>
            <div class="flex items-end gap-5">
              {AVATAR_SIZES.map((size) => (
                <div class="grid justify-items-center gap-2">
                  <span class="agent-avatar agent-avatar-bloub" style={{ width: `${size}px`, height: `${size}px` }}>
                    <BloubBot
                      size={100}
                      shape={profile.shape}
                      color={profile.color}
                      expression={profile.expression}
                      state={state}
                      frozenAt={POSES[state]}
                      ariaLabel={`${state} avatar at ${size} pixels`}
                      class="bloub-avatar-svg"
                    />
                  </span>
                  <small style={{ color: "var(--openbot-text-muted)" }}>{size}</small>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  },
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
