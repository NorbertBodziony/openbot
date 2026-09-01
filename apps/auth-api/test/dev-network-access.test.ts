import { describe, expect, it } from "vitest";
import { developmentNetworkRequestAllowed } from "../dev-network-access";

describe("development Auth API LAN access", () => {
  it("keeps the full development API available on loopback", () => {
    expect(developmentNetworkRequestAllowed("127.0.0.1", "/v1/auth/email/start")).toBe(true);
    expect(developmentNetworkRequestAllowed("::1", "/v1/marketplace/agents")).toBe(true);
    expect(developmentNetworkRequestAllowed("::ffff:127.0.0.1", "/v1/auth/email/start")).toBe(true);
  });

  it("exposes only the mobile session endpoints to the local network", () => {
    for (const path of ["/v1/mobile-auth/redeem", "/v1/mobile-auth/session", "/v1/me", "/v1/auth/logout"]) {
      expect(developmentNetworkRequestAllowed("192.168.1.20", path)).toBe(true);
    }
    expect(developmentNetworkRequestAllowed("192.168.1.20", "/v1/auth/email/start")).toBe(false);
    expect(developmentNetworkRequestAllowed("192.168.1.20", "/v1/mobile-auth/devices")).toBe(false);
  });
});
