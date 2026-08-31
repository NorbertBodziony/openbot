import { describe, expect, it, vi } from "vitest";
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

  it("restores the client mapping when only the host Signal socket reconnects", async () => {
    const service = new SignalService(fakeTokens(), 8);
    const host = socket("host");
    const client = socket("client");
    await hello(service, host, "host-ticket", "host");
    await hello(service, client, "client-ticket", "client");

    service.disconnect(host);
    const resumedHost = socket("host-resumed");
    await hello(service, resumedHost, "resume-host", "host");
    const ready = [...client.messages]
      .reverse()
      .find((message) => message.includes('"type":"ready"') && message.includes('"connectionId":"'));
    const connectionId = ready?.match(/"connectionId":"([A-Za-z0-9_-]+)"/u)?.[1];
    expect(connectionId).toBeTruthy();
    expect(resumedHost.messages.some((message) => message.includes('"type":"peer-ready"'))).toBe(true);

    await service.receive(
      client,
      JSON.stringify({ type: "ice-restart", version: 1, connectionId: connectionId ?? "missing", channel: "team" }),
    );
    expect(resumedHost.messages.at(-1)).toContain('"type":"ice-restart"');
    expect(client.closed).toBe(false);
  });

  it("notifies the host when an interrupted client does not reconnect", async () => {
    vi.useFakeTimers();
    try {
      const service = new SignalService(fakeTokens(), 8);
      const host = socket("host");
      const client = socket("client");
      await hello(service, host, "host-ticket", "host");
      await hello(service, client, "client-ticket", "client");

      service.disconnect(client);
      expect(host.messages.some((message) => message.includes('"type":"disconnect"'))).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(host.messages.at(-1)).toContain('"type":"disconnect"');
    } finally {
      vi.useRealTimers();
    }
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
    expect(host.messages.some((message) => message.includes('"type":"disconnect"'))).toBe(true);
    expect(host.messages.at(-1)).toContain('"code":"session_revoked"');
    expect(host.closed).toBe(true);

    const staleHost = socket("stale-host");
    await hello(service, staleHost, "stale-host-ticket", "host");
    expect(staleHost.messages.at(-1)).toContain('"code":"authentication_required"');
    expect(staleHost.closed).toBe(true);
  });

  it("does not let an owner client ticket impersonate the host", async () => {
    const service = new SignalService(fakeTokens(), 8);
    const host = socket("fake-host");
    await hello(service, host, "owner-ticket", "host");
    expect(host.messages.at(-1)).toContain('"code":"authentication_required"');
    expect(host.closed).toBe(true);
  });

  it("rejects a second logical client session while the host is in use", async () => {
    const service = new SignalService(fakeTokens(), 8);
    await hello(service, socket("host"), "host-ticket", "host");
    await hello(service, socket("first-client"), "client-ticket", "client");
    const second = socket("second-client");
    await hello(service, second, "second-client-ticket", "client");
    expect(second.messages.at(-1)).toContain('"code":"host_busy"');
    expect(second.closed).toBe(true);
  });

  it("limits unauthenticated sockets and revokes one logical session", async () => {
    const service = new SignalService(fakeTokens(), 8, 1);
    const pending = socket("pending", "192.0.2.10");
    const rejected = socket("rejected", "192.0.2.10");
    expect(service.connect(pending)).toBe(true);
    expect(service.connect(rejected)).toBe(false);
    expect(rejected.messages.at(-1)).toContain('"code":"rate_limited"');

    service.disconnect(pending);
    const host = socket("host");
    const client = socket("client");
    await hello(service, host, "host-ticket", "host");
    await hello(service, client, "client-ticket", "client");
    service.revokeSession("client-session");
    expect(client.messages.at(-1)).toContain('"code":"session_revoked"');
    expect(client.closed).toBe(true);
    expect(host.messages.at(-1)).toContain('"type":"disconnect"');
  });
});

function fakeTokens() {
  const now = Math.floor(Date.now() / 1_000);
  const claims = (
    role: "host" | "owner" | "member",
    jti: string,
    sessionId = role === "host" ? "host-session" : "client-session",
  ): RemoteTicketClaims => ({
    aud: "openbot-remote",
    jti,
    sessionId,
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
      if (token === "stale-host-ticket") return claims("host", "stale-host-jti");
      if (token === "client-ticket") return claims("member", "client-jti");
      if (token === "second-client-ticket") return claims("member", "second-client-jti", "second-client-session");
      if (token === "owner-ticket") return claims("owner", "owner-jti");
      throw new Error("not an initial ticket");
    },
    verifyResumeToken: async (token: string) => {
      if (token === "resume-client") return claims("member", "resume-jti");
      if (token === "resume-host") return claims("host", "resume-host-jti");
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

function socket(id: string, ip = `192.0.2.${id.length}`): TestSignalSocket {
  const messages: string[] = [];
  const target: TestSignalSocket = {
    id,
    ip,
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
  service.connect(target);
  await service.receive(target, JSON.stringify({ type: "hello", version: 1, peer, token }));
}
