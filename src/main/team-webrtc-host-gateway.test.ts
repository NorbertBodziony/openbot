// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "./team-store";
import { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcHostGateway } from "./team-webrtc-host-gateway";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class FakeBridge extends TeamWebRtcBridge {
  readonly connections: Array<{ peerId: string; signalUrl: string; token: string; peer: "host" | "client" }> = [];
  readonly disconnectedPeers: string[] = [];

  async connect(input: { peerId: string; signalUrl: string; token: string; peer: "host" | "client" }): Promise<void> {
    this.connections.push(input);
  }

  async disconnect(): Promise<void> {}

  async disconnectPeer(peerId: string): Promise<void> {
    this.disconnectedPeers.push(peerId);
  }

  async send(): Promise<void> {}
}

describe("TeamWebRtcHostGateway", () => {
  it("gets a new machine-authenticated ticket after host authentication expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-host-gateway-"));
    directories.push(directory);
    const bridge = new FakeBridge();
    const store = new TeamStore(join(directory, "team.json"));
    await store.initialize();
    await store.configureWithAccount("Test Host", {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });
    const renewSignal = vi
      .fn()
      .mockResolvedValue({ signalUrl: "wss://signal.example.test/v1/signal", ticket: "fresh" });
    const recoveryFailure = vi.fn();
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const gateway = new TeamWebRtcHostGateway({
      bridge,
      store,
      appVersion: "1.0.0",
      transferDirectory: join(directory, "transfers"),
      renewSignal,
      onSignalRecoveryFailure: recoveryFailure,
      closeSession,
    });

    const starting = gateway.start({
      hostId: "host-1",
      signalUrl: "wss://signal.example.test/v1/signal",
      ticket: "initial",
      localApiPort: 0,
    });
    await vi.waitFor(() => expect(bridge.connections).toHaveLength(1));
    bridge.emit("signalReady", "host-1");
    await starting;

    bridge.emit("error", "host-1", "session_revoked", "credential rotated");
    await vi.waitFor(() => expect(bridge.connections).toHaveLength(2));
    bridge.emit("signalReady", "host-1");
    await vi.waitFor(() => expect(renewSignal).toHaveBeenCalledWith("host-1"));

    expect(bridge.connections[1]).toMatchObject({ peerId: "host-1", token: "fresh", peer: "host" });
    expect(recoveryFailure).not.toHaveBeenCalled();
    bridge.emit("incoming", "host-1", {
      connectionId: "connection-1",
      sessionId: "session-1",
      userId: "member-account",
      membershipId: "membership-1",
      role: "member",
      sessionExpiresAt: Math.floor(Date.now() / 1_000) + 60,
    });
    bridge.emit("disconnected", "host-1");
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith("session-1"));
    await gateway.stop();
    gateway.dispose();
  });

  it("drops only the active WebRTC peer after a malformed known frame", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-host-protocol-"));
    directories.push(directory);
    const bridge = new FakeBridge();
    const store = new TeamStore(join(directory, "team.json"));
    await store.initialize();
    const gateway = new TeamWebRtcHostGateway({
      bridge,
      store,
      appVersion: "1.0.0",
      transferDirectory: join(directory, "transfers"),
    });

    const starting = gateway.start({
      hostId: "host-1",
      signalUrl: "wss://signal.example.test/v1/signal",
      ticket: "initial",
      localApiPort: 0,
    });
    await vi.waitFor(() => expect(bridge.connections).toHaveLength(1));
    bridge.emit("signalReady", "host-1");
    await starting;
    bridge.emit("data", "host-1", "rpc", "not-json");

    await vi.waitFor(() => expect(bridge.disconnectedPeers).toEqual(["host-1"]));
    expect(bridge.connections).toHaveLength(1);
    await gateway.stop();
    gateway.dispose();
  });
});
