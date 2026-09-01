// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isString } from "@openbot/contracts/runtime-values";
import {
  decodeTeamProtocolV2AuthFrame,
  encodeTeamProtocolV2Frame,
  type TeamProtocolV2AuthFrame,
  teamProtocolV2AuthenticationTranscript,
} from "@openbot/contracts/team-protocol/v2";
import { describe, expect, it, vi } from "vitest";
import { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcClientTransport } from "./team-webrtc-client-transport";

const hostKeys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const channelBinding = { localFingerprint: "CLIENT-FINGERPRINT", remoteFingerprint: "HOST-FINGERPRINT" };
const listedHost = {
  hostId: "host-1",
  name: "Host",
  logoKey: null,
  devicePublicKey: hostKeys.publicKey,
  authEpoch: 1,
  membershipId: "member-1",
  role: "member" as const,
};

function mockAuthenticatedSend(bridge: TeamWebRtcBridge, automaticallyConfirm = true) {
  const pendingConfirmations: Array<() => void> = [];
  const send = vi.spyOn(bridge, "send").mockImplementation(async (hostId, channel, data) => {
    if (channel !== "rpc" || !isString(data)) return;
    let frame: TeamProtocolV2AuthFrame;
    try {
      frame = decodeTeamProtocolV2AuthFrame(data);
    } catch {
      return;
    }
    if (frame.type === "auth-complete") {
      const confirm = () =>
        bridge.emit(
          "data",
          hostId,
          "rpc",
          encodeTeamProtocolV2Frame({
            version: 2,
            type: "auth-confirmed",
            clientNonce: frame.clientNonce,
            hostNonce: frame.hostNonce,
          }),
        );
      if (automaticallyConfirm) queueMicrotask(confirm);
      else pendingConfirmations.push(confirm);
      return;
    }
    if (frame.type !== "auth-init") return;
    const hostNonce = "h".repeat(43);
    const transcript = teamProtocolV2AuthenticationTranscript({
      hostId,
      sessionId: frame.ticket,
      ticket: frame.ticket,
      clientPublicKey: frame.clientPublicKey,
      clientNonce: frame.clientNonce,
      hostNonce,
      clientFingerprint: channelBinding.localFingerprint,
      hostFingerprint: channelBinding.remoteFingerprint,
    });
    queueMicrotask(() =>
      bridge.emit(
        "data",
        hostId,
        "rpc",
        encodeTeamProtocolV2Frame({
          version: 2,
          type: "auth-ready",
          clientNonce: frame.clientNonce,
          hostNonce,
          signature: sign(null, Buffer.from(transcript), hostKeys.privateKey).toString("base64url"),
        }),
      ),
    );
  });
  return {
    send,
    pendingConfirmations,
    confirmNext: () => pendingConfirmations.shift()?.(),
  };
}

describe("TeamWebRtcClientTransport", () => {
  it("reuses the logical session after a WebRTC disconnect", async () => {
    const bridge = new TeamWebRtcBridge();
    vi.spyOn(bridge, "connect").mockImplementation(async ({ peerId }) => {
      queueMicrotask(() => bridge.emit("connected", peerId, channelBinding));
    });
    const authentication = mockAuthenticatedSend(bridge, false);
    const disconnectBridge = vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const startSession = vi
      .fn()
      .mockResolvedValue({ sessionId: "session-1", hostId: "host-1", expiresAt: Date.now() + 86_400_000 });
    const issueTicket = vi.fn((sessionId: string, _clientPublicKey: string) =>
      Promise.resolve({
        ticket: sessionId,
        expiresAt: 2_000,
        signalUrl: "wss://signal.example.test/v1/signal",
      }),
    );
    const endSession = vi.fn().mockResolvedValue(undefined);
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [listedHost],
      startSession,
      issueTicket,
      endSession,
      createInvite: async () => ({ inviteId: "invite", token: "token", expiresAt: 2_000 }),
      listInvites: async () => [],
      previewInvite: async () => ({
        inviteId: "invite",
        hostId: "host-1",
        hostName: "Host",
        role: "member",
        expiresAt: 2_000,
        emailBound: false,
        devicePublicKey: null,
      }),
      acceptInvite: async () => ({ hostId: "host-1", membershipId: "member-1", role: "member" }),
      revokeInvite: async () => undefined,
      listMembers: async () => [],
      updateMember: async () => undefined,
      removeMember: async () => undefined,
      getPrincipalId: () => "user-1",
      controlPlaneUrl: "https://api.example.test",
      downloadHostLogo: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
      transferDirectory: join(tmpdir(), "openbot-webrtc-client-test"),
    });
    await transport.listHosts();
    await expect(transport.connect("host-1")).rejects.toThrow("pinned device key");
    expect(startSession).not.toHaveBeenCalled();
    transport.pinHostKey("host-1", hostKeys.publicKey);
    const protocolError = vi.fn();
    transport.on("error", protocolError);

    bridge.emit("connected", "host-1", channelBinding);
    bridge.emit("data", "host-1", "rpc", "host-gateway-data");
    bridge.emit("path", "host-1", "p2p");
    bridge.emit("error", "host-1", "data_channel_error", "host gateway event");
    bridge.emit("disconnected", "host-1");
    await Promise.resolve();
    expect(disconnectBridge).not.toHaveBeenCalled();
    expect(protocolError).not.toHaveBeenCalled();

    const initialConnection = transport.connect("host-1");
    await vi.waitFor(() => expect(authentication.pendingConfirmations).toHaveLength(1));
    expect(bridge.send).not.toHaveBeenCalledWith("host-1", "events", expect.any(String));
    authentication.confirmNext();
    await initialConnection;
    bridge.emit("data", "host-1", "events", JSON.stringify({ version: 2, type: "event-reset", nextSequence: 2_001 }));
    bridge.emit(
      "data",
      "host-1",
      "events",
      JSON.stringify({ version: 2, type: "event", sequence: 2_001, payload: null }),
    );
    expect(bridge.send).toHaveBeenCalledWith(
      "host-1",
      "events",
      JSON.stringify({
        version: 2,
        type: "event-control",
        control: { type: "runtime-snapshot-request" },
      }),
    );
    bridge.emit("disconnected", "host-1");
    const reconnection = transport.connect("host-1");
    await vi.waitFor(() => expect(authentication.pendingConfirmations).toHaveLength(1));
    authentication.confirmNext();
    await reconnection;

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(issueTicket).toHaveBeenCalledTimes(2);
    expect(issueTicket).toHaveBeenNthCalledWith(2, "session-1", expect.stringContaining("PUBLIC KEY"));
    expect(issueTicket.mock.calls[0]?.[1]).toBe(issueTicket.mock.calls[0]?.[1].trim());
    expect(endSession).not.toHaveBeenCalled();
    expect(bridge.send).toHaveBeenLastCalledWith(
      "host-1",
      "events",
      JSON.stringify({ version: 2, type: "event-ack", throughSequence: 0 }),
    );
    const malformedRequest = transport.request("host-1", "/v1/agents");
    const malformedRejection = expect(malformedRequest).rejects.toMatchObject({ code: "protocol_error" });
    await vi.waitFor(() => expect(bridge.send).toHaveBeenCalledWith("host-1", "rpc", expect.any(String)));
    bridge.emit(
      "data",
      "host-1",
      "rpc",
      JSON.stringify({
        version: 2,
        type: "request",
        requestId: "host-request",
        operation: "GET /v1/agents",
        payload: null,
      }),
    );
    await malformedRejection;
    expect(protocolError).toHaveBeenCalledWith("host-1", "protocol_error", expect.any(String));
    await vi.waitFor(() => expect(bridge.disconnect).toHaveBeenCalledWith("host-1"));
    await transport.stop();
  });

  it("cancels a connection before a delayed session start can restore it", async () => {
    const bridge = new TeamWebRtcBridge();
    const connectBridge = vi.spyOn(bridge, "connect").mockResolvedValue();
    vi.spyOn(bridge, "send").mockResolvedValue();
    vi.spyOn(bridge, "disconnect").mockResolvedValue();
    let resolveSession!: (value: { sessionId: string; hostId: string; expiresAt: number }) => void;
    const startSession = vi.fn(
      () =>
        new Promise<{ sessionId: string; hostId: string; expiresAt: number }>((resolve) => {
          resolveSession = resolve;
        }),
    );
    const endSession = vi.fn().mockResolvedValue(undefined);
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [listedHost],
      startSession,
      issueTicket: async () => ({
        ticket: "ticket",
        expiresAt: 2_000,
        signalUrl: "wss://signal.example.test/v1/signal",
      }),
      endSession,
      createInvite: async () => ({ inviteId: "invite", token: "token", expiresAt: 2_000 }),
      listInvites: async () => [],
      previewInvite: async () => ({
        inviteId: "invite",
        hostId: "host-1",
        hostName: "Host",
        role: "member",
        expiresAt: 2_000,
        emailBound: false,
        devicePublicKey: null,
      }),
      acceptInvite: async () => ({ hostId: "host-1", membershipId: "member-1", role: "member" }),
      revokeInvite: async () => undefined,
      listMembers: async () => [],
      updateMember: async () => undefined,
      removeMember: async () => undefined,
      getPrincipalId: () => "user-1",
      controlPlaneUrl: "https://api.example.test",
      downloadHostLogo: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
      transferDirectory: join(tmpdir(), "openbot-webrtc-client-cancel-test"),
    });
    transport.pinHostKey("host-1", hostKeys.publicKey);

    const connection = transport.connect("host-1");
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledOnce());
    await transport.disconnect("host-1");
    resolveSession({ sessionId: "session-1", hostId: "host-1", expiresAt: Date.now() + 86_400_000 });

    await expect(connection).rejects.toThrow("cancelled");
    expect(connectBridge).not.toHaveBeenCalled();
    expect(endSession).toHaveBeenCalledWith("session-1");
    await transport.stop();
  });

  it("does not reuse a remote session after the signed-in principal changes", async () => {
    const bridge = new TeamWebRtcBridge();
    vi.spyOn(bridge, "connect").mockImplementation(async ({ peerId }) => {
      queueMicrotask(() => bridge.emit("connected", peerId, channelBinding));
    });
    mockAuthenticatedSend(bridge);
    vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const startSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "session-1", hostId: "host-1", expiresAt: Date.now() + 86_400_000 })
      .mockResolvedValueOnce({ sessionId: "session-2", hostId: "host-1", expiresAt: Date.now() + 86_400_000 });
    const endSession = vi.fn().mockResolvedValue(undefined);
    let principalId = "user-1";
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [listedHost],
      startSession,
      issueTicket: async (sessionId) => ({
        ticket: sessionId,
        expiresAt: 2_000,
        signalUrl: "wss://signal.example.test/v1/signal",
      }),
      endSession,
      createInvite: async () => ({ inviteId: "invite", token: "token", expiresAt: 2_000 }),
      listInvites: async () => [],
      previewInvite: async () => ({
        inviteId: "invite",
        hostId: "host-1",
        hostName: "Host",
        role: "member",
        expiresAt: 2_000,
        emailBound: false,
        devicePublicKey: null,
      }),
      acceptInvite: async () => ({ hostId: "host-1", membershipId: "member-1", role: "member" }),
      revokeInvite: async () => undefined,
      listMembers: async () => [],
      updateMember: async () => undefined,
      removeMember: async () => undefined,
      getPrincipalId: () => principalId,
      controlPlaneUrl: "https://api.example.test",
      downloadHostLogo: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
      transferDirectory: join(tmpdir(), "openbot-webrtc-client-principal-test"),
    });
    transport.pinHostKey("host-1", hostKeys.publicKey);

    await transport.connect("host-1");
    principalId = "user-2";
    await transport.connect("host-1");

    expect(startSession).toHaveBeenCalledTimes(2);
    expect(endSession).toHaveBeenCalledWith("session-1");
    await transport.stop();
  });

  it("replaces a logical session before it expires", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const bridge = new TeamWebRtcBridge();
    vi.spyOn(bridge, "connect").mockImplementation(async ({ peerId }) => {
      queueMicrotask(() => bridge.emit("connected", peerId, channelBinding));
    });
    mockAuthenticatedSend(bridge);
    vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const startSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "session-1", hostId: "host-1", expiresAt: now + 100_000 })
      .mockResolvedValueOnce({ sessionId: "session-2", hostId: "host-1", expiresAt: now + 200_000 });
    const issueTicket = vi.fn((sessionId: string) =>
      Promise.resolve({
        ticket: sessionId,
        expiresAt: now + 60_000,
        signalUrl: "wss://signal.example.test/v1/signal",
      }),
    );
    const endSession = vi.fn().mockResolvedValue(undefined);
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [listedHost],
      startSession,
      issueTicket,
      endSession,
      createInvite: async () => ({ inviteId: "invite", token: "token", expiresAt: now + 60_000 }),
      listInvites: async () => [],
      previewInvite: async () => ({
        inviteId: "invite",
        hostId: "host-1",
        hostName: "Host",
        role: "member",
        expiresAt: now + 60_000,
        emailBound: false,
        devicePublicKey: null,
      }),
      acceptInvite: async () => ({ hostId: "host-1", membershipId: "member-1", role: "member" }),
      revokeInvite: async () => undefined,
      listMembers: async () => [],
      updateMember: async () => undefined,
      removeMember: async () => undefined,
      getPrincipalId: () => "user-1",
      controlPlaneUrl: "https://api.example.test",
      downloadHostLogo: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
      transferDirectory: join(tmpdir(), "openbot-webrtc-client-expiration-test"),
    });
    transport.pinHostKey("host-1", hostKeys.publicKey);

    await transport.connect("host-1");
    bridge.emit("disconnected", "host-1");
    nowSpy.mockReturnValue(now + 80_000);
    await transport.connect("host-1");

    expect(startSession).toHaveBeenCalledTimes(2);
    expect(issueTicket).toHaveBeenNthCalledWith(2, "session-2", expect.stringContaining("PUBLIC KEY"));
    expect(endSession).toHaveBeenCalledWith("session-1");
    await transport.stop();
    nowSpy.mockRestore();
  });

  it("rejects every concurrent caller when the bridge connection fails", async () => {
    const bridge = new TeamWebRtcBridge();
    let rejectBridge!: (error: Error) => void;
    const connectBridge = vi.spyOn(bridge, "connect").mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectBridge = reject;
        }),
    );
    vi.spyOn(bridge, "send").mockResolvedValue();
    vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const endSession = vi.fn().mockResolvedValue(undefined);
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [listedHost],
      startSession: async () => ({
        sessionId: "session-1",
        hostId: "host-1",
        expiresAt: Date.now() + 86_400_000,
      }),
      issueTicket: async () => ({
        ticket: "ticket",
        expiresAt: Date.now() + 180_000,
        signalUrl: "wss://signal.example.test/v1/signal",
      }),
      endSession,
      createInvite: async () => ({ inviteId: "invite", token: "token", expiresAt: Date.now() + 60_000 }),
      listInvites: async () => [],
      previewInvite: async () => ({
        inviteId: "invite",
        hostId: "host-1",
        hostName: "Host",
        role: "member",
        expiresAt: Date.now() + 60_000,
        emailBound: false,
        devicePublicKey: null,
      }),
      acceptInvite: async () => ({ hostId: "host-1", membershipId: "member-1", role: "member" }),
      revokeInvite: async () => undefined,
      listMembers: async () => [],
      updateMember: async () => undefined,
      removeMember: async () => undefined,
      getPrincipalId: () => "user-1",
      controlPlaneUrl: "https://api.example.test",
      downloadHostLogo: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
      transferDirectory: join(tmpdir(), "openbot-webrtc-client-failure-test"),
    });
    transport.pinHostKey("host-1", hostKeys.publicKey);

    const first = transport.connect("host-1");
    await vi.waitFor(() => expect(connectBridge).toHaveBeenCalledOnce());
    const second = transport.connect("host-1");
    rejectBridge(new Error("bridge failed"));
    const results = await Promise.allSettled([first, second]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "rejected" && result.reason.message === "bridge failed")).toBe(
      true,
    );
    expect(endSession).toHaveBeenCalledWith("session-1");
    await transport.stop();
  });
});
