import { describe, expect, it } from "vitest";
import eventFixture from "./fixtures/v2/event.json";
import fileOpenFixture from "./fixtures/v2/file-open.json";
import requestFixture from "./fixtures/v2/request.json";
import {
  decodeTeamProtocolV2AuthFrame,
  decodeTeamProtocolV2EventFrame,
  decodeTeamProtocolV2FileChunk,
  decodeTeamProtocolV2FileControlFrame,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2FileChunk,
  encodeTeamProtocolV2Frame,
  TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES,
  TEAM_PROTOCOL_V2_MAX_FILE_BYTES,
  TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES,
} from "./v2";
import {
  createTeamProtocolV2Event,
  decodeTeamProtocolV2CurrentEvent,
  decodeTeamProtocolV2CurrentHttpResponse,
  encodeTeamProtocolV2CurrentHttpRequest,
  encodeTeamProtocolV2CurrentHttpResponse,
} from "./v2-adapter";

describe("Team protocol v2", () => {
  it("keeps the released JSON fixtures valid", () => {
    expect(decodeTeamProtocolV2RpcFrame(requestFixture)).toEqual(requestFixture);
    expect(decodeTeamProtocolV2EventFrame(eventFixture)).toEqual(eventFixture);
    expect(decodeTeamProtocolV2FileControlFrame(fileOpenFixture)).toEqual(fileOpenFixture);
  });

  it("down-converts semantic tags in released v2 events", () => {
    const frame = createTeamProtocolV2Event(1, {
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: null,
        revision: 1,
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
        messages: [
          {
            id: "message-1",
            author: "assistant",
            text: "Ask @[Research](agent:research) to use @[Sources](skill:sources).",
            createdAt: "2026-08-29T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    expect(frame).toMatchObject({
      payload: { snapshot: { messages: [{ text: "Ask @Research to use Sources (skill)." }] } },
    });
  });

  it("passes installed skill summaries through the v2 HTTP adapter", () => {
    const skills = [
      {
        skillId: "skill-1",
        slug: "release-notes",
        name: "Release Notes",
        installedVersion: 1,
        availableVersion: 2,
        state: "update-available",
      },
    ];

    expect(encodeTeamProtocolV2CurrentHttpResponse("GET", "/v1/agents/chief/skills", 200, skills)).toEqual(skills);
    expect(decodeTeamProtocolV2CurrentHttpResponse("GET", "/v1/agents/chief/skills", 200, skills)).toEqual(skills);
  });

  it("encodes binary chunks with an exact offset", () => {
    const encoded = encodeTeamProtocolV2FileChunk({
      transferId: "transfer-1",
      offset: 65_536,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(decodeTeamProtocolV2FileChunk(encoded)).toEqual({
      transferId: "transfer-1",
      offset: 65_536,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
  });

  it("accepts an event acknowledgement before the first event", () => {
    expect(decodeTeamProtocolV2EventFrame({ version: 2, type: "event-ack", throughSequence: 0 })).toEqual({
      version: 2,
      type: "event-ack",
      throughSequence: 0,
    });
  });

  it("accepts an event sequence reset", () => {
    expect(decodeTeamProtocolV2EventFrame({ version: 2, type: "event-reset", nextSequence: 2_001 })).toEqual({
      version: 2,
      type: "event-reset",
      nextSequence: 2_001,
    });
  });

  it("distinguishes unknown events from malformed known events", () => {
    expect(
      decodeTeamProtocolV2CurrentEvent({
        version: 2,
        type: "event",
        sequence: 1,
        payload: { type: "future-event", value: true },
      }),
    ).toEqual({ status: "unknown" });
    expect(
      decodeTeamProtocolV2CurrentEvent({
        version: 2,
        type: "event",
        sequence: 1,
        payload: { type: "runtime-snapshot" },
      }),
    ).toEqual({ status: "invalid" });
  });

  it("projects current HTTP payloads through the frozen route codec", () => {
    expect(
      encodeTeamProtocolV2CurrentHttpRequest("POST", "/v1/agents/chief/messages", {
        text: "Ask @[Research](agent:research) to use @[Sources](skill:sources).",
        attachmentDraftIds: [],
        replyToMessageId: null,
      }),
    ).toMatchObject({ text: "Ask @Research to use Sources (skill)." });
    expect(
      encodeTeamProtocolV2CurrentHttpRequest("POST", "/v1/browser/visible", {
        visible: true,
        bounds: undefined,
        futureRequestField: "ignored",
      }),
    ).toEqual({ visible: true });
    expect(encodeTeamProtocolV2CurrentHttpRequest("DELETE", "/v1/attachments/attachment-1", undefined)).toEqual({});
    expect(encodeTeamProtocolV2CurrentHttpRequest("DELETE", "/v1/agents/agent-1", undefined)).toEqual({});
    expect(encodeTeamProtocolV2CurrentHttpRequest("GET", "/v1/agents/agent-1/skills", undefined)).toEqual({});
    expect(
      encodeTeamProtocolV2CurrentHttpRequest("GET", "/v1/remote-screen/sessions/session-1/viewer", undefined),
    ).toEqual({});
    expect(
      encodeTeamProtocolV2CurrentHttpRequest("POST", "/v1/remote-screen/sessions/session-1/authorize", {
        grant: "viewer-grant",
      }),
    ).toEqual({ grant: "viewer-grant" });
    expect(
      decodeTeamProtocolV2CurrentHttpResponse("GET", "/v1/compatibility", 200, {
        appVersion: "1.0.0",
        protocol: { minimum: 1, maximum: 2 },
        capabilities: [],
        futureResponseField: "ignored",
      }),
    ).toEqual({ appVersion: "1.0.0", protocol: { minimum: 1, maximum: 2 }, capabilities: [] });
    expect(decodeTeamProtocolV2CurrentHttpResponse("POST", "/v1/browser/visible", 204, {})).toEqual({});
    expect(
      encodeTeamProtocolV2CurrentHttpResponse("GET", "/v1/agents/chief/conversation", 200, {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: null,
        revision: 1,
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
        messages: [
          {
            id: "message-1",
            author: "assistant",
            text: "Ask @[Research](agent:research) to use @[Sources](skill:sources).",
            createdAt: "2026-08-29T10:00:00.000Z",
            status: "completed",
          },
        ],
      }),
    ).toMatchObject({ messages: [{ text: "Ask @Research to use Sources (skill)." }] });
    expect(
      decodeTeamProtocolV2CurrentHttpResponse("GET", "/v1/remote-screen/sessions/session-1/moonlight/api/role", 200, {
        role: "stream",
      }),
    ).toEqual({ role: "stream" });
  });

  it("validates bounded authentication frames", () => {
    expect(
      decodeTeamProtocolV2AuthFrame({
        version: 2,
        type: "auth-ready",
        clientNonce: "c".repeat(43),
        hostNonce: "h".repeat(43),
        signature: "s".repeat(86),
      }),
    ).toMatchObject({ type: "auth-ready" });
    expect(
      decodeTeamProtocolV2AuthFrame(
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "auth-complete",
          clientNonce: "c".repeat(43),
          hostNonce: "h".repeat(43),
        }),
      ),
    ).toMatchObject({ type: "auth-complete" });
    expect(
      decodeTeamProtocolV2AuthFrame(
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "auth-confirmed",
          clientNonce: "c".repeat(43),
          hostNonce: "h".repeat(43),
        }),
      ),
    ).toMatchObject({ type: "auth-confirmed" });
  });

  it("validates client event controls", () => {
    expect(
      decodeTeamProtocolV2EventFrame({
        version: 2,
        type: "event-control",
        control: { type: "team-typing", botId: "bot-1", typing: true },
      }),
    ).toEqual({
      version: 2,
      type: "event-control",
      control: { type: "team-typing", botId: "bot-1", typing: true },
    });
    expect(() =>
      decodeTeamProtocolV2EventFrame({
        version: 2,
        type: "event-control",
        control: { type: "team-direct-typing", recipientMemberId: "", typing: true },
      }),
    ).toThrow();
  });

  it("rejects oversized files, chunks, and invalid offsets", () => {
    expect(() =>
      decodeTeamProtocolV2FileControlFrame({ ...fileOpenFixture, size: TEAM_PROTOCOL_V2_MAX_FILE_BYTES + 1 }),
    ).toThrow();
    expect(() =>
      encodeTeamProtocolV2FileChunk({ transferId: "transfer-1", offset: -1, bytes: new Uint8Array([1]) }),
    ).toThrow();
    expect(() =>
      encodeTeamProtocolV2FileChunk({
        transferId: "transfer-1",
        offset: 0,
        bytes: new Uint8Array(TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES),
      }),
    ).toThrow();
  });

  it("requires exactly one response result", () => {
    expect(() => decodeTeamProtocolV2RpcFrame({ version: 2, type: "response", requestId: "request-1" })).toThrow();
    expect(() =>
      decodeTeamProtocolV2RpcFrame({
        version: 2,
        type: "response",
        requestId: "request-1",
        result: null,
        error: { code: "failed", message: "Failed", retryable: false },
      }),
    ).toThrow();
  });

  it("rejects an oversized JSON frame before parsing its payload", () => {
    expect(() => decodeTeamProtocolV2RpcFrame(" ".repeat(TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES + 1))).toThrow("size");
  });
});
