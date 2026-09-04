// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEAM_CURRENT_CAPABILITIES } from "@openbot/contracts/team-protocol/current";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBrowserPreviewFromHost, decodeBrowserTab } from "./remote-device-decoding";
import { RemoteServerManager } from "./remote-server-manager";
import {
  createRemoteManager,
  fakeWebRtcTransport,
  stopRemoteFixtures,
  storedHttpsServer,
  stubEventSockets,
  stubTeamFetch,
  waitForServer,
} from "./remote-server-test-harness";
import { remoteAttachmentPreviewUrl } from "./remote-server-urls";
import { fingerprint } from "./team-store";
import { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcClientTransport, TeamWebRtcRequestError } from "./team-webrtc-client-transport";

afterEach(async () => {
  await stopRemoteFixtures();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("remote browser responses", () => {
  it("decodes an opened browser tab", () => {
    expect(
      decodeBrowserTab({
        id: "tab-1",
        title: "Example",
        url: "https://example.com/",
        loading: false,
        ownerThreadId: "thread-1",
        ownerBotId: "bot-1",
      }),
    ).toMatchObject({ id: "tab-1", url: "https://example.com/" });
    expect(() => decodeBrowserTab(undefined)).toThrowError("Invalid remote browser tab.");
  });

  it("accepts only bounded JPEG browser previews", () => {
    expect(
      decodeBrowserPreviewFromHost({
        dataUrl: "data:image/jpeg;base64,YWJj",
        width: 960,
        height: 600,
      }),
    ).toMatchObject({ width: 960, height: 600 });
    expect(() =>
      decodeBrowserPreviewFromHost({
        dataUrl: "data:image/png;base64,YWJj",
        width: 960,
        height: 600,
      }),
    ).toThrowError("Invalid remote browser preview.");
  });
});

describe("remote server links", () => {
  it("creates token-free preview URLs", () => {
    const preview = remoteAttachmentPreviewUrl("00000000-0000-4000-8000-000000000000", "draft 1");
    expect(preview).toBe("openbot-remote-attachment://00000000-0000-4000-8000-000000000000/draft%201");
    expect(preview).not.toContain("token");
  });

  it("rejects a WebRTC invitation whose pinned host key does not match the control plane", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-invite-key-"));
    const statePath = join(directory, "servers.json");
    const hostId = "00000000-0000-4000-8000-000000000000";
    const acceptInvite = vi.fn();
    const bridge = new TeamWebRtcBridge();
    vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [],
      startSession: async () => ({ sessionId: "session-1", hostId, expiresAt: Date.now() + 60_000 }),
      issueTicket: async () => ({
        ticket: "ticket",
        expiresAt: Date.now() + 60_000,
        signalUrl: "wss://signal.openbot.run/v1/signal",
      }),
      endSession: async () => undefined,
      createInvite: async () => ({ inviteId: "invite-1", token: "t".repeat(43), expiresAt: Date.now() + 60_000 }),
      listInvites: async () => [],
      previewInvite: async () => ({
        inviteId: "invite-1",
        hostId,
        hostName: "Studio Mac",
        role: "member" as const,
        expiresAt: Date.now() + 60_000,
        emailBound: false,
        devicePublicKey: "trusted-host-public-key",
      }),
      acceptInvite,
      revokeInvite: async () => undefined,
      listMembers: async () => [],
      updateMember: async () => undefined,
      removeMember: async () => undefined,
      getPrincipalId: () => "person-1",
      controlPlaneUrl: "https://api.openbot.run",
      downloadHostLogo: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
      transferDirectory: join(directory, "transfers"),
    });
    const manager = new RemoteServerManager(
      statePath,
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      { createTeamAuthTicket: async () => "ticket", getEmail: () => "person@example.com" },
      { webrtcTransport: transport },
    );
    const inviteUrl = new URL("https://openbot.run/join");
    inviteUrl.searchParams.set("api", "https://api.openbot.run");
    inviteUrl.searchParams.set("server", hostId);
    inviteUrl.searchParams.set("fingerprint", fingerprint("attacker-public-key"));
    inviteUrl.searchParams.set("invite", "b".repeat(43));
    try {
      await manager.initialize();
      await expect(manager.join({ inviteUrl: inviteUrl.toString() })).rejects.toThrow("identity");
      expect(acceptInvite).not.toHaveBeenCalled();
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("disconnects a stored WebRTC host removed from the authenticated directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-revoked-host-"));
    const statePath = join(directory, "servers.json");
    const hostId = "revoked-host";
    await writeFile(
      statePath,
      JSON.stringify({
        version: 3,
        activeServerId: hostId,
        servers: [
          {
            id: hostId,
            name: "Revoked host",
            apiUrl: `webrtc://${hostId}`,
            fingerprint: fingerprint("trusted-host-public-key"),
            publicKey: "trusted-host-public-key",
            username: "person@example.com",
            encryptedToken: "",
            remoteDesktopAvailable: true,
            logoVersion: null,
            role: "member",
            transport: "webrtc-v2",
          },
        ],
      }),
    );
    const bridge = new TeamWebRtcBridge();
    const disconnect = vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [],
      startSession: async () => ({ sessionId: "session-1", hostId, expiresAt: Date.now() + 60_000 }),
      issueTicket: async () => ({
        ticket: "ticket",
        expiresAt: Date.now() + 60_000,
        signalUrl: "wss://signal.openbot.run/v1/signal",
      }),
      endSession: async () => undefined,
      createInvite: async () => ({ inviteId: "invite-1", token: "token", expiresAt: Date.now() + 60_000 }),
      listInvites: async () => [],
      previewInvite: async () => ({
        inviteId: "invite-1",
        hostId,
        hostName: "Revoked host",
        role: "member",
        expiresAt: Date.now() + 60_000,
        emailBound: false,
        devicePublicKey: "trusted-host-public-key",
      }),
      acceptInvite: async () => ({ hostId, membershipId: "membership-1", role: "member" }),
      revokeInvite: async () => undefined,
      listMembers: async () => [],
      updateMember: async () => undefined,
      removeMember: async () => undefined,
      getPrincipalId: () => "person-1",
      controlPlaneUrl: "https://api.openbot.run",
      downloadHostLogo: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
      transferDirectory: join(directory, "transfers"),
    });
    const manager = new RemoteServerManager(
      statePath,
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      { createTeamAuthTicket: async () => "ticket", getEmail: () => "person@example.com" },
      { webrtcTransport: transport },
    );

    try {
      await manager.initialize();
      expect(disconnect).toHaveBeenCalledWith(hostId);
      expect(manager.list().map((server) => server.id)).toEqual(["local"]);
      expect(manager.activeServerId).toBe("local");
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the saved WebRTC host order and loads Remote Desktop readiness after connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-host-order-"));
    const statePath = join(directory, "servers.json");
    const alphaId = "00000000-0000-4000-8000-000000000001";
    const betaId = "00000000-0000-4000-8000-000000000002";
    const gammaId = "00000000-0000-4000-8000-000000000003";
    const storedWebRtcServer = (id: string, name: string) => ({
      id,
      name,
      apiUrl: `webrtc://${id}`,
      fingerprint: fingerprint(`${id}-public-key`),
      publicKey: `${id}-public-key`,
      username: "person@example.com",
      encryptedToken: "",
      remoteDesktopAvailable: true,
      logoVersion: null,
      role: "member" as const,
      transport: "webrtc-v2" as const,
    });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 3,
        activeServerId: betaId,
        servers: [storedWebRtcServer(betaId, "Beta"), storedWebRtcServer(alphaId, "Alpha")],
      }),
    );
    let hosts = [
      { hostId: alphaId, name: "Alpha", devicePublicKey: `${alphaId}-public-key` },
      { hostId: betaId, name: "Beta", devicePublicKey: `${betaId}-public-key` },
      { hostId: gammaId, name: "Gamma", devicePublicKey: `${gammaId}-public-key` },
    ].map((host) => {
      const role: "owner" | "member" = host.hostId === gammaId ? "owner" : "member";
      return {
        ...host,
        logoKey: null,
        authEpoch: 1,
        membershipId: `${host.hostId}-member`,
        role,
      };
    });
    const bridge = new TeamWebRtcBridge();
    vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const removeMember = vi.fn(async (hostId: string) => {
      hosts = hosts.filter((host) => host.hostId !== hostId);
    });
    const revokeInvite = vi.fn(async () => undefined);
    const sendTeamInviteEmail = vi.fn(async () => undefined);
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => hosts,
      startSession: async (hostId) => ({ sessionId: "session-1", hostId, expiresAt: Date.now() + 60_000 }),
      issueTicket: async () => ({ ticket: "ticket", expiresAt: Date.now() + 60_000, signalUrl: "wss://signal" }),
      endSession: async () => undefined,
      createInvite: async () => ({ inviteId: "invite-1", token: "t".repeat(43), expiresAt: Date.now() + 60_000 }),
      listInvites: async () => [],
      previewInvite: async () => {
        throw new Error("Unexpected invite preview.");
      },
      acceptInvite: async () => {
        throw new Error("Unexpected invite acceptance.");
      },
      revokeInvite,
      listMembers: async () => [],
      updateMember: async () => undefined,
      removeMember,
      getPrincipalId: () => "person-1",
      controlPlaneUrl: "https://api.openbot.run",
      downloadHostLogo: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
      transferDirectory: join(directory, "transfers"),
    });
    const request = vi
      .spyOn(transport, "request")
      .mockImplementation(async (_hostId, path): Promise<TeamProtocolV2Json> => {
        if (path === "/v1/compatibility") {
          return {
            appVersion: "0.4.0",
            protocol: { minimum: 1, maximum: 1 },
            capabilities: [...TEAM_CURRENT_CAPABILITIES],
          } satisfies TeamProtocolV2Json;
        }
        return {
          ready: true,
          platform: "linux",
          unattended: true,
          runtime: "sunshine-moonlight",
          protocolVersion: 2,
          displays: [],
          selectedDisplayId: null,
          activeSessions: 0,
          maxSessions: 1,
        } satisfies TeamProtocolV2Json;
      });
    const manager = new RemoteServerManager(
      statePath,
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      {
        createTeamAuthTicket: async () => "ticket",
        getEmail: () => "person@example.com",
        sendTeamInviteEmail,
      },
      { appVersion: "0.4.0", webrtcTransport: transport },
    );

    try {
      await manager.initialize();
      expect(
        manager
          .list()
          .slice(1)
          .map((server) => server.id),
      ).toEqual([betaId, alphaId, gammaId]);
      expect(manager.list().find((server) => server.id === betaId)?.remoteDesktopAvailable).toBe(false);
      transport.emit("connected", betaId);
      await vi.waitFor(() =>
        expect(manager.list().find((server) => server.id === betaId)?.remoteDesktopAvailable).toBe(true),
      );
      const compatibility = manager.list().find((server) => server.id === betaId)?.compatibility;
      expect(compatibility).toMatchObject({ negotiatedProtocol: 2 });
      expect(compatibility?.capabilities).toContain("installed-skills");
      expect(request).toHaveBeenCalledWith(betaId, "/v1/remote-screen/capabilities", {
        preserveSemanticTags: true,
      });
      const invite = await manager.createInvite(betaId, { role: "member", email: "friend@example.com" });
      expect(sendTeamInviteEmail).toHaveBeenCalledWith({
        email: "friend@example.com",
        serverName: "Beta",
        inviteUrl: invite.inviteUrl,
        role: "member",
      });
      sendTeamInviteEmail.mockRejectedValueOnce(new Error("SMTP unavailable"));
      await expect(manager.createInvite(betaId, { role: "member", email: "failed@example.com" })).rejects.toThrow(
        "SMTP unavailable",
      );
      expect(revokeInvite).toHaveBeenCalledWith("invite-1");
      await manager.remove(alphaId);
      expect(removeMember).toHaveBeenCalledWith(alphaId, `${alphaId}-member`);
      await manager.syncRemoteHosts();
      expect(manager.list().some((server) => server.id === alphaId)).toBe(false);
      await manager.remove(gammaId);
      await manager.syncRemoteHosts();
      expect(manager.list().some((server) => server.id === gammaId)).toBe(false);
      expect(removeMember).not.toHaveBeenCalledWith(gammaId, `${gammaId}-member`);
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ hiddenHostIds: [gammaId] });
      transport.emit("error", betaId, "session_revoked", "The remote session was revoked.");
      expect(manager.list().find((server) => server.id === betaId)).toMatchObject({
        state: "error",
        issue: { code: "authentication_required", retryable: false },
      });
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sends viewer JSON through RPC and keeps viewer authorization errors scoped to Remote Desktop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-webrtc-viewer-"));
    const statePath = join(directory, "servers.json");
    const hostId = "viewer-host";
    const publicKey = "viewer-host-public-key";
    await writeFile(
      statePath,
      JSON.stringify({
        version: 3,
        activeServerId: hostId,
        servers: [
          {
            id: hostId,
            name: "Viewer host",
            apiUrl: `webrtc://${hostId}`,
            fingerprint: fingerprint(publicKey),
            publicKey,
            username: "person@example.com",
            encryptedToken: "",
            remoteDesktopAvailable: true,
            logoVersion: null,
            role: "member",
            transport: "webrtc-v2",
          },
        ],
      }),
    );
    const bridge = new TeamWebRtcBridge();
    vi.spyOn(bridge, "disconnect").mockResolvedValue();
    const transport = new TeamWebRtcClientTransport({
      bridge,
      listHosts: async () => [
        {
          hostId,
          name: "Viewer host",
          logoKey: null,
          devicePublicKey: publicKey,
          authEpoch: 1,
          membershipId: "member-1",
          role: "member",
        },
      ],
      startSession: async () => ({ sessionId: "session-1", hostId, expiresAt: Date.now() + 60_000 }),
      issueTicket: async () => ({
        ticket: "ticket",
        expiresAt: Date.now() + 60_000,
        signalUrl: "wss://signal.openbot.run/v1/signal",
      }),
      endSession: async () => undefined,
      createInvite: async () => ({ inviteId: "invite-1", token: "token", expiresAt: Date.now() + 60_000 }),
      listInvites: async () => [],
      previewInvite: async () => {
        throw new Error("Unexpected invite preview.");
      },
      acceptInvite: async () => {
        throw new Error("Unexpected invite acceptance.");
      },
      revokeInvite: async () => undefined,
      listMembers: async () => [],
      updateMember: async () => undefined,
      removeMember: async () => undefined,
      getPrincipalId: () => "person-1",
      controlPlaneUrl: "https://api.openbot.run",
      downloadHostLogo: async () => ({ bytes: new Uint8Array(), mimeType: "image/png" }),
      transferDirectory: join(directory, "transfers"),
    });
    const requestResponse = vi
      .spyOn(transport, "requestResponse")
      .mockResolvedValueOnce({ status: 204, body: {} })
      .mockRejectedValueOnce(new TeamWebRtcRequestError(401, "session_expired", "Viewer grant expired."));
    const manager = new RemoteServerManager(
      statePath,
      { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
      { createTeamAuthTicket: async () => "ticket", getEmail: () => "person@example.com" },
      { webrtcTransport: transport },
    );

    try {
      await manager.initialize();
      const authorization = await manager.fetchRemoteViewerResource(
        hostId,
        "/v1/remote-screen/sessions/desktop-1/authorize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify({ grant: "viewer-grant" })),
        },
      );
      expect(authorization.status).toBe(204);
      expect(requestResponse).toHaveBeenNthCalledWith(1, hostId, "/v1/remote-screen/sessions/desktop-1/authorize", {
        method: "POST",
        body: { grant: "viewer-grant" },
        contentType: "application/json",
        preserveSemanticTags: false,
      });

      await expect(
        manager.fetchRemoteViewerResource(hostId, "/v1/remote-screen/sessions/desktop-1/authorize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify({ grant: "expired" })),
        }),
      ).rejects.toThrow("Viewer grant expired.");
      expect(manager.list().find((server) => server.id === hostId)?.issue).toBeNull();
    } finally {
      await manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("remote server order", () => {
  it("recovers the persistence queue after a write failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-server-persistence-"));
    const unavailableDirectory = `${directory}-unavailable`;
    const statePath = join(directory, "servers.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        activeServerId: "local",
        servers: [
          {
            id: "server-1",
            name: "Remote",
            apiUrl: "https://server-1.trycloudflare.com/",
            fingerprint: "fingerprint",
            username: "person@example.com",
            encryptedToken: "token",
            remoteDesktopAvailable: false,
            role: "member",
          },
        ],
      }),
    );
    const manager = new RemoteServerManager(
      statePath,
      {
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => value.toString(),
      },
      {
        createTeamAuthTicket: async () => "ticket",
        getEmail: () => "person@example.com",
      },
    );

    try {
      await manager.initialize();
      await rename(directory, unavailableDirectory);
      await expect(manager.select("server-1")).rejects.toThrow();
      expect(manager.activeServerId).toBe("local");
      await rename(unavailableDirectory, directory);

      await expect(manager.select("local")).resolves.toBeDefined();
      const persisted = JSON.parse(await readFile(statePath, "utf8"));
      expect(persisted.activeServerId).toBe("local");
    } finally {
      manager.stop();
      await rm(directory, { recursive: true, force: true });
      await rm(unavailableDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the local server first and persists the remote server order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-server-order-"));
    const statePath = join(directory, "servers.json");
    const storedServer = (id: string) => ({
      id,
      name: id,
      apiUrl: `https://${id}.trycloudflare.com/`,
      fingerprint: "fingerprint",
      username: "person@example.com",
      encryptedToken: "token",
      role: "member" as const,
    });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        activeServerId: "server-1",
        servers: [storedServer("server-1"), storedServer("server-2")],
      }),
    );

    try {
      const manager = new RemoteServerManager(
        statePath,
        {
          encrypt: (value) => Buffer.from(value),
          decrypt: (value) => value.toString(),
        },
        {
          createTeamAuthTicket: async () => "ticket",
          getEmail: () => "person@example.com",
        },
      );
      await manager.initialize();

      const reordered = await manager.reorder(["server-2", "server-1"]);
      expect(reordered.map((server) => server.id)).toEqual(["local", "server-2", "server-1"]);
      expect(reordered.find((server) => server.id === "server-1")?.active).toBe(true);

      const persisted = JSON.parse(await readFile(statePath, "utf8"));
      expect(persisted.servers.map((server: { id: string }) => server.id)).toEqual(["server-2", "server-1"]);
      await expect(manager.reorder(["server-1"])).rejects.toThrow("incomplete");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("downloads shared and workspace files with authenticated requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-shared-download-"));
    const statePath = join(directory, "servers.json");
    const serverId = "remote-shared";
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        activeServerId: serverId,
        servers: [
          {
            id: serverId,
            name: "Remote",
            apiUrl: "https://remote-shared.trycloudflare.com/",
            fingerprint: "fingerprint",
            username: "person@example.com",
            encryptedToken: Buffer.from("session-token").toString("base64"),
            remoteDesktopAvailable: false,
            role: "member",
          },
        ],
      }),
    );

    const bytes = new TextEncoder().encode("name,value\nOpenBot,1\n");
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer session-token");
      expect(headers.get("OpenBot-Protocol-Version")).toBe("1");
      if (url.pathname === "/v1/shared-files") {
        expect(url.searchParams.get("path")).toBe("~/OpenBot/Shared/report.csv");
      } else {
        expect(url.pathname).toBe("/v1/workspace-files");
        expect(url.searchParams.get("botId")).toBe("chief");
        expect(url.searchParams.get("path")).toBe("app/page.tsx");
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Disposition": `attachment; filename*=UTF-8''${url.pathname.includes("workspace") ? "page.tsx" : "report.csv"}`,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const manager = new RemoteServerManager(
        statePath,
        {
          encrypt: (value) => Buffer.from(value),
          decrypt: (value) => value.toString(),
        },
        {
          createTeamAuthTicket: async () => "ticket",
          getEmail: () => "person@example.com",
        },
      );
      await manager.initialize();

      await expect(manager.downloadSharedFile("~/OpenBot/Shared/report.csv", serverId)).resolves.toEqual({
        bytes,
        name: "report.csv",
      });
      await expect(manager.downloadWorkspaceFile("chief", "app/page.tsx", serverId)).resolves.toEqual({
        bytes,
        name: "page.tsx",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      manager.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("remote connection failures", () => {
  // The one place a request failure and the live channel meet. `RemoteServerConnections` decides the
  // failure is not worth retrying and calls back; only the event stream knows there is a socket to
  // tear down for it. Neither names the other, so this is the test that the manager still wires them
  // together.
  it("closes the event data plane after a malformed HTTP payload", async () => {
    stubTeamFetch({
      compatibility: { appVersion: "0.3.0", capabilities: ["agent-runtime-snapshots"] },
      fallback: () => Response.json({ malformed: true }),
    });
    const { sockets } = stubEventSockets();
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("http-protocol")], appVersion: "0.4.0" });

    fixture.manager.startEventConnections();
    await waitForServer(fixture, { state: "online" });

    await expect(fixture.manager.request("http-protocol", "/v1/agents", (value) => value)).rejects.toThrow(
      "could not safely use",
    );

    expect(sockets[0]?.close).toHaveBeenCalledWith(1000, "Client stopped");
    expect(fixture.server()).toMatchObject({ state: "error", issue: { code: "protocol_error" } });
  });

  // The same wiring for a WebRTC host, which has no socket to abort: its events arrive on a data
  // channel the transport owns, so suspending the stream alone left the host pushing events after
  // the app decided it could not understand the answers it gives.
  it("closes the event data plane of a WebRTC host that answers with nonsense", async () => {
    const hostId = "00000000-0000-4000-8000-0000000000ff";
    const transport = fakeWebRtcTransport([
      {
        hostId,
        name: "Host",
        logoKey: null,
        devicePublicKey: null,
        authEpoch: 1,
        membershipId: "member-1",
        role: "member",
      },
    ]);
    const disconnect = vi.spyOn(transport, "disconnect");
    vi.spyOn(transport, "request").mockImplementation(async (_hostId, path): Promise<TeamProtocolV2Json> => {
      if (path !== "/v1/compatibility") return { malformed: true };
      return { appVersion: "0.4.0", protocol: { minimum: 2, maximum: 2 }, capabilities: [] };
    });
    const fixture = await createRemoteManager({
      servers: [storedHttpsServer(hostId, { transport: "webrtc-v2", apiUrl: `webrtc://${hostId}` })],
      appVersion: "0.4.0",
      managerOptions: { webrtcTransport: transport },
    });

    await expect(
      fixture.manager.request(hostId, "/v1/agents", () => {
        throw new Error("Unexpected agent payload.");
      }),
    ).rejects.toThrow("could not safely use");

    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledWith(hostId));

    // The disconnect the app asked for comes back as an event, and it must not be read as the host
    // merely going away: the failure that caused it is what the user has to see.
    transport.emit("disconnected", hostId);
    expect(fixture.server(hostId)).toMatchObject({ state: "error", issue: { code: "protocol_error" } });

    // Retrying by hand is the act the suspension was waiting for. A host still suspended after it
    // reads every later disconnect as the old failure and never reconnects on its own again.
    vi.spyOn(transport, "connect").mockResolvedValue(undefined);
    await fixture.manager.retryConnection(hostId);
    transport.emit("disconnected", hostId);
    expect(fixture.server(hostId)).toMatchObject({ state: "offline" });
  });
});

describe("remote control capability discovery", () => {
  it("joins a server when remote control is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-remote-capability-"));
    const statePath = join(directory, "servers.json");
    const serverId = "00000000-0000-4000-8000-000000000000";
    const apiUrl = "https://remote-capability.trycloudflare.com/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const expectedFingerprint = fingerprint(publicKeyPem);
    const inviteUrl = new URL("openbot://join");
    inviteUrl.searchParams.set("api", apiUrl);
    inviteUrl.searchParams.set("server", serverId);
    inviteUrl.searchParams.set("fingerprint", expectedFingerprint);
    inviteUrl.searchParams.set("invite", "b".repeat(43));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const pathname = url.pathname.replace(/^\/+/, "/");
        if (pathname === "/v1/identity") {
          const challenge = url.searchParams.get("challenge");
          if (!challenge) throw new Error("The identity challenge is missing.");
          return Response.json({
            serverId,
            publicKey: publicKeyPem,
            serverName: "Capability Host",
            fingerprint: expectedFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            enabledOnLaunch: true,
            logoVersion: null,
          });
        }
        if (pathname === "/v1/join/account") {
          return Response.json({
            member: {
              id: "member-id",
              username: "member",
              email: "member@example.com",
              name: null,
              avatarUrl: null,
              role: "member",
              createdAt: new Date().toISOString(),
              disabled: false,
            },
            sessionToken: "session-token",
            sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        }
        if (pathname === "/v1/remote-screen/capabilities") {
          return Response.json({ error: "Remote control is unavailable.", code: "host_unavailable" }, { status: 503 });
        }
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );

    class ClosedWebSocket extends EventTarget {
      close(): void {
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", ClosedWebSocket);

    try {
      const manager = new RemoteServerManager(
        statePath,
        {
          encrypt: (value) => Buffer.from(value),
          decrypt: (value) => value.toString(),
        },
        {
          createTeamAuthTicket: async () => "account-ticket",
          getEmail: () => "member@example.com",
        },
      );
      await manager.initialize();

      await expect(manager.join({ inviteUrl: inviteUrl.toString() })).resolves.toMatchObject({
        id: serverId,
        remoteDesktopAvailable: false,
        state: "online",
      });
      manager.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
