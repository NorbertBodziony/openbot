import { describe, expect, it, vi } from "vitest";
import { handleTeamHostIceServers } from "../src/server/team-host-ice-servers";

const serverId = "55d0fbba-4b11-48c6-a0de-1859e44adf41";

describe("team host ICE servers", () => {
  it("requires a valid machine token", async () => {
    const authenticateHost = vi.fn(async () => false);
    const missing = await handleTeamHostIceServers(request(), { authenticateHost });
    expect(missing.status).toBe(401);
    expect(authenticateHost).not.toHaveBeenCalled();

    const invalid = await handleTeamHostIceServers(request("invalid-token"), { authenticateHost });
    expect(invalid.status).toBe(401);
    expect(authenticateHost).toHaveBeenCalledWith(serverId, "invalid-token");
  });

  it("returns STUN only for direct P2P negotiation", async () => {
    const response = await handleTeamHostIceServers(request("machine-token"), {
      authenticateHost: async () => true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects malformed input", async () => {
    const malformed = await handleTeamHostIceServers(
      new Request("https://api.openbot.run/v1/team-hosts/ice-servers", {
        method: "POST",
        headers: { Authorization: "Bearer machine-token", "Content-Type": "application/json" },
        body: "not-json",
      }),
      { authenticateHost: async () => true },
    );
    expect(malformed.status).toBe(400);
  });
});

function request(token?: string): Request {
  return new Request("https://api.openbot.run/v1/team-hosts/ice-servers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ serverId }),
  });
}
