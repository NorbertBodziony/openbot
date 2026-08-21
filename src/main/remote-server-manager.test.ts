// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInviteUrl } from "@openbot/contracts/invite-links";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidRemoteApiUrl, RemoteServerManager, remoteAttachmentPreviewUrl } from "./remote-server-manager";
import { fingerprint } from "./team-store";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote server links", () => {
  it("accepts only supported root HTTPS tunnel URLs", () => {
    expect(isValidRemoteApiUrl("https://team-host.trycloudflare.com/")).toBe(true);
    expect(isValidRemoteApiUrl("https://studio-mac-k7m4q2pz-host.openbot.run/")).toBe(true);
    expect(isValidRemoteApiUrl("https://studio-mac-k7m4q2pz-host.teams.openbot.run/")).toBe(false);
    expect(isValidRemoteApiUrl("http://team-host.trycloudflare.com/")).toBe(false);
    expect(isValidRemoteApiUrl("https://team-host.trycloudflare.com/path")).toBe(false);
    expect(isValidRemoteApiUrl("https://example.com/")).toBe(false);
  });

  it("parses an OpenBot invitation", () => {
    const url = new URL("openbot://join");
    url.searchParams.set("api", "https://team-host.trycloudflare.com/");
    url.searchParams.set("server", "00000000-0000-4000-8000-000000000000");
    url.searchParams.set("fingerprint", "a".repeat(43));
    url.searchParams.set("invite", "b".repeat(43));
    expect(parseInviteUrl(url.toString())).toMatchObject({
      apiUrl: "https://team-host.trycloudflare.com/",
      serverId: "00000000-0000-4000-8000-000000000000",
      fingerprint: "a".repeat(43),
      token: "b".repeat(43),
    });
  });

  it("parses a stable openbot.run invitation", () => {
    const apiUrl = "https://studio-mac-k7m4q2pz-host.openbot.run/";
    const url = new URL("openbot://join");
    url.searchParams.set("api", apiUrl);
    url.searchParams.set("server", "00000000-0000-4000-8000-000000000000");
    url.searchParams.set("fingerprint", "a".repeat(43));
    url.searchParams.set("invite", "b".repeat(43));
    expect(parseInviteUrl(url.toString())).toMatchObject({ apiUrl });
  });

  it("rejects a link with a non-Cloudflare API URL", () => {
    expect(() => parseInviteUrl("openbot://join?api=https%3A%2F%2Fevil.example&server=x")).toThrow("invalid");
  });

  it("creates token-free preview URLs", () => {
    const preview = remoteAttachmentPreviewUrl("00000000-0000-4000-8000-000000000000", "draft 1");
    expect(preview).toBe("openbot-remote-attachment://00000000-0000-4000-8000-000000000000/draft%201");
    expect(preview).not.toContain("token");
  });
});

describe("remote server order", () => {
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
            logoVersion: null,
          });
        }
        if (pathname === "/v1/join/account") {
          return Response.json({ member: { role: "member" }, sessionToken: "session-token" });
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
