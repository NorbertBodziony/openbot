// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isString } from "@openbot/contracts/runtime-values";
import { TEAM_AGENT_ACTIVITY_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { decodeTeamProtocolV1ClientEvent } from "@openbot/contracts/team-protocol/v1";
import {
  decodeTeamProtocolV2AuthFrame,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2Frame,
  teamProtocolV2AuthenticationTranscript,
} from "@openbot/contracts/team-protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { TeamStore } from "./team-store";
import { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcHostGateway } from "./team-webrtc-host-gateway";

const directories: string[] = [];
const serverCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(serverCleanups.splice(0).map((cleanup) => cleanup()));
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
  it("refreshes an early event subscription when the peer capabilities arrive", async () => {
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
    const eventScopes: Array<
      Extract<ReturnType<typeof decodeTeamProtocolV1ClientEvent>, { type: "agent-event-scope" }>
    > = [];
    const localServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const eventsServer = new WebSocketServer({ server: localServer });
    eventsServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        const event = decodeTeamProtocolV1ClientEvent(JSON.parse(data.toString()));
        if (event.type === "agent-event-scope") eventScopes.push(event);
      });
    });
    await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
    const address = localServer.address();
    if (!address || typeof address === "string") throw new Error("The local Team API did not open a TCP port.");
    serverCleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of eventsServer.clients) client.terminate();
          eventsServer.close(() => localServer.close(() => resolve()));
        }),
    );
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
      localApiPort: address.port,
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
    bridge.emit(
      "data",
      "host-1",
      "events",
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "event-control",
        control: { type: "runtime-snapshot-request" },
      }),
    );
    await vi.waitFor(() => expect(eventScopes).toHaveLength(1));
    expect(eventScopes[0]?.capabilities).toEqual([]);
    bridge.emit(
      "data",
      "host-1",
      "rpc",
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "request",
        requestId: "capability-request",
        operation: "http.request",
        payload: {
          method: "GET",
          path: "/v1/agents",
          body: null,
          capabilities: [TEAM_AGENT_ACTIVITY_CAPABILITY],
        },
      }),
    );
    await vi.waitFor(() => expect(eventScopes).toHaveLength(2));
    expect(eventScopes[1]?.capabilities).toContain(TEAM_AGENT_ACTIVITY_CAPABILITY);
    let resolveFetch!: (response: Response) => void;
    const fetchRequest = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    const duplicateRequest = encodeTeamProtocolV2Frame({
      version: 2,
      type: "request",
      requestId: "duplicate-request",
      operation: "http.request",
      payload: { method: "POST", path: "/v1/browser/visible", body: { visible: true } },
    });
    bridge.emit("data", "host-1", "rpc", duplicateRequest);
    bridge.emit("data", "host-1", "rpc", duplicateRequest);
    await vi.waitFor(() => expect(fetchRequest).toHaveBeenCalledOnce());
    resolveFetch(Response.json({ visible: true }));
    await vi.waitFor(() =>
      expect(
        bridge.sent.filter((message) => {
          if (message.channel !== "rpc" || !isString(message.data)) return false;
          try {
            const frame = decodeTeamProtocolV2RpcFrame(message.data);
            return frame.type === "response" && frame.requestId === "duplicate-request";
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
