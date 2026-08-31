import { describe, expect, it } from "vitest";
import clientScopeFixture from "./fixtures/v2/client-scope.json";
import hostCompatibilityFixture from "./fixtures/v2/host-compatibility.json";
import hostEventFixture from "./fixtures/v2/host-event.json";
import hostHttpResponseFixture from "./fixtures/v2/host-http-response.json";
import { decodeTeamProtocolSupportV1 } from "./v1";
import { encodeTeamProtocolV1CurrentHttpResponse } from "./v1-adapter";
import {
  decodeTeamProtocolV2ClientEvent,
  decodeTeamProtocolV2HttpResponse,
  encodeTeamProtocolV2ClientEvent,
  TEAM_PROTOCOL_V2_CAPABILITIES,
  TEAM_PROTOCOL_V2_WEBSOCKET,
} from "./v2";
import {
  decodeTeamProtocolV2CurrentEvent,
  encodeTeamProtocolV2CurrentEvent,
  encodeTeamProtocolV2CurrentHttpResponse,
} from "./v2-adapter";

describe("Team protocol v2", () => {
  it("keeps the released host and client fixtures valid", () => {
    expect(decodeTeamProtocolSupportV1(hostCompatibilityFixture)).toEqual(hostCompatibilityFixture);
    expect(decodeTeamProtocolV2CurrentEvent(hostEventFixture)).toEqual({ kind: "known", event: hostEventFixture });
    const clientScope = decodeTeamProtocolV2ClientEvent(clientScopeFixture);
    expect(JSON.parse(encodeTeamProtocolV2ClientEvent(clientScope))).toEqual(clientScopeFixture);
    expect(decodeTeamProtocolV2HttpResponse("GET", "/v1/agents/chief/skills", 200, hostHttpResponseFixture)).toEqual(
      hostHttpResponseFixture,
    );
    expect(
      JSON.parse(
        encodeTeamProtocolV2CurrentHttpResponse("GET", "/v1/agents/chief/skills", 200, hostHttpResponseFixture),
      ),
    ).toEqual(hostHttpResponseFixture);
  });

  it("adds installed skill summaries behind a declared capability", () => {
    expect(TEAM_PROTOCOL_V2_CAPABILITIES).toContain("installed-skills");
    expect(
      decodeTeamProtocolV2HttpResponse("GET", "/v1/agents/chief/skills", 200, [
        {
          skillId: "skill-1",
          slug: "release-notes",
          name: "Release Notes",
          installedVersion: 1,
          availableVersion: 2,
          state: "update-available",
          ignored: true,
        },
      ]),
    ).toEqual([
      {
        skillId: "skill-1",
        slug: "release-notes",
        name: "Release Notes",
        installedVersion: 1,
        availableVersion: 2,
        state: "update-available",
      },
    ]);
  });

  it("accepts the v2 capability in client scope declarations", () => {
    expect(TEAM_PROTOCOL_V2_WEBSOCKET).toBe("openbot-team-v2");
    expect(
      decodeTeamProtocolV2ClientEvent({
        type: "agent-event-scope",
        includeConversations: true,
        capabilities: ["agent-runtime-snapshots", "installed-skills"],
      }),
    ).toEqual({
      type: "agent-event-scope",
      includeConversations: true,
      capabilities: ["agent-runtime-snapshots", "installed-skills"],
    });
  });

  it("preserves semantic tags in v2 events", () => {
    const encoded = encodeTeamProtocolV2CurrentEvent({
      type: "error",
      botId: "chief",
      code: "test",
      message: "Ask @[Research](agent:research) to use @[Sources](skill:sources).",
    });
    expect(encoded).toContain("@[Research](agent:research)");
    expect(encoded).toContain("@[Sources](skill:sources)");
  });

  it("down-converts semantic tags for v1 clients", () => {
    const encoded = encodeTeamProtocolV1CurrentHttpResponse("GET", "/v1/agents/chief/conversation", 200, {
      botId: "chief",
      threadId: "thread-1",
      messages: [
        {
          id: "message-1",
          author: "user",
          text: "Ask @[Research](agent:research) to use @[Sources](skill:sources).",
          createdAt: "2026-08-31T00:00:00.000Z",
          status: "completed",
        },
      ],
      activeTurnId: null,
      revision: 1,
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    });
    expect(encoded).toContain("Ask @Research to use Sources (skill).");
    expect(encoded).not.toContain("agent:research");
  });
});
