// Members and invitations -- the one place the two transports answer to different authorities.
//
// Everywhere else in this family a WebRTC host and an HTTPS host are the same server reached two
// ways. Here they are not. An HTTPS server owns its own roster and answers on `TEAM_API_ROUTES.team`
// like every other route. A WebRTC host does not: its memberships and invitations live in the
// account service, which is a *different server* with a different trust story, and this file is the
// only one that talks to it. `revokeInvite(inviteId)` does not even take a host id -- that is the
// tell, and it is why `RemoteControlPlaneTransport` is named for the plane rather than the host.
//
// So the two arms stay visible. Hiding them behind one method would read as tidier and would cost
// the next reader an hour the first time an invitation goes missing from the wrong server.

import { createInviteUrl } from "@openbot/contracts/invite-links";
import type {
  InviteSummary,
  TeamInviteSummary,
  TeamMemberSummary,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { RemoteInviteRecord, RemoteMemberRecord } from "./central-auth-manager";
import { decodeVoid } from "./remote-host-decoding";
import type { RemoteRequestFn } from "./remote-server-client";
import type { RemoteServerDirectory } from "./remote-server-store";
import { decodeInviteSummary, decodeTeamInvites, decodeTeamMember, decodeTeamMembers } from "./remote-team-decoding";

// The account service, not the host. Every method here crosses to a second authority.
export interface RemoteControlPlaneTransport {
  readonly controlPlaneUrl: string;
  listMembers(hostId: string): Promise<RemoteMemberRecord[]>;
  updateMember(hostId: string, membershipId: string, role: "admin" | "member", reactivate?: boolean): Promise<void>;
  removeMember(hostId: string, membershipId: string): Promise<void>;
  listInvites(hostId: string): Promise<RemoteInviteRecord[]>;
  createInvite(
    hostId: string,
    input: { role: "admin" | "member"; email?: string },
  ): Promise<{ inviteId: string; token: string; expiresAt: number }>;
  revokeInvite(inviteId: string): Promise<void>;
}

export interface RemoteTeamDirectoryOptions {
  servers: Pick<RemoteServerDirectory, "require">;
  request: RemoteRequestFn;
  transport: RemoteControlPlaneTransport | null;
  // Read through a callback rather than held, so an account that gains email delivery later is not
  // frozen out by whatever was true when this object was built.
  sendInviteEmail: (input: {
    email: string;
    serverName: string;
    inviteUrl: string;
    role: "admin" | "member";
  }) => Promise<void>;
}

export class RemoteTeamDirectory {
  readonly #servers: RemoteTeamDirectoryOptions["servers"];
  readonly #request: RemoteRequestFn;
  readonly #transport: RemoteControlPlaneTransport | null;
  readonly #sendInviteEmail: RemoteTeamDirectoryOptions["sendInviteEmail"];

  constructor(options: RemoteTeamDirectoryOptions) {
    this.#servers = options.servers;
    this.#request = options.request;
    this.#transport = options.transport;
    this.#sendInviteEmail = options.sendInviteEmail;
  }

  listMembers(serverId: string): Promise<TeamMemberSummary[]> {
    const transport = this.#controlPlaneFor(serverId);
    if (transport) {
      return transport.listMembers(serverId).then((members) =>
        members.map((member) => ({
          id: member.membershipId,
          username: member.email,
          email: member.email,
          name: member.name,
          avatarUrl: member.avatarUrl,
          role: member.role,
          createdAt: new Date(member.createdAt).toISOString(),
          disabled: member.status !== "active",
        })),
      );
    }
    return this.#request(serverId, TEAM_API_ROUTES.team.members, decodeTeamMembers);
  }

  updateMember(serverId: string, input: UpdateTeamMemberInput): Promise<TeamMemberSummary> {
    const transport = this.#controlPlaneFor(serverId);
    if (transport) {
      // The control plane returns nothing useful, so the updated member is read back rather than
      // assumed -- and the read before it is what refuses to demote an owner.
      return (async () => {
        const members = await this.listMembers(serverId);
        const current = members.find((member) => member.id === input.memberId);
        if (!current || current.role === "owner") throw new Error("The remote member does not exist.");
        if (input.disabled) await transport.removeMember(serverId, input.memberId);
        else
          await transport.updateMember(serverId, input.memberId, input.role ?? current.role, input.disabled === false);
        const updated = (await this.listMembers(serverId)).find((member) => member.id === input.memberId);
        if (!updated) throw new Error("The remote member does not exist.");
        return updated;
      })();
    }
    return this.#request(serverId, TEAM_API_ROUTES.team.member(input.memberId), decodeTeamMember, {
      method: "PATCH",
      body: { role: input.role, disabled: input.disabled },
    });
  }

  removeMember(serverId: string, memberId: string): Promise<void> {
    const transport = this.#controlPlaneFor(serverId);
    if (transport) return transport.removeMember(serverId, memberId);
    return this.#request(serverId, TEAM_API_ROUTES.team.member(memberId), decodeVoid, { method: "DELETE" });
  }

  listInvites(serverId: string): Promise<TeamInviteSummary[]> {
    const transport = this.#controlPlaneFor(serverId);
    if (transport) {
      return transport.listInvites(serverId).then((invites) =>
        invites
          .filter((invite) => invite.revokedAt === null)
          .map((invite) => ({
            id: invite.inviteId,
            role: invite.role,
            expiresAt: new Date(invite.expiresAt).toISOString(),
            usedAt: invite.usedAt === null ? null : new Date(invite.usedAt).toISOString(),
            email: invite.email,
          })),
      );
    }
    return this.#request(serverId, TEAM_API_ROUTES.team.invites, decodeTeamInvites);
  }

  revokeInvite(serverId: string, inviteId: string): Promise<void> {
    const transport = this.#controlPlaneFor(serverId);
    if (transport) return transport.revokeInvite(inviteId);
    return this.#request(serverId, TEAM_API_ROUTES.team.invite(inviteId), decodeVoid, { method: "DELETE" });
  }

  async createInvite(serverId: string, input: { role: "admin" | "member"; email?: string }): Promise<InviteSummary> {
    const server = this.#servers.require(serverId);
    const transport = this.#controlPlaneFor(serverId);
    if (transport) {
      // The invitation URL carries the host fingerprint, so a host nobody has connected to yet has
      // nothing to put in it and the invitation would be unverifiable.
      if (!server.fingerprint) throw new Error("The host must connect once before it can create invitations.");
      const invite = await transport.createInvite(serverId, input);
      const result: InviteSummary = {
        id: invite.inviteId,
        role: input.role,
        expiresAt: new Date(invite.expiresAt).toISOString(),
        usedAt: null,
        email: input.email ?? null,
        inviteUrl: createInviteUrl({
          apiUrl: transport.controlPlaneUrl,
          serverId,
          fingerprint: server.fingerprint,
          token: invite.token,
        }),
      };
      if (input.email) {
        // An invitation nobody received is worse than none: it is a live credential the user does
        // not know exists. Undelivered mail revokes it.
        try {
          await this.#sendInviteEmail({
            email: input.email,
            serverName: server.name,
            inviteUrl: result.inviteUrl,
            role: input.role,
          });
        } catch (error) {
          await transport.revokeInvite(invite.inviteId).catch(() => undefined);
          throw error;
        }
      }
      return result;
    }
    return this.#request(serverId, TEAM_API_ROUTES.team.invites, decodeInviteSummary, { method: "POST", body: input });
  }

  #controlPlaneFor(serverId: string): RemoteControlPlaneTransport | null {
    const server = this.#servers.require(serverId);
    return server.transport === "webrtc-v2" ? this.#transport : null;
  }
}
