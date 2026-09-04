// @vitest-environment node

// Joining, membership, invitations, sessions and passwords: `src/main/team-api/route-team.ts`.

import { EventEmitter } from "node:events";
import type { TeamPresenceSnapshot } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { OpenBotDatabase } from "../backend/openbot-database";
import { TeamChatStore } from "../backend/team-chat-store";
import {
  createAgents,
  createTeamApiFixture,
  emptyRequest,
  jsonRequest,
  nextJsonEvent,
  nextJsonEvents,
  stopTeamApiFixtures,
} from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

describe("TeamApiServer team", () => {
  it("joins an email-bound invitation with a verified OpenBot account", async () => {
    const { root, store, start } = await createTeamApiFixture("account");
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });
    const invite = await store.createInvite("member", "alice@example.com");
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const chat = new TeamChatStore(database);
    const agentEvents = new EventEmitter();
    const presenceSnapshots: TeamPresenceSnapshot[] = [];
    const agents = createAgents({}, agentEvents);
    const { port } = await start({
      agents,
      redeemCentralTicket: async (ticket, serverId) => {
        if (serverId !== store.getIdentity()?.serverId) return null;
        if (ticket === "valid-team-ticket") {
          return {
            id: "alice-account",
            email: "alice@example.com",
            name: "Alice",
            avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
          };
        }
        return ticket === "owner-team-ticket"
          ? {
              id: "owner-account",
              email: "owner@example.com",
              name: "Owner on another Mac",
              avatarUrl: null,
            }
          : null;
      },
      onPresence: (snapshot) => presenceSnapshots.push(snapshot),
      chat,
    });

    try {
      const previewResponse = await fetch(`http://127.0.0.1:${port}/v1/invitations/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: invite.token }),
      });
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get("Cache-Control")).toBe("no-store");
      await expect(previewResponse.json()).resolves.toEqual({
        role: "member",
        expiresAt: invite.expiresAt,
        emailBound: true,
      });

      const response = await fetch(`http://127.0.0.1:${port}/v1/join/account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inviteToken: invite.token,
          accountTicket: "valid-team-ticket",
        }),
      });
      expect(response.status).toBe(201);
      const joined = await response.json();
      expect(joined.member).toMatchObject({
        email: "alice@example.com",
        role: "member",
        avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
      });
      expect(store.authenticate(joined.sessionToken)?.email).toBe("alice@example.com");

      const usedPreview = await fetch(`http://127.0.0.1:${port}/v1/invitations/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: invite.token }),
      });
      expect(usedPreview.status).toBe(400);

      const ownerInvite = await store.createInvite("member");
      const ownerResponse = await fetch(`http://127.0.0.1:${port}/v1/join/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inviteToken: ownerInvite.token,
          accountTicket: "owner-team-ticket",
        }),
      });
      expect(ownerResponse.status).toBe(201);
      const ownerConnection = await ownerResponse.json();
      expect(ownerConnection.member).toMatchObject({
        email: "owner@example.com",
        name: "Owner on another Mac",
        role: "owner",
      });
      expect(store.listMembers()).toHaveLength(2);
      expect(store.authenticate(ownerConnection.sessionToken)?.email).toBe("owner@example.com");

      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
        "openbot-events-v2",
        `openbot-token.${joined.sessionToken}`,
      ]);
      const initialEvents = nextJsonEvents(socket, 2);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), {
          once: true,
        });
      });
      const [initialSnapshot, initialPresence] = await initialEvents;
      expect(initialSnapshot).toMatchObject({ type: "runtime-snapshot" });
      expect(initialPresence).toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([
            expect.objectContaining({
              email: "alice@example.com",
              online: true,
              avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
            }),
          ]),
        },
      });

      const typingPresence = nextJsonEvent(socket);
      socket.send(JSON.stringify({ type: "team-typing", botId: "chief", typing: true }));
      await expect(typingPresence).resolves.toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([
            expect.objectContaining({
              email: "alice@example.com",
              online: true,
              typingBotId: "chief",
            }),
          ]),
        },
      });

      const stoppedTypingPresence = nextJsonEvent(socket);
      socket.send(JSON.stringify({ type: "team-typing", botId: null, typing: false }));
      await expect(stoppedTypingPresence).resolves.toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([expect.objectContaining({ email: "alice@example.com", typingBotId: null })]),
        },
      });

      const owner = store.listMembers().find((member) => member.role === "owner");
      expect(owner).toBeDefined();
      const directTypingEvent = nextJsonEvent(socket);
      socket.send(
        JSON.stringify({
          type: "team-direct-typing",
          recipientMemberId: owner?.id,
          typing: true,
        }),
      );
      await expect(directTypingEvent).resolves.toMatchObject({
        type: "team-direct-typing",
        senderMemberId: joined.member.id,
        recipientMemberId: owner?.id,
        typing: true,
      });
      const directMessageEvent = nextJsonEvent(socket);
      const directResponse = await fetch(`http://127.0.0.1:${port}/v1/direct/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${joined.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          memberId: owner?.id,
          clientMessageId: "message-alice-owner",
          text: "Can we review this together?",
        }),
      });
      expect(directResponse.status).toBe(201);
      await expect(directMessageEvent).resolves.toMatchObject({
        type: "team-direct-message",
        message: {
          senderMemberId: joined.member.id,
          recipientMemberId: owner?.id,
          text: "Can we review this together?",
        },
      });
      const threads = await jsonRequest<Array<{ unreadCount: number }>>(
        `http://127.0.0.1:${port}`,
        "/v1/direct/threads",
        { token: joined.sessionToken },
      );
      expect(threads).toMatchObject([{ unreadCount: 0 }]);

      const received = nextJsonEvent(socket);
      agentEvents.emit("event", {
        type: "error",
        code: "smoke_event",
        message: "WebSocket delivery works.",
      });
      await expect(received).resolves.toMatchObject({ type: "error", code: "smoke_event" });
      socket.close();
      await expect
        .poll(() => presenceSnapshots.at(-1)?.members.find((member) => member.email === "alice@example.com")?.online)
        .toBe(false);
    } finally {
      database.close();
    }
  });

  it("manages invites, members, sessions, and password changes on loopback", async () => {
    const { store, start } = await createTeamApiFixture("server", { configure: true });
    const agents = createAgents();
    const { base } = await start({
      agents,
      createInvite: async (input) => {
        const created = await store.createInvite(input.role, input.email);
        return {
          id: created.id,
          role: created.role,
          expiresAt: created.expiresAt,
          usedAt: null,
          inviteUrl: `https://openbot.run/join?token=${created.token}`,
          email: created.email,
        };
      },
    });

    const ownerLogin = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
      body: { username: "owner", password: "correct horse battery" },
    });
    const ownerToken = ownerLogin.sessionToken;
    const invite = await jsonRequest<{ id: string; inviteUrl: string }>(base, "/v1/team/invites", {
      token: ownerToken,
      body: { role: "member" },
    });
    const inviteToken = new URL(invite.inviteUrl).searchParams.get("token");
    expect(inviteToken).not.toBeNull();
    const joined = await jsonRequest<{ member: { id: string }; sessionToken: string }>(base, "/v1/join", {
      body: {
        inviteToken,
        username: "alice",
        password: "a secure team password",
      },
    });
    const updated = await jsonRequest<{ role: string }>(base, `/v1/team/members/${joined.member.id}`, {
      method: "PATCH",
      token: ownerToken,
      body: { role: "admin" },
    });
    expect(updated.role).toBe("admin");

    const sessions = await jsonRequest<Array<{ id: string; username: string }>>(base, "/v1/team/sessions", {
      token: ownerToken,
    });
    const aliceSession = sessions.find((session) => session.username === "alice");
    expect(aliceSession).toBeDefined();
    await emptyRequest(base, `/v1/team/sessions/${aliceSession?.id}`, {
      method: "DELETE",
      token: ownerToken,
    });
    expect(store.authenticate(joined.sessionToken)).toBeNull();

    await emptyRequest(base, `/v1/team/invites/${invite.id}`, {
      method: "DELETE",
      token: ownerToken,
    });
    await emptyRequest(base, `/v1/team/members/${joined.member.id}`, {
      method: "DELETE",
      token: ownerToken,
    });
    expect(store.listMembers().map((member) => member.username)).toEqual(["owner"]);
    await emptyRequest(base, "/v1/auth/password", {
      token: ownerToken,
      body: {
        currentPassword: "correct horse battery",
        newPassword: "a newer secure password",
      },
    });
    expect(store.authenticate(ownerToken)).toBeNull();
  });
});
