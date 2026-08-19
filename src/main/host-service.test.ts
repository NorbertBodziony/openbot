// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildNamedTunnelArgs, buildNamedTunnelEnvironment, waitForNamedTunnelConnection } from "./host-service";

describe("host tunnel commands", () => {
  it("runs one remotely managed named tunnel", () => {
    expect(buildNamedTunnelArgs()).toEqual(["tunnel", "--protocol", "quic", "run"]);
    expect(buildNamedTunnelArgs().join(" ")).not.toContain("secret");
    expect(buildNamedTunnelEnvironment("secret", { PATH: "/bin" })).toEqual({
      PATH: "/bin",
      TUNNEL_TOKEN: "secret",
    });
  });

  it("waits for the named connector registration", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr });
    const connected = waitForNamedTunnelConnection(child, 1_000);
    stderr.write("INF Registered tunnel connection connIndex=0");
    await expect(connected).resolves.toBe(true);
  });
});
