import { describe, expect, it } from "vitest";
import type { RemoteTicketClaims } from "../src/protocol";
import { SignalService, type SignalSocket } from "../src/signal-service";

describe("SignalService", () => {
  it("does not close active WebRTC when a Signal socket reconnects", async () => {
    const service = new SignalService(fakeTokens(), 8);
    const host = socket("host");
    const client = socket("client");
    await hello(service, host, "host-ticket", "host");
    await hello(service, client, "client-ticket", "client");
    expect(
      client.messages.some((message) => message.includes('"type":"ready"') && message.includes('"connectionId":"')),
    ).toBe(true);

    service.disconnect(client);
    expect(host.messages.some((message) => message.includes('"type":"disconnect"'))).toBe(false);

    const resumed = socket("client-resumed");
    await hello(service, resumed, "resume-client", "client");
    expect(
      resumed.messages.some((message) => message.includes('"type":"ready"') && message.includes('"connectionId":"')),
    ).toBe(true);
    expect(host.messages.filter((message) => message.includes('"type":"peer-ready"'))).toHaveLength(2);
  });

  it("rejects reuse of an initial ticket and closes revoked clients", async () => {
    const service = new SignalService(fakeTokens(), 8);
    const host = socket("host");
    await hello(service, host, "host-ticket", "host");
    const first = socket("client-one");
    await hello(service, first, "client-ticket", "client");
    const replay = socket("client-two");
    await hello(service, replay, "client-ticket", "client");
    expect(replay.messages.at(-1)).toContain('"code":"authentication_required"');
    expect(replay.closed).toBe(true);

    service.revoke("host-1", 2);
    expect(first.messages.at(-1)).toContain('"code":"session_revoked"');
    expect(first.closed).toBe(true);
    expect(host.closed).toBe(false);
  });

  it("does not let an owner client ticket impersonate the host", async () => {
    const service = new SignalService(fakeTokens(), 8);
    const host = socket("fake-host");
    await hello(service, host, "owner-ticket", "host");
    expect(host.messages.at(-1)).toContain('"code":"authentication_required"');
    expect(host.closed).toBe(true);
  });
});

function fakeTokens() {
  const now = Math.floor(Date.now() / 1_000);
  const claims = (role: "host" | "owner" | "member", jti: string): RemoteTicketClaims => ({
    aud: "openbot-remote",
    jti,
    sessionId: role === "host" ? "host-session" : "client-session",
    hostId: "host-1",
    userId: role === "host" ? "owner-1" : "user-1",
    membershipId: role === "host" ? "host-1:host" : "member-1",
    role,
    authEpoch: 1,
    protocolMinimum: 2,
    protocolMaximum: 2,
    sessionExpiresAt: now + 86_400,
    iat: now,
    exp: now + 300,
  });
  return {
    verifyTicket: async (token: string) => {
      if (token === "host-ticket") return claims("host", "host-jti");
      if (token === "client-ticket") return claims("member", "client-jti");
      if (token === "owner-ticket") return claims("owner", "owner-jti");
      throw new Error("not an initial ticket");
    },
    verifyResumeToken: async (token: string) => {
      if (token === "resume-client") return claims("member", "resume-jti");
      throw new Error("not a resume token");
    },
    issueResumeToken: async (value: RemoteTicketClaims) => `resume-${value.role === "host" ? "host" : "client"}`,
    iceServers: () => [{ urls: "stun:turn.example.com:3478" }],
  };
}

interface TestSignalSocket extends SignalSocket {
  messages: string[];
  closed: boolean;
}

function socket(id: string): TestSignalSocket {
  const messages: string[] = [];
  const target: TestSignalSocket = {
    id,
    ip: `192.0.2.${id.length}`,
    messages,
    closed: false,
    send: (message) => {
      messages.push(message);
    },
    close: () => {
      target.closed = true;
    },
  };
  return target;
}

async function hello(service: SignalService, target: SignalSocket, token: string, peer: "host" | "client") {
  await service.receive(target, JSON.stringify({ type: "hello", version: 1, peer, token }));
}
