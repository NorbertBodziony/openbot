// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isString } from "@openbot/contracts/runtime-values";
import {
  decodeTeamProtocolV2AuthFrame,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2Frame,
  teamProtocolV2AuthenticationTranscript,
} from "@openbot/contracts/team-protocol/v2";
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
  readonly sent: Array<{ peerId: string; channel: string; data: string | ArrayBuffer }> = [];

  async connect(input: { peerId: string; signalUrl: string; token: string; peer: "host" | "client" }): Promise<void> {
    this.connections.push(input);
  }

  async disconnect(): Promise<void> {}

  async disconnectPeer(peerId: string): Promise<void> {
    this.disconnectedPeers.push(peerId);
  }

  async send(
    peerId: string,
    channel: "rpc" | "events" | "files" | "desktop",
    data: string | ArrayBuffer,
  ): Promise<void> {
    this.sent.push({ peerId, channel, data });
  }
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
    const closeLocalSession = vi.spyOn(store, "closeRemoteSession");
    const renewSignal = vi
      .fn()
      .mockResolvedValue({ signalUrl: "wss://signal.example.test/v1/signal", ticket: "fresh" });
    const recoveryFailure = vi.fn();
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const clientKeys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const sessionExpiresAt = Math.floor(Date.now() / 1_000) + 60;
    const gateway = new TeamWebRtcHostGateway({
      bridge,
      store,
      appVersion: "1.0.0",
      transferDirectory: join(directory, "transfers"),
      renewSignal,
      onSignalRecoveryFailure: recoveryFailure,
      closeSession,
      verifyClientTicket: async () => ({
        sessionId: "session-1",
        hostId: "host-1",
        userId: "member-account",
        membershipId: "membership-1",
        role: "member",
        authEpoch: 1,
        sessionExpiresAt,
        clientPublicKey: clientKeys.publicKey,
      }),
    });

    const starting = gateway.start({
      hostId: "host-1",
      signalUrl: "wss://signal.example.test/v1/signal",
      ticket: "initial",
      localApiPort: 43_210,
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
      sessionExpiresAt,
    });
    bridge.emit("connected", "host-1", {
      localFingerprint: "HOST-FINGERPRINT",
      remoteFingerprint: "CLIENT-FINGERPRINT",
    });
    const clientNonce = "c".repeat(43);
    const ticket = "client-ticket";
    bridge.emit(
      "data",
      "host-1",
      "rpc",
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "auth-init",
        ticket,
        clientPublicKey: clientKeys.publicKey,
        clientNonce,
        signature: sign(
          null,
          Buffer.from(
            teamProtocolV2AuthenticationTranscript({
              hostId: "host-1",
              sessionId: "session-1",
              ticket,
              clientPublicKey: clientKeys.publicKey,
              clientNonce,
              clientFingerprint: "CLIENT-FINGERPRINT",
              hostFingerprint: "HOST-FINGERPRINT",
            }),
          ),
          clientKeys.privateKey,
        ).toString("base64url"),
      }),
    );
    await vi.waitFor(() => expect(bridge.sent.some((message) => message.channel === "rpc")).toBe(true));
    const readyMessage = bridge.sent.find((message) => message.channel === "rpc");
    if (!readyMessage) throw new Error("Missing authentication response.");
    const ready = decodeTeamProtocolV2AuthFrame(readyMessage.data);
    if (ready.type !== "auth-ready") throw new Error("Unexpected authentication response.");
    bridge.emit(
      "data",
      "host-1",
      "rpc",
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "auth-complete",
        clientNonce: ready.clientNonce,
        hostNonce: ready.hostNonce,
      }),
    );
    await vi.waitFor(() =>
      expect(
        bridge.sent.some((message) => {
          if (message.channel !== "rpc" || !isString(message.data)) return false;
          try {
            return decodeTeamProtocolV2AuthFrame(message.data).type === "auth-confirmed";
          } catch {
            return false;
          }
        }),
      ).toBe(true),
    );
    let resolveFetch!: (response: Response) => void;
    const fetchRequest = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    const duplicateRequest = encodeTeamProtocolV2Frame({
      version: 2,
      type: "request",
      requestId: "duplicate-request",
      operation: "http.request",
      payload: { method: "POST", path: "/v1/mutation", body: { value: 1 } },
    });
    bridge.emit("data", "host-1", "rpc", duplicateRequest);
    bridge.emit("data", "host-1", "rpc", duplicateRequest);
    await vi.waitFor(() => expect(fetchRequest).toHaveBeenCalledOnce());
    resolveFetch(Response.json({ ok: true }));
    await vi.waitFor(() =>
      expect(
        bridge.sent.filter((message) => {
          if (message.channel !== "rpc" || !isString(message.data)) return false;
          try {
            return decodeTeamProtocolV2RpcFrame(message.data).type === "response";
          } catch {
            return false;
          }
        }),
      ).toHaveLength(2),
    );
    fetchRequest.mockRestore();
    bridge.emit("incoming", "host-1", {
      connectionId: "connection-2",
      sessionId: "session-1",
      userId: "member-account",
      membershipId: "membership-1",
      role: "member",
      sessionExpiresAt,
    });
    bridge.emit("connected", "host-1", {
      localFingerprint: "HOST-FINGERPRINT",
      remoteFingerprint: "CLIENT-FINGERPRINT",
    });
    expect(closeLocalSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    bridge.emit("incoming", "host-1", {
      connectionId: "connection-3",
      sessionId: "session-1",
      userId: "member-account",
      membershipId: "membership-1",
      role: "member",
      sessionExpiresAt,
    });
    bridge.emit("connected", "host-1", {
      localFingerprint: "HOST-FINGERPRINT",
      remoteFingerprint: "DIFFERENT-CLIENT-FINGERPRINT",
    });
    expect(closeLocalSession).toHaveBeenCalledWith("session-1");
    expect(closeSession).not.toHaveBeenCalled();
    bridge.emit("data", "host-1", "rpc", duplicateRequest);
    await vi.waitFor(() => expect(bridge.disconnectedPeers).toContain("host-1"));
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
