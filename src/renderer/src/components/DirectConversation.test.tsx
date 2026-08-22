import type { DirectConversationSnapshot, DirectMessage, TeamPresenceMember } from "@openbot/contracts/ipc";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { DirectConversation } from "./DirectConversation";

describe("DirectConversation", () => {
  it("renders only a small virtual window for a 10,000-message history", () => {
    const member: TeamPresenceMember = {
      id: "member-alice",
      username: "alice",
      email: "alice@example.com",
      name: "Alice",
      avatarUrl: null,
      role: "member",
      createdAt: "2026-08-19T09:00:00.000Z",
      disabled: false,
      online: true,
      typingBotId: null,
    };
    const messages: DirectMessage[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `message-${index.toString().padStart(5, "0")}`,
      threadId: "direct-thread",
      senderMemberId: index % 2 === 0 ? "member-alice" : "member-bob",
      recipientMemberId: index % 2 === 0 ? "member-bob" : "member-alice",
      text: `Message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 19, 9, 0, 0, index)).toISOString(),
      sequence: index + 1,
    }));
    const snapshot: DirectConversationSnapshot = {
      threadId: "direct-thread",
      otherMemberId: member.id,
      messages,
      revision: 10_000,
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughSequence: 10_000 },
    };

    const result = render(() => (
      <DirectConversation
        member={member}
        currentMemberId="member-bob"
        snapshot={snapshot}
        loading={false}
        loadError={null}
        hasOlder
        loadingOlder={false}
        olderError={null}
        typing={false}
        onSend={vi.fn()}
        onMarkRead={vi.fn()}
        onLoadOlder={vi.fn()}
        onTypingChange={vi.fn()}
      />
    ));

    const renderedRows = result.container.querySelectorAll(".virtual-chat-row");
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThanOrEqual(20);
    expect(renderedRows.length).toBeLessThan(messages.length);
  });
});
