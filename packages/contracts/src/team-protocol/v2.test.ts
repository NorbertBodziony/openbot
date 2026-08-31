import { describe, expect, it } from "vitest";
import eventFixture from "./fixtures/v2/event.json";
import fileOpenFixture from "./fixtures/v2/file-open.json";
import requestFixture from "./fixtures/v2/request.json";
import {
  decodeTeamProtocolV2EventFrame,
  decodeTeamProtocolV2FileChunk,
  decodeTeamProtocolV2FileControlFrame,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2FileChunk,
  TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES,
  TEAM_PROTOCOL_V2_MAX_FILE_BYTES,
  TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES,
} from "./v2";

describe("Team protocol v2", () => {
  it("keeps the released JSON fixtures valid", () => {
    expect(decodeTeamProtocolV2RpcFrame(requestFixture)).toEqual(requestFixture);
    expect(decodeTeamProtocolV2EventFrame(eventFixture)).toEqual(eventFixture);
    expect(decodeTeamProtocolV2FileControlFrame(fileOpenFixture)).toEqual(fileOpenFixture);
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
