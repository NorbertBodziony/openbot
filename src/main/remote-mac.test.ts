// @vitest-environment node

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCloudflaredAccessArgs,
  findFreeLoopbackPort,
  isValidTunnelHostname,
  probeRfbHandshake,
  RemoteMacManager,
  recognizesRfbHandshake,
  stopOwnedProcess,
} from "./remote-mac";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("Remote Mac helpers", () => {
  it.each([
    ["pty-vacuum-named-ends.trycloudflare.com", true],
    ["https://pty-vacuum-named-ends.trycloudflare.com", false],
    ["pty-vacuum.trycloudflare.com/path", false],
    ["PTY.trycloudflare.com", false],
    ["-bad.trycloudflare.com", false],
    ["example.com", false],
  ])("validates %s as %s", (hostname, expected) => {
    expect(isValidTunnelHostname(hostname)).toBe(expected);
  });

  it("builds a shell-free argument array", () => {
    expect(buildCloudflaredAccessArgs("demo.trycloudflare.com", 5907)).toEqual([
      "access",
      "tcp",
      "--hostname",
      "demo.trycloudflare.com",
      "--url",
      "127.0.0.1:5907",
    ]);
  });

  it("recognizes only an RFB prefix", () => {
    expect(recognizesRfbHandshake("RFB 003.889\n")).toBe(true);
    expect(recognizesRfbHandshake("HTTP/1.1 200 OK\n")).toBe(false);
  });

  it("skips a reserved or occupied local port", async () => {
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(5901, "127.0.0.1", resolve));
    await expect(findFreeLoopbackPort(new Set([5902]), 5901, 5903)).resolves.toBe(5903);
  });

  it("reads the VNC handshake from a local TCP server", async () => {
    const server = createServer((socket) => socket.end("RFB 003.889\n"));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    await expect(probeRfbHandshake(address.port)).resolves.toBe(true);
  });

  it("terminates only the supplied child and escalates after the grace period", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { exitCode: null, killed: false });
    child.kill = vi.fn(() => true);
    const stopping = stopOwnedProcess(child, 50);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(50);
    await stopping;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });

  it("returns an actionable state when cloudflared is missing", async () => {
    const manager = new RemoteMacManager({
      openExternal: vi.fn(async () => undefined),
      resolveCloudflared: async () => null,
    });
    const session = await manager.connect({ hostname: "demo.trycloudflare.com" });
    expect(session).toMatchObject({
      phase: "idle",
      errorCode: "cloudflared_not_found",
    });
    expect(session.message).toContain("brew install cloudflared");
  });
});
