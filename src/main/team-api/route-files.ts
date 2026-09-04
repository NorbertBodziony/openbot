// Bytes leaving the machine: draft attachments, shared files and workspace files.
//
// These four routes are the only ones that write a body themselves instead of going through
// `json`, so they are also the only ones that must return `"handled"` explicitly - a bare `return`
// here would read as `"unmatched"` and let the router answer 404 over a response it had already
// finished.
//
// None of them scopes anything to the caller: any authenticated member may fetch any attachment id
// or any path. The containment check that makes that safe - the path being inside the shared or
// workspace directory - lives in `AgentService`, so what is enforced here is the size ceiling and
// the length limits, and it must stay enforced here because this is the only caller that reads a
// path off the wire.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { TeamApiAgents, TeamApiMailbox } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { pathIdentifier, readBinary } from "./request-helpers";

export interface FileRouteDependencies {
  agents: Pick<
    TeamApiAgents,
    "prepareImportedAttachments" | "discardDraftAttachment" | "resolveSharedFile" | "resolveWorkspaceFile"
  >;
  mailbox: TeamApiMailbox;
}

export async function routeFiles(
  context: TeamApiRequestContext,
  { agents, mailbox }: FileRouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, request, response, json, empty } = context;

  if (method === "POST" && url.pathname === TEAM_API_ROUTES.attachments) {
    const name = url.searchParams.get("name")?.trim();
    const mimeType = url.searchParams.get("mime") ?? "application/octet-stream";
    if (!name || basename(name) !== name || name.length > INPUT_LIMITS.attachmentName) {
      throw new HttpError(400, "A safe attachment name is required.");
    }
    if (mimeType.length > INPUT_LIMITS.mimeType) {
      throw new HttpError(400, "The attachment MIME type is too long.");
    }
    const bytes = await readBinary(request, ATTACHMENT_LIMITS.fileBytes);
    const attachments = await agents.prepareImportedAttachments([], [{ name, mimeType, bytes }]);
    return json(201, attachments[0]);
  }
  const attachmentMatch = url.pathname.match(/^\/v1\/attachments\/([^/]+)$/);
  if (attachmentMatch) {
    const attachmentId = pathIdentifier(attachmentMatch[1], "attachmentId");
    if (method === "DELETE") {
      await agents.discardDraftAttachment(attachmentId);
      return empty(204);
    }
    if (method === "GET") {
      const attachment = await mailbox.resolveAttachment(attachmentId);
      if (!attachment) throw new HttpError(404, "Attachment not found.");
      const bytes = await readFile(attachment.path);
      response.writeHead(200, {
        "Content-Type": attachment.mimeType || "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(attachment.path))}`,
      });
      response.end(bytes);
      return "handled";
    }
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.sharedFiles) {
    const sharedPath = url.searchParams.get("path");
    if (!sharedPath || sharedPath.length > INPUT_LIMITS.path) {
      throw new HttpError(400, "A valid shared file path is required.");
    }
    const sharedFile = await agents.resolveSharedFile(sharedPath);
    if (sharedFile.size > ATTACHMENT_LIMITS.fileBytes) {
      throw new HttpError(413, "The shared file exceeds the 100 MB limit.");
    }
    const bytes = await readFile(sharedFile.path);
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(sharedFile.name)}`,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
    return "handled";
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.workspaceFiles) {
    const botId = url.searchParams.get("botId");
    const workspacePath = url.searchParams.get("path");
    if (!botId || botId.length > INPUT_LIMITS.identifier) {
      throw new HttpError(400, "A valid agent id is required.");
    }
    if (!workspacePath || workspacePath.length > INPUT_LIMITS.path) {
      throw new HttpError(400, "A valid workspace file path is required.");
    }
    const workspaceFile = await agents.resolveWorkspaceFile(botId, workspacePath);
    if (workspaceFile.size > ATTACHMENT_LIMITS.fileBytes) {
      throw new HttpError(413, "The workspace file exceeds the 100 MB limit.");
    }
    const bytes = await readFile(workspaceFile.path);
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(workspaceFile.name)}`,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
    return "handled";
  }

  return "unmatched";
}
