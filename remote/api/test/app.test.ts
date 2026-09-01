import { describe, expect, it } from "vitest";
import { signalClientIp } from "../src/app";

describe("Remote API proxy addresses", () => {
  it("uses the first forwarded address only when the proxy is trusted", () => {
    expect(signalClientIp("127.0.0.1", "198.51.100.20, 127.0.0.1", true)).toBe("198.51.100.20");
    expect(signalClientIp("203.0.113.8", "198.51.100.20", false)).toBe("203.0.113.8");
  });
});
