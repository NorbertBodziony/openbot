// The team itself: who you are, who else is here, and who is allowed to stay.
//
// Membership, invitations and sessions all run through `requireAdmin` first. That check is a
// throw, not a branch, so a route that forgets it does not fail closed - it quietly hands a member
// the administrator's view. Every handler below that touches another member calls it on its own
// first line for exactly that reason.

import { readFile } from "node:fs/promises";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { CreateTeamInviteInput, InviteSummary, TeamPresenceSnapshot } from "@openbot/contracts/ipc";
import { isBoolean } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { TeamStore } from "../team-store";
import type { TeamApiRemoteScreen } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { nullableString, pathIdentifier, readJson, requireAdmin, stringField } from "./request-helpers";

export interface TeamRouteDependencies {
  store: Pick<
    TeamStore,
    | "logout"
    | "changePassword"
    | "resolveLogo"
    | "listMembers"
    | "updateMember"
    | "removeMember"
    | "listInvites"
    | "revokeInvite"
    | "listSessions"
    | "revokeSession"
  >;
  remoteScreen?: Pick<TeamApiRemoteScreen, "revokeTeamSession" | "revokeMember">;
  createInvite?: (input: CreateTeamInviteInput) => Promise<InviteSummary>;
  onSessionRevoked?: (sessionId: string) => Promise<void> | void;
  getPresence: () => TeamPresenceSnapshot;
  refreshPresence: () => void;
}

export async function routeTeam(
  context: TeamApiRequestContext,
  { store, remoteScreen, createInvite, onSessionRevoked, getPresence, refreshPresence }: TeamRouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, request, response, member, token, sessionId, json, empty } = context;

  if (method === "POST" && url.pathname === TEAM_API_ROUTES.auth.logout) {
    await store.logout(token);
    await remoteScreen?.revokeTeamSession(sessionId);
    refreshPresence();
    return empty(204);
  }
  if (method === "POST" && url.pathname === TEAM_API_ROUTES.auth.password) {
    const body = await readJson(request);
    await store.changePassword(
      member.id,
      stringField(body, "currentPassword", false, 256),
      stringField(body, "newPassword", false, 256),
    );
    await remoteScreen?.revokeMember(member.id);
    refreshPresence();
    return empty(204);
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.me) {
    return json(200, member);
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.presence) {
    return json(200, getPresence());
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.logo) {
    const logo = store.resolveLogo();
    if (!logo || (url.searchParams.get("v") && url.searchParams.get("v") !== logo.version)) {
      return json(404, { error: "Server logo not found." });
    }
    const bytes = await readFile(logo.path);
    response.writeHead(200, {
      "Content-Type": logo.mimeType,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
    return "handled";
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.events) {
    return json(426, { error: "Use WebSocket for remote events." });
  }
  // Two routes a released client still asks for. They answer 426 rather than 404 so the client
  // shows "update the host" instead of treating the host as broken; the features behind them are
  // gone, and the wire protocol is frozen, so the tombstones stay.
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.host.remoteMac) {
    return json(426, { error: "Update required.", code: "protocol_mismatch" });
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.host.remoteDesktopAccess) {
    return json(426, { error: "Update required.", code: "protocol_mismatch" });
  }

  if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.members) {
    requireAdmin(member);
    return json(200, store.listMembers());
  }
  const memberMatch = url.pathname.match(/^\/v1\/team\/members\/([^/]+)$/);
  if (method === "PATCH" && memberMatch) {
    requireAdmin(member);
    const body = await readJson(request);
    const role = body.role;
    const disabled = body.disabled;
    if (role !== undefined && role !== "admin" && role !== "member") {
      throw new HttpError(400, "Invalid role.");
    }
    if (disabled !== undefined && !isBoolean(disabled)) {
      throw new HttpError(400, "disabled must be a boolean.");
    }
    const updated = await store.updateMember(pathIdentifier(memberMatch[1], "memberId"), {
      ...(role ? { role } : {}),
      ...(disabled === undefined ? {} : { disabled }),
    });
    if (updated.disabled) await remoteScreen?.revokeMember(updated.id);
    refreshPresence();
    return json(200, updated);
  }
  if (method === "DELETE" && memberMatch) {
    requireAdmin(member);
    const removedMemberId = pathIdentifier(memberMatch[1], "memberId");
    await store.removeMember(removedMemberId);
    await remoteScreen?.revokeMember(removedMemberId);
    refreshPresence();
    return empty(204);
  }
  if (method === "POST" && url.pathname === TEAM_API_ROUTES.team.invites) {
    requireAdmin(member);
    const body = await readJson(request);
    const role = stringField(body, "role");
    if (role !== "admin" && role !== "member") throw new HttpError(400, "Invalid role.");
    const email = nullableString(body, "email", INPUT_LIMITS.email) ?? undefined;
    if (!createInvite) throw new HttpError(503, "Invitation service is unavailable.");
    return json(201, await createInvite({ role, ...(email ? { email } : {}) }));
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.invites) {
    requireAdmin(member);
    return json(200, store.listInvites());
  }
  const inviteMatch = url.pathname.match(/^\/v1\/team\/invites\/([^/]+)$/);
  if (method === "DELETE" && inviteMatch) {
    requireAdmin(member);
    await store.revokeInvite(pathIdentifier(inviteMatch[1], "inviteId"));
    return empty(204);
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.sessions) {
    requireAdmin(member);
    return json(200, store.listSessions());
  }
  const sessionMatch = url.pathname.match(/^\/v1\/team\/sessions\/([^/]+)$/);
  if (method === "DELETE" && sessionMatch) {
    requireAdmin(member);
    const revokedSessionId = pathIdentifier(sessionMatch[1], "sessionId");
    await store.revokeSession(revokedSessionId);
    await onSessionRevoked?.(revokedSessionId);
    await remoteScreen?.revokeTeamSession(revokedSessionId);
    refreshPresence();
    return empty(204);
  }

  return "unmatched";
}
