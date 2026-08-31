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

  async connect(input: { peerId: string; signalUrl: string; token: string; peer: "host" | "client" }): Promise<void> {
    this.connections.push(input);
  }

  async disconnect(): Promise<void> {}

  async send(): Promise<void> {}
}

describe("TeamWebRtcHostGateway", () => {
  it("gets a new machine-authenticated ticket after host authentication expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-host-gateway-"));
    directories.push(directory);
    const bridge = new FakeBridge();
    const renewSignal = vi
      .fn()
      .mockResolvedValue({ signalUrl: "wss://signal.example.test/v1/signal", ticket: "fresh" });
    const recoveryFailure = vi.fn();
    const gateway = new TeamWebRtcHostGateway({
      bridge,
      store: new TeamStore(join(directory, "team.json")),
      appVersion: "1.0.0",
      transferDirectory: join(directory, "transfers"),
      renewSignal,
      onSignalRecoveryFailure: recoveryFailure,
    });

    const starting = gateway.start({
      hostId: "host-1",
      signalUrl: "wss://signal.example.test/v1/signal",
      ticket: "initial",
      localApiPort: 31_001,
    });
    await vi.waitFor(() => expect(bridge.connections).toHaveLength(1));
    bridge.emit("signalReady", "host-1");
    await starting;

    bridge.emit("error", "host-1", "authentication_required", "expired");
    await vi.waitFor(() => expect(bridge.connections).toHaveLength(2));
    bridge.emit("signalReady", "host-1");
    await vi.waitFor(() => expect(renewSignal).toHaveBeenCalledWith("host-1"));

    expect(bridge.connections[1]).toMatchObject({ peerId: "host-1", token: "fresh", peer: "host" });
    expect(recoveryFailure).not.toHaveBeenCalled();
    await gateway.stop();
    gateway.dispose();
  });
});
