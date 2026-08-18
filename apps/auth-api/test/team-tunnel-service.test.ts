import { describe, expect, it, vi } from "vitest";
import { CloudflareTunnelProvider } from "../src/server/cloudflare-tunnel-provider";
import {
  type TeamTunnelProvider,
  type TeamTunnelRecord,
  type TeamTunnelRepository,
  TeamTunnelService,
} from "../src/server/team-tunnel-service";

const serverId = "00000000-0000-4000-8000-000000000000";
const tunnelId = "11111111-1111-4111-8111-111111111111";
const user = { id: "user-1", email: "owner@example.com", name: null, avatarUrl: null };

class MemoryTeamTunnelRepository implements TeamTunnelRepository {
  record: TeamTunnelRecord | null = null;

  async claim(
    input: Omit<TeamTunnelRecord, "tunnelId" | "status"> & { now: number },
  ): Promise<TeamTunnelRecord> {
    this.record ??= { ...input, tunnelId: null, status: "provisioning" };
    return { ...this.record };
  }

  async setTunnelId(_serverId: string, value: string): Promise<void> {
    if (!this.record) throw new Error("Missing claim");
    this.record.tunnelId = value;
  }

  async markActive(): Promise<void> {
    if (!this.record) throw new Error("Missing claim");
    this.record.status = "active";
  }

  async find(serverId: string): Promise<TeamTunnelRecord | null> {
    return this.record?.serverId === serverId ? { ...this.record } : null;
  }

  async delete(serverId: string): Promise<void> {
    if (this.record?.serverId === serverId) this.record = null;
  }
}

function fakeProvider(): TeamTunnelProvider & { createTunnel: ReturnType<typeof vi.fn> } {
  return {
    findTunnelId: vi.fn(async () => null),
    createTunnel: vi.fn(async () => tunnelId),
    configureTunnel: vi.fn(async () => undefined),
    ensureDns: vi.fn(async () => undefined),
    getTunnelToken: vi.fn(async () => "x".repeat(80)),
    deleteDns: vi.fn(async () => undefined),
    deleteTunnel: vi.fn(async () => undefined),
  };
}

describe("TeamTunnelService", () => {
  it("claims a stable hostname and reuses one named tunnel", async () => {
    const repository = new MemoryTeamTunnelRepository();
    const provider = fakeProvider();
    const service = new TeamTunnelService({
      repository,
      provider,
      domain: "openbot.run",
      now: () => 1_000,
    });
    const first = await service.provision({
      user,
      serverId,
      serverName: "Studio Mac",
      apiPort: 43_123,
      vncEnabled: true,
    });
    const second = await service.provision({ user, serverId, serverName: "Studio Mac" });
    expect(first).toMatchObject({
      tunnelId,
      tunnelName: "openbot-00000000000040008000000000000000",
      apiUrl: "https://h-00000000000040008000000000000000.openbot.run",
      vncHostname: "vnc-h-00000000000040008000000000000000.openbot.run",
    });
    expect(second.tunnelId).toBe(tunnelId);
    expect(provider.createTunnel).toHaveBeenCalledTimes(1);
    expect(provider.configureTunnel).toHaveBeenNthCalledWith(1, {
      tunnelId,
      apiHostname: "h-00000000000040008000000000000000.openbot.run",
      vncHostname: "vnc-h-00000000000040008000000000000000.openbot.run",
      apiPort: 43_123,
      vncEnabled: true,
    });
  });

  it("does not let another account take a claimed server ID", async () => {
    const repository = new MemoryTeamTunnelRepository();
    repository.record = {
      serverId,
      userId: "other-user",
      tunnelId,
      tunnelName: "openbot-00000000000040008000000000000000",
      apiHostname: "h-00000000000040008000000000000000.openbot.run",
      vncHostname: "vnc-h-00000000000040008000000000000000.openbot.run",
      status: "active",
    };
    const service = new TeamTunnelService({
      repository,
      provider: fakeProvider(),
      domain: "openbot.run",
    });
    await expect(
      service.provision({ user, serverId, serverName: "Studio Mac" }),
    ).rejects.toMatchObject({ code: "team_tunnel_owner_mismatch", status: 403 });
  });

  it("removes DNS and the tunnel only for its owner", async () => {
    const repository = new MemoryTeamTunnelRepository();
    const provider = fakeProvider();
    const service = new TeamTunnelService({ repository, provider, domain: "openbot.run" });
    await service.provision({ user, serverId, serverName: "Studio Mac" });
    await service.deprovision(user, serverId);
    expect(provider.deleteDns).toHaveBeenCalledTimes(2);
    expect(provider.deleteTunnel).toHaveBeenCalledWith(tunnelId);
    expect(repository.record).toBeNull();
  });
});

describe("CloudflareTunnelProvider", () => {
  it("configures API and VNC ingress and creates stable DNS records", async () => {
    const requests: Array<{ path: string; method: string; body: unknown; auth: string | null }> =
      [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? "GET";
      requests.push({
        path: `${url.pathname}${url.search}`,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        auth: new Headers(init?.headers).get("Authorization"),
      });
      if (url.pathname.endsWith("/token")) {
        return Response.json({ success: true, result: "t".repeat(80) });
      }
      if (url.pathname.endsWith("/dns_records") && method === "GET") {
        return Response.json({ success: true, result: [] });
      }
      return Response.json({ success: true, result: {} });
    });
    const provider = new CloudflareTunnelProvider({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      apiToken: "secret",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await provider.configureTunnel({
      tunnelId,
      apiHostname: "h-00000000000040008000000000000000.openbot.run",
      vncHostname: "vnc-h-00000000000040008000000000000000.openbot.run",
      apiPort: 43_123,
      vncEnabled: true,
    });
    await provider.ensureDns("h-00000000000040008000000000000000.openbot.run", tunnelId);
    await expect(provider.getTunnelToken(tunnelId)).resolves.toHaveLength(80);
    expect(requests[0]?.body).toEqual({
      config: {
        ingress: [
          {
            hostname: "h-00000000000040008000000000000000.openbot.run",
            service: "http://127.0.0.1:43123",
            originRequest: {},
          },
          {
            hostname: "vnc-h-00000000000040008000000000000000.openbot.run",
            service: "tcp://127.0.0.1:5900",
            originRequest: {},
          },
          { service: "http_status:404" },
        ],
      },
    });
    expect(requests.some((request) => request.method === "POST" && request.body !== null)).toBe(
      true,
    );
    expect(requests.every((request) => request.auth === "Bearer secret")).toBe(true);
  });
});
