import type { DirectMessage } from "@openbot/contracts/ipc";
import { expect, fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { DirectConversation } from "../src/components/DirectConversation";
import { STORY_DIRECT_SNAPSHOTS, STORY_PRESENCE } from "./fixtures";

const member = STORY_PRESENCE.members[1];
const args: Parameters<typeof DirectConversation>[0] = {
  member,
  currentMemberId: "member-self",
  snapshot: STORY_DIRECT_SNAPSHOTS[member.id],
  loading: false,
  loadError: null,
  typing: false,
  onSend: async (text, clientMessageId): Promise<DirectMessage> => ({
    id: clientMessageId,
    threadId: "direct-alice",
    senderMemberId: "member-self",
    recipientMemberId: member.id,
    text,
    createdAt: "2026-08-19T10:00:00.000Z",
    sequence: 3,
  }),
  onTypingChange: fn(),
};

const meta = {
  title: "Team/DirectConversation",
  component: DirectConversation,
  args,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DirectConversation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {
  play: async ({ canvas, userEvent }) => {
    const input = canvas.getByRole("textbox", { name: "Message Alice Chen" });
    await userEvent.type(input, "I’ll review it now.");
    await userEvent.click(canvas.getByRole("button", { name: "Send direct message" }));
    await expect(input).toHaveValue("");
  },
};

export const Typing: Story = {
  args: { typing: true },
};

export const Loading: Story = {
  args: { snapshot: undefined, loading: true },
};

export const ErrorState: Story = {
  args: { snapshot: undefined, loadError: "The team server is temporarily unavailable." },
};
