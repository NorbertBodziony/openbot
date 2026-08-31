import { describe, expect, it } from "vitest";
import clientHttpRequestFixture from "./fixtures/v1/client-http-request.json";
import clientScopeFixture from "./fixtures/v1/client-scope.json";
import hostCompatibilityFixture from "./fixtures/v1/host-compatibility.json";
import hostEventFixture from "./fixtures/v1/host-event.json";
import hostHttpResponseFixture from "./fixtures/v1/host-http-response.json";
import {
  decodeTeamProtocolSupportV1,
  decodeTeamProtocolV1ClientEvent,
  decodeTeamProtocolV1Event,
  decodeTeamProtocolV1HttpRequest,
  decodeTeamProtocolV1HttpResponse,
  encodeTeamProtocolV1ClientEvent,
  highestCommonTeamProtocol,
  teamProtocolUpdateDirection,
} from "./v1";
import {
  decodeTeamProtocolV1CurrentEvent,
  encodeTeamProtocolV1CurrentHttpRequest,
  encodeTeamProtocolV1CurrentHttpResponse,
} from "./v1-adapter";

describe("Team protocol v1", () => {
  it("keeps the released host and client fixtures valid", () => {
    expect(decodeTeamProtocolSupportV1(hostCompatibilityFixture)).toEqual(hostCompatibilityFixture);
    expect(decodeTeamProtocolV1CurrentEvent(hostEventFixture)).toEqual({ kind: "known", event: hostEventFixture });
    expect(clientScopeFixture).toMatchObject({
      type: "agent-event-scope",
      includeConversations: true,
    });
    const clientScope = decodeTeamProtocolV1ClientEvent(clientScopeFixture);
    expect(JSON.parse(encodeTeamProtocolV1ClientEvent(clientScope))).toEqual(clientScopeFixture);
    expect(decodeTeamProtocolV1HttpRequest("POST", "/v1/invitations/preview", clientHttpRequestFixture)).toEqual(
      clientHttpRequestFixture,
    );
    expect(
      JSON.parse(encodeTeamProtocolV1CurrentHttpRequest("POST", "/v1/invitations/preview", clientHttpRequestFixture)),
    ).toEqual(clientHttpRequestFixture);
    expect(decodeTeamProtocolV1HttpResponse("GET", "/v1/me", 200, hostHttpResponseFixture)).toEqual(
      hostHttpResponseFixture,
    );
    expect(JSON.parse(encodeTeamProtocolV1CurrentHttpResponse("GET", "/v1/me", 200, hostHttpResponseFixture))).toEqual(
      hostHttpResponseFixture,
    );
  });

  it("down-converts semantic tags in current requests for v1 hosts", () => {
    const message = JSON.parse(
      encodeTeamProtocolV1CurrentHttpRequest("POST", "/v1/agents/chief/messages", {
        text: "Ask @[Research](agent:research) to use @[Sources](skill:sources).",
        attachmentDraftIds: [],
        replyToMessageId: null,
      }),
    );
    const queueUpdate = JSON.parse(
      encodeTeamProtocolV1CurrentHttpRequest("POST", "/v1/agents/chief/queue/update", {
        deliveryId: "delivery-1",
        text: "Follow up with @[Research](agent:research).",
        keepAttachmentIds: [],
        attachmentDraftIds: [],
      }),
    );

    expect(message.text).toBe("Ask @Research to use Sources (skill).");
    expect(queueUpdate.text).toBe("Follow up with @Research.");
  });

  it("decodes bounded compatibility metadata and finds the highest common version", () => {
    const support = decodeTeamProtocolSupportV1({
      appVersion: "0.4.0",
      protocol: { minimum: 1, maximum: 3 },
      capabilities: ["browser-control", "browser-control", "remote-desktop"],
    });

    expect(support.capabilities).toEqual(["browser-control", "remote-desktop"]);
    expect(highestCommonTeamProtocol({ minimum: 1, maximum: 2 }, support.protocol)).toBe(2);
    expect(highestCommonTeamProtocol({ minimum: 4, maximum: 4 }, support.protocol)).toBeNull();
    expect(teamProtocolUpdateDirection({ minimum: 1, maximum: 1 }, { minimum: 2, maximum: 3 })).toBe(
      "client_update_required",
    );
    expect(teamProtocolUpdateDirection({ minimum: 2, maximum: 3 }, { minimum: 1, maximum: 1 })).toBe(
      "host_update_required",
    );
  });

  it("rejects malformed compatibility metadata", () => {
    expect(() =>
      decodeTeamProtocolSupportV1({
        appVersion: "0.4.0",
        protocol: { minimum: 2, maximum: 1 },
        capabilities: [],
      }),
    ).toThrow("Invalid Team API compatibility response");
    expect(() =>
      decodeTeamProtocolSupportV1({
        appVersion: "0.4.0",
        protocol: { minimum: 1, maximum: 1 },
        capabilities: ["INVALID CAPABILITY"],
      }),
    ).toThrow("Invalid Team API compatibility response");
  });

  it("distinguishes unknown events from malformed known events", () => {
    expect(decodeTeamProtocolV1Event({ type: "future-optional-event", payload: true })).toEqual({
      kind: "unknown",
      type: "future-optional-event",
    });
    expect(decodeTeamProtocolV1CurrentEvent({ type: "team-presence", snapshot: {} })).toEqual({
      kind: "invalid",
      type: "team-presence",
    });
    expect(decodeTeamProtocolV1CurrentEvent({ type: "conversation", snapshot: {} })).toEqual({
      kind: "invalid",
      type: "conversation",
    });
    expect(decodeTeamProtocolV1CurrentEvent({ type: "runtime-snapshot", snapshot: {} })).toEqual({
      kind: "invalid",
      type: "runtime-snapshot",
    });
    expect(decodeTeamProtocolV1Event({ payload: true })).toEqual({ kind: "invalid", type: null });
  });

  it("accepts the frozen minimal runtime snapshot", () => {
    const event = {
      type: "runtime-snapshot",
      snapshot: {
        bots: [],
        activeTurns: [],
        work: [],
        latestMessages: [],
        attentionComplete: true,
        pendingPrompts: [],
        pendingApprovals: [],
        pendingBrowserTakeovers: [],
        failedTurns: [],
      },
    };

    expect(decodeTeamProtocolV1CurrentEvent(event)).toEqual({ kind: "known", event });
  });

  it("rejects unregistered HTTP routes and malformed known payloads", () => {
    expect(() => decodeTeamProtocolV1HttpRequest("POST", "/v1/future", {})).toThrow(
      "Invalid Team protocol v1 HTTP request",
    );
    expect(() => decodeTeamProtocolV1HttpRequest("POST", "/v1/invitations/preview", { inviteToken: 1 })).toThrow(
      "Invalid Team protocol v1 HTTP request",
    );
    expect(() => decodeTeamProtocolV1HttpResponse("GET", "/v1/agents", 200, {})).toThrow(
      "Invalid Team protocol v1 HTTP response",
    );
    expect(() =>
      decodeTeamProtocolV1HttpResponse("GET", "/v1/me", 200, { ...hostHttpResponseFixture, role: 1 }),
    ).toThrow("Invalid Team protocol v1 HTTP response");
  });

  it("projects current values to frozen v1 fields", () => {
    expect(
      decodeTeamProtocolV1HttpResponse("GET", "/v1/me", 200, {
        ...hostHttpResponseFixture,
        futureCurrentField: "must not cross the wire",
      }),
    ).toEqual(hostHttpResponseFixture);

    const status = decodeTeamProtocolV1CurrentEvent({
      type: "status",
      futureEventField: true,
      status: {
        phase: "ready",
        cliVersion: "1.0.0",
        auth: { kind: "unknown", futureAuthField: true },
        capabilities: { chat: "ready", browser: "ready", computerUse: "ready", futureCapability: "ready" },
        message: null,
        fullAccess: true,
        futureStatusField: true,
      },
    });

    expect(status).toEqual({
      kind: "known",
      event: {
        type: "status",
        status: {
          phase: "ready",
          cliVersion: "1.0.0",
          auth: { kind: "unknown" },
          capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
          message: null,
          fullAccess: true,
        },
      },
    });

    const conversation = decodeTeamProtocolV1HttpResponse("GET", "/v1/agents/bot-1/conversation", 200, {
      botId: "bot-1",
      threadId: "thread-1",
      activeTurnId: null,
      revision: 1,
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
      messages: [
        {
          id: "message-1",
          text: "Hello",
          createdAt: "2026-08-30T12:00:00.000Z",
          author: "user",
          status: "completed",
          futureMessageField: true,
          attachments: [
            {
              id: "attachment-1",
              name: "note.txt",
              size: 4,
              kind: "file",
              mimeType: "text/plain",
              previewKind: "text",
              previewUrl: null,
              futureAttachmentField: true,
            },
          ],
        },
        {
          id: "routine-event-1",
          text: "Morning brief",
          createdAt: "2026-08-30T12:01:00.000Z",
          author: "system",
          source: "system",
          status: "completed",
          itemType: "routine-event:created:routine-1",
        },
      ],
    });
    expect(conversation).toMatchObject({
      messages: [
        { id: "message-1", attachments: [{ id: "attachment-1" }] },
        {
          id: "routine-event-1",
          text: "Morning brief",
          itemType: "routine-event:created:routine-1",
        },
      ],
    });
    expect(JSON.stringify(conversation)).not.toContain("future");

    const runtime = decodeTeamProtocolV1CurrentEvent({
      type: "runtime-snapshot",
      snapshot: {
        bots: [],
        activeTurns: [],
        work: [],
        latestMessages: [],
        attentionComplete: false,
        pendingPrompts: [
          {
            requestId: "request-1",
            botId: "bot-1",
            threadId: "thread-1",
            turnId: "turn-1",
            futurePromptField: true,
            questions: [
              {
                id: "question-1",
                header: "Scope",
                question: "Continue?",
                isSecret: false,
                options: null,
                futureQuestionField: true,
              },
            ],
          },
        ],
        pendingApprovals: [],
        pendingBrowserTakeovers: [],
        failedTurns: [],
      },
    });
    expect(runtime.kind).toBe("known");
    expect(JSON.stringify(runtime)).not.toContain("future");
  });

  it("rejects malformed v1 HTTP error envelopes", () => {
    expect(() =>
      decodeTeamProtocolV1HttpResponse("GET", "/v1/me", 426, {
        error: "Update required.",
        code: "future_error_code",
      }),
    ).toThrow("Invalid Team protocol v1 HTTP error response");
    expect(() =>
      decodeTeamProtocolV1HttpResponse("GET", "/v1/me", 426, {
        error: "Update required.",
        code: "client_update_required",
        host: {
          appVersion: "1.0.0",
          protocol: { minimum: 2, maximum: 1 },
          capabilities: [],
        },
      }),
    ).toThrow("Invalid Team protocol v1 HTTP error response");
  });
});
