import { describe, expect, it } from "vitest";
import { decodeSignalClientMessage } from "../src/protocol";

describe("signal protocol", () => {
  it("accepts a bounded ICE candidate", () => {
    expect(
      decodeSignalClientMessage({
        type: "ice-candidate",
        version: 1,
        connectionId: "connection_1",
        channel: "team",
        candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      }),
    ).toMatchObject({ type: "ice-candidate", connectionId: "connection_1" });
  });

  it("rejects application payload types", () => {
    expect(() =>
      decodeSignalClientMessage({ type: "file", version: 1, connectionId: "connection_1", bytes: "secret" }),
    ).toThrow("Unsupported signal message");
  });
});
