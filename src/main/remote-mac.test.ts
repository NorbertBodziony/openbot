// @vitest-environment node

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { isString } from "@openbot/contracts/runtime-values";
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
    ["vnc-h-00000000000040008000000000000000.openbot.run", true],
    ["h-00000000000040008000000000000000.openbot.run", false],
    ["vnc-h-not-a-server.openbot.run", false],
    ["example.com", false],
  ])("validates %s as %s", (hostname, expected) => {
    expect(isValidTunnelHostname(hostname)).toBe(expected);
  });

  it("builds a shell-free argument array", () => {
    const hostname = "vnc-h-00000000000040008000000000000000.openbot.run";
    expect(buildCloudflaredAccessArgs(hostname, 5907)).toEqual([
      "access",
      "tcp",
      "--hostname",
      hostname,
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
    if (!address || isString(address)) throw new Error("Missing TCP address");
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
      resolveCloudflared: async () => null,
    });
    const session = await manager.connect({ hostname: "demo.trycloudflare.com" });
    expect(session).toMatchObject({
      phase: "idle",
      errorCode: "cloudflared_not_found",
    });
    expect(session.message).toContain("brew install cloudflared");
  });

  it("reuses one host tunnel and closes its embedded desktop bridge", async () => {
    const bridgeClose = vi.fn(async () => undefined);
    const startBridge = vi.fn(async () => ({
      url: "ws://127.0.0.1:62000/vnc/test-token",
      close: bridgeClose,
    }));
    const spawnProcess = vi.fn((_executable: string, args: readonly string[]) => {
      const port = Number(args.at(-1)?.split(":").at(-1));
      const vnc = createServer((socket) => socket.end("RFB 003.889\n"));
      servers.push(vnc);
      vnc.listen(port, "127.0.0.1");
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { exitCode: null, killed: false, stdout: null, stderr: null });
      child.kill = vi.fn(() => {
        Object.assign(child, { exitCode: 0, killed: true });
        vnc.close();
        queueMicrotask(() => child.emit("exit", 0, null));
        return true;
      });
      return child;
    });
    const manager = new RemoteMacManager({
      resolveCloudflared: async () => "/usr/local/bin/cloudflared",
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
      startBridge,
      timeoutMs: 2_000,
    });
    const input = {
      hostname: "vnc-h-00000000000040008000000000000000.openbot.run",
      serverId: "host-1",
    };

    const first = await manager.connect(input);
    const second = await manager.connect(input);

    expect(first).toMatchObject({
      phase: "connected",
      websocketUrl: "ws://127.0.0.1:62000/vnc/test-token",
    });
    expect(second.id).toBe(first.id);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(startBridge).toHaveBeenCalledTimes(1);

    await manager.disconnect(first.id);
    expect(bridgeClose).toHaveBeenCalledOnce();
    expect(manager.list()[0]).toMatchObject({ phase: "idle", websocketUrl: null });
  });

  it("uses team authorization and exposes managed credentials only for the active session", async () => {
    const relayClose = vi.fn(async () => undefined);
    const startRelay = vi.fn(async () => ({
      url: "ws://127.0.0.1:62001/vnc/local-token",
      close: relayClose,
    }));
    const resolveRemoteDesktop = vi.fn(async () => ({
      url: "wss://h-00000000000040008000000000000000.openbot.run/v1/remote-desktop",
      protocols: ["openbot-desktop", "openbot-token.team-secret"],
      password: "deskpass",
    }));
    const manager = new RemoteMacManager({ resolveRemoteDesktop, startRelay });

    const session = await manager.connect({
      hostname: "h-00000000000040008000000000000000.openbot.run",
      serverId: "host-1",
    });

    expect(session).toMatchObject({
      phase: "connected",
      localPort: null,
      websocketUrl: "ws://127.0.0.1:62001/vnc/local-token",
    });
    expect(startRelay).toHaveBeenCalledWith({
      url: "wss://h-00000000000040008000000000000000.openbot.run/v1/remote-desktop",
      protocols: ["openbot-desktop", "openbot-token.team-secret"],
    });
    expect(manager.getCredentials(session.id)).toEqual({
      username: "",
      password: "deskpass",
      target: "",
    });
    expect(JSON.stringify(session)).not.toContain("deskpass");

    await manager.disconnect(session.id);
    expect(relayClose).toHaveBeenCalledOnce();
    expect(manager.getCredentials(session.id)).toBeNull();
  });
});
