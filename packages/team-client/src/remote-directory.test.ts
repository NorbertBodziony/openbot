import { createInviteUrl } from "@openbot/contracts/invite-links";
import { describe, expect, it } from "vitest";

import { RemoteTeamDirectoryClient } from "./remote-directory";

const API_URL = "https://api.openbot.run";
const HOST_ID = "11111111-1111-4111-8111-111111111111";

describe("RemoteTeamDirectoryClient", () => {
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
      fingerprint: "f".repeat(32),
      token: "t".repeat(32),
    });

    await expect(client.previewInvite(inviteUrl)).resolves.toMatchObject({ hostId: HOST_ID, hostName: "Studio" });
    expect(authorizations).toEqual([null]);
  });
});
