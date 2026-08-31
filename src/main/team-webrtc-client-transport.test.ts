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
    const startSession = vi.fn().mockResolvedValue({ sessionId: "session-1", hostId: "host-1", expiresAt: 2_000 });
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
});
