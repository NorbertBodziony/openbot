import type { DirectMessage } from "@openbot/contracts/ipc";
import { createEffect, createSignal } from "solid-js";
import { expect, fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { DirectConversation } from "../src/components/DirectConversation";
import { STORY_DIRECT_SNAPSHOTS, STORY_PRESENCE } from "./fixtures";

const member = STORY_PRESENCE.members[1];
const unreadDirectMessages: DirectMessage[] = [
  ...Array.from({ length: 12 }, (_, index): DirectMessage => {
    const own = index % 2 === 0;
    return {
      id: `direct-history-${index + 1}`,
      threadId: "direct-alice",
      senderMemberId: own ? "member-self" : member.id,
      recipientMemberId: own ? member.id : "member-self",
      text: `Historical launch note ${index + 1}: the owner, deadline, and review status are recorded here.`,
      createdAt: `2026-08-19T09:${String(10 + index).padStart(2, "0")}:00.000Z`,
      sequence: index + 1,
    };
  }),
  ...Array.from(
    { length: 12 },
    (_, index): DirectMessage => ({
      id: `direct-unread-${index + 1}`,
      threadId: "direct-alice",
      senderMemberId: member.id,
      recipientMemberId: "member-self",
      text: `New private update ${index + 1}: I checked the launch notes and added the decisions, owners, and next steps we still need to review together.`,
      createdAt: `2026-08-19T09:${String(30 + index).padStart(2, "0")}:00.000Z`,
      sequence: index + 13,
    }),
  ),
];
const args: Parameters<typeof DirectConversation>[0] = {
  member,
  currentMemberId: "member-self",
  snapshot: STORY_DIRECT_SNAPSHOTS[member.id],
  loading: false,
  loadError: null,
  typing: false,
  onSend: async (text, clientMessageId) => ({
    message: {
      id: clientMessageId,
      threadId: "direct-alice",
      senderMemberId: "member-self",
      recipientMemberId: member.id,
      text,
      createdAt: "2026-08-19T10:00:00.000Z",
      sequence: 3,
    },
  }),
  onMarkRead: async () => undefined,
  onTypingChange: fn(),
};

function StatefulDirectConversation(props: { args: Parameters<typeof DirectConversation>[0] }) {
  const [snapshot, setSnapshot] = createSignal<Parameters<typeof DirectConversation>[0]["snapshot"]>();
  createEffect(
    () => props.args.snapshot,
    (nextSnapshot) => {
      setSnapshot(nextSnapshot);
    },
  );
  return (
    <div class="conversation-story-frame">
      <DirectConversation
        {...props.args}
        snapshot={snapshot()}
        onMarkRead={async () => {
          await props.args.onMarkRead();
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  readState: {
                    ...current.readState,
                    unreadCount: 0,
                    firstUnreadMessageId: null,
                    throughSequence: current.readState?.throughSequence ?? 0,
                  },
                }
              : current,
          );
        }}
      />
    </div>
  );
}

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

export const UnreadMessages: Story = {
  render: (storyArgs) => <StatefulDirectConversation args={storyArgs} />,
  args: {
    snapshot: {
      ...STORY_DIRECT_SNAPSHOTS[member.id],
      revision: 2,
      messages: unreadDirectMessages,
      readState: {
        unreadCount: 12,
        firstUnreadMessageId: "direct-unread-1",
        throughSequence: 12,
      },
    },
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
