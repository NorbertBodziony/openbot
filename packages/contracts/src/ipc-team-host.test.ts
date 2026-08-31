import { describe, expect, it } from "vitest";
import { INPUT_LIMITS } from "./input-limits";
import { isTeamRealtimeEvent } from "./ipc-team-host";

describe("isTeamRealtimeEvent", () => {
  it("accepts complete presence, direct-message, and typing events", () => {
    expect(
      isTeamRealtimeEvent({
        type: "team-presence",
        snapshot: {
          serverId: "server-1",
          updatedAt: "2026-08-19T09:00:00.000Z",
          members: [
            {
              id: "member-1",
              username: "person@example.com",
              email: "person@example.com",
              name: "Person",
              avatarUrl: "https://api.openbot.run/v1/avatars/member-1?v=image-1",
              role: "member",
              createdAt: "2026-08-19T08:00:00.000Z",
              disabled: false,
              online: true,
              typingBotId: null,
            },
          ],
        },
      }),
    ).toBe(true);
    const message = {
      id: "message-1",
      threadId: "thread-1",
      senderMemberId: "member-1",
      recipientMemberId: "member-2",
      text: "Hello",
      createdAt: "2026-08-19T09:00:00.000Z",
      sequence: 1,
    };
    expect(
      isTeamRealtimeEvent({
        type: "team-direct-message",
        message,
        memberIds: ["member-1", "member-2"],
      }),
    ).toBe(true);
    expect(
      isTeamRealtimeEvent({
        type: "team-direct-typing",
        senderMemberId: "member-1",
        recipientMemberId: "member-2",
        typing: true,
      }),
    ).toBe(true);
  });

  it("accepts legacy account names in presence events", () => {
    expect(
      isTeamRealtimeEvent({
        type: "team-presence",
        snapshot: {
          serverId: "server-1",
          updatedAt: "2026-08-19T09:00:00.000Z",
          members: [
            {
              id: "member-1",
              username: "person@example.com",
              email: "person@example.com",
              name: "x".repeat(INPUT_LIMITS.accountName),
              avatarUrl: null,
              role: "member",
              createdAt: "2026-08-19T08:00:00.000Z",
              disabled: false,
              online: true,
              typingBotId: null,
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("rejects shallow, inconsistent, and oversized events", () => {
    expect(isTeamRealtimeEvent({ type: "team-presence", snapshot: { members: [] } })).toBe(false);
    expect(
      isTeamRealtimeEvent({
        type: "team-presence",
        snapshot: {
          serverId: "server-1",
          updatedAt: "2026-08-19T09:00:00.000Z",
          members: [
            {
              id: "member-1",
              username: "person@example.com",
              email: "person@example.com",
              name: "Person",
              avatarUrl: "javascript:alert(1)",
              role: "member",
              createdAt: "2026-08-19T08:00:00.000Z",
              disabled: false,
              online: true,
              typingBotId: null,
            },
          ],
        },
      }),
    ).toBe(false);
    expect(isTeamRealtimeEvent({ type: "team-direct-message", message: {}, memberIds: [] })).toBe(false);
    expect(
      isTeamRealtimeEvent({
        type: "team-direct-message",
        message: {
          id: "message-1",
          threadId: "thread-1",
          senderMemberId: "member-1",
          recipientMemberId: "member-2",
          text: "Hello",
          createdAt: "2026-08-19T09:00:00.000Z",
          sequence: 1,
        },
        memberIds: ["member-2", "member-1"],
      }),
    ).toBe(false);
    expect(
      isTeamRealtimeEvent({
        type: "team-direct-typing",
        senderMemberId: "x".repeat(129),
        recipientMemberId: "member-2",
        typing: true,
      }),
    ).toBe(false);
  });
});
