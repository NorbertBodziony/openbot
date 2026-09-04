import { createInviteUrl } from "@openbot/contracts/invite-links";
import { describe, expect, it } from "vitest";

import { type RemoteHostKeyStore, RemoteTeamDirectoryClient } from "./remote-directory";

const API_URL = "https://api.openbot.run";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const HOST_KEY = "desktop-public-key";
const HOST_FINGERPRINT = "AqBeU6SSjNMMzQkof9ad85KzSTI7kiNWQtfzR-sbXsU";
const INVITE = createInviteUrl({
  apiUrl: `${API_URL}/`,
  serverId: HOST_ID,
  fingerprint: HOST_FINGERPRINT,
  token: "t".repeat(32),
});
const PREVIEW = {
  hostId: HOST_ID,
  hostName: "Studio",
  role: "member",
  expiresAt: 9_999_999_999_999,
  emailBound: false,
  devicePublicKey: HOST_KEY,
};
const ACCEPTED = { hostId: HOST_ID, membershipId: "membership-1", role: "member" };

describe("RemoteTeamDirectoryClient", () => {
  it("pins the QR's exact host even when another owned desktop is first", async () => {
    const pinned = new Map<string, string>();
    const client = new RemoteTeamDirectoryClient({
      apiUrl: API_URL,
      token: "mobile-session",
      pairedHost: { hostId: HOST_ID, fingerprint: HOST_FINGERPRINT },
      hostKeys: {
        get: async (id) => pinned.get(id) ?? null,
        set: async (id, key) => {
          pinned.set(id, key);
        },
      },
      fetch: async () =>
        Response.json({
          hosts: [
            {
              hostId: "other-desktop",
              name: "A Desktop",
              logoKey: null,
              devicePublicKey: "other-key",
              membershipId: "other-membership",
              role: "owner",
            },
            {
              hostId: HOST_ID,
              name: "Z Desktop",
              logoKey: null,
              devicePublicKey: HOST_KEY,
              membershipId: "paired-membership",
              role: "owner",
            },
          ],
        }),
    });
    await client.listHosts();
    expect(pinned.get(HOST_ID)).toBe(HOST_KEY);
    expect(pinned.has("other-desktop")).toBe(false);
  });

  it("rejects directory substitution of a scanned host key", async () => {
    const client = new RemoteTeamDirectoryClient({
      apiUrl: API_URL,
      token: "mobile-session",
      pairedHost: { hostId: HOST_ID, fingerprint: HOST_FINGERPRINT },
      fetch: async () =>
        Response.json({
          hosts: [
            {
              hostId: HOST_ID,
              name: "Desktop",
              logoKey: null,
              devicePublicKey: "substituted",
              membershipId: "paired-membership",
              role: "owner",
            },
          ],
        }),
    });
    await expect(client.listHosts()).rejects.toThrow("paired desktop identity");
  });

  it("leaves the exact membership without removing the trusted key", async () => {
    const requests: Array<{ url: string; method: string | undefined }> = [];
    const client = new RemoteTeamDirectoryClient({
      apiUrl: API_URL,
      token: "mobile-session",
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), method: init?.method });
        return new Response(null, { status: 204 });
      },
    });
    await client.leaveHost(HOST_ID, "membership-1");
    expect(requests).toEqual([{ url: `${API_URL}/v2/remote/hosts/${HOST_ID}/members/membership-1`, method: "DELETE" }]);
  });
  it("returns only connectable hosts and authenticates the directory request", async () => {
    const requests: Array<{ authorization: string | null; url: string }> = [];
    const client = new RemoteTeamDirectoryClient({
      apiUrl: API_URL,
      token: "mobile-session",
      fetch: async (input, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("Authorization"),
          url: input.toString(),
        });
        return Response.json({
          hosts: [
            {
              hostId: HOST_ID,
              name: "Studio",
              logoKey: null,
              devicePublicKey: "desktop-public-key",
              membershipId: "membership-1",
              role: "owner",
            },
            {
              hostId: "22222222-2222-4222-8222-222222222222",
              name: "Old host",
              logoKey: null,
              devicePublicKey: null,
              membershipId: "membership-2",
              role: "member",
            },
          ],
        });
      },
    });

    await expect(client.listHosts()).resolves.toEqual([
      {
        hostId: HOST_ID,
        name: "Studio",
        logoKey: null,
        devicePublicKey: "desktop-public-key",
        membershipId: "membership-1",
        role: "owner",
      },
    ]);
    expect(requests).toEqual([
      { authorization: "Bearer mobile-session", url: "https://api.openbot.run/v2/remote/hosts/" },
    ]);
  });

  it("ends the logical session when ticket creation fails", async () => {
    const paths: string[] = [];
    const client = new RemoteTeamDirectoryClient({
      apiUrl: API_URL,
      token: "mobile-session",
      fetch: async (input) => {
        const path = new URL(input.toString()).pathname;
        paths.push(path);
        if (path === "/v2/remote/sessions/") {
          return Response.json({ sessionId: "session-1", expiresAt: Date.now() + 60_000 }, { status: 201 });
        }
        if (path.endsWith("/ticket")) return Response.json({ error: "host offline" }, { status: 503 });
        return new Response(null, { status: 204 });
      },
    });

    await expect(client.createBootstrap(HOST_ID, "client-public-key")).rejects.toThrow("host offline");
    expect(paths).toEqual([
      "/v2/remote/sessions/",
      "/v2/remote/sessions/session-1/ticket",
      "/v2/remote/sessions/session-1/end",
    ]);
  });

  it("accepts an unencrypted Signal URL only on a private development network", async () => {
    const client = new RemoteTeamDirectoryClient({
      apiUrl: API_URL,
      token: "mobile-session",
      fetch: async (input) => {
        const path = new URL(input.toString()).pathname;
        if (path === "/v2/remote/sessions/") {
          return Response.json({ sessionId: "session-1", expiresAt: Date.now() + 60_000 }, { status: 201 });
        }
        return Response.json({
          signalUrl: "ws://192.168.1.143:3101/v1/signal",
          ticket: "remote-ticket",
          expiresAt: Date.now() + 60_000,
        });
      },
    });

    await expect(client.createBootstrap(HOST_ID, "client-public-key")).resolves.toMatchObject({
      signalUrl: "ws://192.168.1.143:3101/v1/signal",
    });
  });

  it("does not send the mobile session token while previewing a public invitation", async () => {
    const authorizations: Array<string | null> = [];
    const client = new RemoteTeamDirectoryClient({
      apiUrl: API_URL,
      token: "mobile-session",
      fetch: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("Authorization"));
        return Response.json({
          hostId: HOST_ID,
          hostName: "Studio",
          role: "member",
          expiresAt: Date.now() + 60_000,
          emailBound: false,
          devicePublicKey: "desktop-public-key",
        });
      },
    });
    const inviteUrl = createInviteUrl({
      apiUrl: `${API_URL}/`,
      serverId: HOST_ID,
      fingerprint: HOST_FINGERPRINT,
      token: "t".repeat(32),
    });

    await expect(client.previewInvite(inviteUrl)).resolves.toMatchObject({ hostId: HOST_ID, hostName: "Studio" });
    expect(authorizations).toEqual([null]);
  });

  it.each([null, "substituted-key"])("does not consume an invite when its preview key is %s", async (key) => {
    const paths: string[] = [];
    const client = new RemoteTeamDirectoryClient({
      apiUrl: API_URL,
      token: "session",
      fetch: async (input) => {
        paths.push(new URL(input.toString()).pathname);
        return Response.json(
          new URL(input.toString()).pathname.endsWith("/preview") ? { ...PREVIEW, devicePublicKey: key } : ACCEPTED,
        );
      },
    });
    await expect(client.acceptInvite(INVITE)).rejects.toThrow("fingerprint");
    expect(paths).toEqual(["/v2/remote/invites/preview"]);
  });

  it.each([
    { ...ACCEPTED, hostId: "another-host" },
    { ...ACCEPTED, membershipId: "" },
    { ...ACCEPTED, role: "admin" },
  ])("rejects an acceptance that does not match the reviewed invitation: %j", async (accepted) => {
    const client = new RemoteTeamDirectoryClient({
      apiUrl: API_URL,
      token: "session",
      fetch: async (input) =>
        Response.json(new URL(input.toString()).pathname.endsWith("/preview") ? PREVIEW : accepted),
    });
    await expect(client.acceptInvite(INVITE)).rejects.toThrow("invalid invitation acceptance");
  });

  it("returns the joined host without needing a directory refresh, and retains its pin across client restarts", async () => {
    const keys = new Map<string, string>();
    const hostKeys: RemoteHostKeyStore = {
      get: async (id) => keys.get(id) ?? null,
      set: async (id, key) => {
        keys.set(id, key);
      },
    };
    let advertisedKey = HOST_KEY;
    let directoryOffline = true;
    const options = {
      apiUrl: API_URL,
      token: "session",
      hostKeys,
      fetch: async (input: string | URL | Request) => {
        const path = new URL(input.toString()).pathname;
        if (path.endsWith("/preview")) return Response.json(PREVIEW);
        if (path.endsWith("/accept")) {
          expect(keys.get(HOST_ID)).toBe(HOST_KEY);
          return Response.json(ACCEPTED);
        }
        if (directoryOffline) throw new Error("Directory offline");
        return Response.json({
          hosts: [{ ...ACCEPTED, name: "Studio", logoKey: null, devicePublicKey: advertisedKey }],
        });
      },
    };
    const client = new RemoteTeamDirectoryClient(options);
    await expect(client.acceptInvite(INVITE)).resolves.toEqual({
      ...ACCEPTED,
      name: "Studio",
      logoKey: null,
      devicePublicKey: HOST_KEY,
    });
    await expect(client.listHosts()).rejects.toThrow("Directory offline");
    directoryOffline = false;
    await expect(client.listHosts()).resolves.toMatchObject([{ devicePublicKey: HOST_KEY }]);
    advertisedKey = "substituted-key";
    await expect(new RemoteTeamDirectoryClient(options).listHosts()).rejects.toThrow("server identity changed");
    expect(keys.get(HOST_ID)).toBe(HOST_KEY);
  });

  it("does not consume the invite if its pin cannot be stored or conflicts with an existing pin", async () => {
    for (const pinned of [null, "other-key"]) {
      const paths: string[] = [];
      const client = new RemoteTeamDirectoryClient({
        apiUrl: API_URL,
        token: "session",
        hostKeys: {
          get: async () => pinned,
          set: async () => {
            throw new Error("Keychain locked");
          },
        },
        fetch: async (input) => {
          paths.push(new URL(input.toString()).pathname);
          return Response.json(PREVIEW);
        },
      });
      await expect(client.acceptInvite(INVITE)).rejects.toThrow(pinned ? "conflicts" : "Keychain locked");
      expect(paths).toEqual(["/v2/remote/invites/preview"]);
    }
  });
});
