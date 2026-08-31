// @vitest-environment node

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcClientTransport } from "./team-webrtc-client-transport";

describe("TeamWebRtcClientTransport", () => {
  it("reuses the logical session after a WebRTC disconnect", async () => {
    const bridge = new TeamWebRtcBridge();
    vi.spyOn(bridge, "connect").mockImplementation(async ({ peerId }) => {
      queueMicrotask(() => bridge.emit("connected", peerId));
    });
    vi.spyOn(bridge, "send").mockResolvedValue();
    vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const startSession = vi
      .fn()
      .mockResolvedValue({ sessionId: "session-1", hostId: "host-1", expiresAt: Date.now() + 86_400_000 });
    const issueTicket = vi.fn().mockResolvedValue({
      ticket: "ticket",
      expiresAt: 2_000,
      signalUrl: "wss://signal.example.test/v1/signal",
    });
    const endSession = vi.fn().mockResolvedValue(undefined);
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [],
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

    await transport.connect("host-1");
    bridge.emit("disconnected", "host-1");
    await transport.connect("host-1");

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(issueTicket).toHaveBeenCalledTimes(2);
    expect(issueTicket).toHaveBeenNthCalledWith(2, "session-1");
    expect(endSession).not.toHaveBeenCalled();
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
      listHosts: async () => [],
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
      queueMicrotask(() => bridge.emit("connected", peerId));
    });
    vi.spyOn(bridge, "send").mockResolvedValue();
    vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const startSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "session-1", hostId: "host-1", expiresAt: Date.now() + 86_400_000 })
      .mockResolvedValueOnce({ sessionId: "session-2", hostId: "host-1", expiresAt: Date.now() + 86_400_000 });
    const endSession = vi.fn().mockResolvedValue(undefined);
    let principalId = "user-1";
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [],
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
      queueMicrotask(() => bridge.emit("connected", peerId));
    });
    vi.spyOn(bridge, "send").mockResolvedValue();
    vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const startSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: "session-1", hostId: "host-1", expiresAt: now + 100_000 })
      .mockResolvedValueOnce({ sessionId: "session-2", hostId: "host-1", expiresAt: now + 200_000 });
    const issueTicket = vi.fn().mockResolvedValue({
      ticket: "ticket",
      expiresAt: now + 60_000,
      signalUrl: "wss://signal.example.test/v1/signal",
    });
    const endSession = vi.fn().mockResolvedValue(undefined);
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [],
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

    await transport.connect("host-1");
    bridge.emit("disconnected", "host-1");
    nowSpy.mockReturnValue(now + 80_000);
    await transport.connect("host-1");

    expect(startSession).toHaveBeenCalledTimes(2);
    expect(issueTicket).toHaveBeenNthCalledWith(2, "session-2");
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
      listHosts: async () => [],
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
