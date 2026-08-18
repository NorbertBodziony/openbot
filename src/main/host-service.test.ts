// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildApiTunnelArgs, buildVncTunnelArgs, parseQuickTunnelHostname } from "./host-service";

describe("host tunnel commands", () => {
  it("builds API and VNC arguments without a command string", () => {
    expect(buildApiTunnelArgs(43123)).toEqual([
      "tunnel",
      "--protocol",
      "quic",
      "--url",
      "http://127.0.0.1:43123",
    ]);
    expect(buildVncTunnelArgs()).toEqual([
      "tunnel",
      "--protocol",
      "quic",
      "--url",
      "tcp://localhost:5900",
    ]);
  });

  it("extracts only the Quick Tunnel hostname", () => {
    expect(
      parseQuickTunnelHostname(
        "INF Requesting new quick Tunnel https://warm-river.trycloudflare.com",
      ),
    ).toBe("warm-river.trycloudflare.com");
    expect(parseQuickTunnelHostname("https://example.com")).toBeNull();
  });
});
