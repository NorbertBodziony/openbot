import { describe, expect, it } from "vitest";
import { SignalSocketIds, signalClientIp } from "../src/app";

describe("Remote API proxy addresses", () => {
  it("uses the first forwarded address only when the proxy is trusted", () => {
    expect(signalClientIp("127.0.0.1", "198.51.100.20, 127.0.0.1", true)).toBe("198.51.100.20");
    expect(signalClientIp("203.0.113.8", "198.51.100.20", false)).toBe("203.0.113.8");
  });
});

describe("Remote API socket identifiers", () => {
  it("does not mutate the Elysia WebSocket data object", () => {
    const socket = Object.freeze({ data: Object.freeze({}) });
    const ids = new SignalSocketIds();

    const id = ids.create(socket);

    expect(ids.get(socket)).toBe(id);
    expect(socket.data).toEqual({});
    ids.delete(socket);
    expect(() => ids.get(socket)).toThrow("Signal socket has no identifier.");
  });
});
