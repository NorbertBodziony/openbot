// Agents: the collection, the sidebar that arranges them, and everything under one agent's id.
//
// The order in this file is the one thing about it that is not free. The static collection paths -
// `/v1/agents/status`, `usage`, `models`, `conversation-reads` - are matched before the parametric
// regex, which would otherwise read `status` as an agent id and answer 404 for a route that exists.
// Keeping them in the same file as the regex is what makes that ordering reviewable; splitting them
// apart is how it gets broken.
//
// `agentId` is decoded once, above the action switch, and handed to the four sub-modules as an
// `AgentRouteTarget`. A sub-module that re-derived it below its own method check would turn today's
// 400 on a malformed identifier into a 404 for some methods and not others.

import { readFile } from "node:fs/promises";
import { isAvatarMimeType } from "@openbot/contracts/avatar-images";
import { AVATAR_IMAGE_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DuplicateAgentResult } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { parseSidebarLayoutAction } from "../ipc/agent-inputs";
import type { TeamApiAgents, TeamApiOptions, TeamApiSidebarLayout } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import {
  agentCreate,
  agentUpdate,
  approvalDecision,
  browserTakeoverDecision,
  markerExclusionsForCapabilities,
  pageLimit,
  pathIdentifier,
  promptAnswers,
  promptRequestId,
  readBinary,
  readJson,
  stringField,
} from "./request-helpers";
import { routeAgentConversation } from "./route-agent-conversation";
import { routeAgentMemories } from "./route-agent-memories";
import { routeAgentQueue } from "./route-agent-queue";
import { routeAgentRoutines } from "./route-agent-routines";

export interface AgentRouteDependencies {
  // The whole service, unlike every other module here, because this one forwards it to four
  // sub-modules that between them reach most of it. The narrowing that means something is theirs.
  agents: TeamApiAgents;
  skills?: TeamApiOptions["skills"];
  sidebarLayout: Pick<TeamApiSidebarLayout, "getSnapshot" | "mutate" | "removeAgent">;
  duplicateAgent: (agentId: string, operationId: string) => Promise<DuplicateAgentResult>;
}

export async function routeAgents(
  context: TeamApiRequestContext,
  { agents, skills, sidebarLayout, duplicateAgent }: AgentRouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, request, response, member, capabilities, json, empty } = context;

  if (method === "GET" && url.pathname === TEAM_API_ROUTES.messages.search) {
    const query = url.searchParams.get("q") ?? "";
    if (!query.trim() || query.length > INPUT_LIMITS.messageText) {
      throw new HttpError(400, "A valid search query is required.");
    }
    return json(
      200,
      agents.searchConversationMessages(
        query,
        // A query parameter is part of the released URL, and the versioned adapters translate JSON
        // bodies only. `botId` is what every shipped client sends and what every shipped host reads.
        url.searchParams.get("botId") ?? undefined,
        url.searchParams.get("cursor") ?? undefined,
        pageLimit(url),
      ),
    );
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.agents.status) {
    return json(200, agents.getStatus());
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.sidebarLayout.state) {
    return json(200, sidebarLayout.getSnapshot());
  }
  if (method === "POST" && url.pathname === TEAM_API_ROUTES.sidebarLayout.actions) {
    const action = parseSidebarLayoutAction(await readJson(request));
    const layout = await sidebarLayout.mutate(action, new Set(agents.listAgents().map((agent) => agent.id)));
    return json(200, layout);
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.agents.usage) {
    return json(200, await agents.getUsage());
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.agents.models) {
    return json(200, await agents.listModels());
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.agents.all) {
    return json(200, agents.listAgents());
  }
  if (method === "GET" && url.pathname === TEAM_API_ROUTES.agents.conversationReads) {
    return json(200, agents.listConversationReads(member.id, markerExclusionsForCapabilities(capabilities)));
  }
  if (method === "POST" && url.pathname === TEAM_API_ROUTES.agents.all) {
    const body = await readJson(request);
    return json(201, await agents.createAgent(agentCreate(body)));
  }

  const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)(?:\/(.*))?$/);
  if (agentMatch) {
    const agentId = pathIdentifier(agentMatch[1], "agentId");
    const action = agentMatch[2] ?? "";
    if (method === "GET" && action === "usage") {
      return json(200, await agents.getUsage(agentId));
    }
    if (method === "GET" && action === "skills") {
      return json(200, (await skills?.listInstalledForChatTags(agentId)) ?? []);
    }
    if (method === "PATCH" && !action) {
      const body = await readJson(request);
      return json(200, await agents.updateAgent(agentUpdate(body, agentId)));
    }
    if (method === "POST" && action === "duplicate") {
      const body = await readJson(request);
      return json(201, await duplicateAgent(agentId, stringField(body, "operationId")));
    }
    if (method === "DELETE" && !action) {
      if (member.role === "member") throw new HttpError(403, "Members cannot delete agents.");
      await agents.deleteAgent(agentId);
      await sidebarLayout.removeAgent(agentId);
      return empty(204);
    }
    if (action === "avatar") {
      if (method === "PUT") {
        const mimeType = request.headers["content-type"]?.split(";", 1)[0]?.trim() ?? "";
        if (!isAvatarMimeType(mimeType)) {
          throw new HttpError(415, "Choose a PNG, JPEG, or WebP image.");
        }
        const bytes = await readBinary(request, AVATAR_IMAGE_LIMITS.storedBytes);
        return json(200, await agents.setAvatar(agentId, { mimeType, bytes }));
      }
      if (method === "DELETE") {
        return json(200, await agents.setAvatar(agentId, null));
      }
      if (method === "GET") {
        const avatar = agents.resolveAvatar(agentId);
        if (!avatar || avatar.version !== url.searchParams.get("v")) {
          throw new HttpError(404, "Agent avatar not found.");
        }
        const bytes = await readFile(avatar.path);
        response.writeHead(200, {
          "Content-Type": avatar.mimeType,
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(bytes);
        return "handled";
      }
    }

    const target = { agentId, action };
    if ((await routeAgentMemories(context, target, { agents })) === "handled") return "handled";
    if ((await routeAgentRoutines(context, target, { agents })) === "handled") return "handled";
    if ((await routeAgentConversation(context, target, { agents })) === "handled") return "handled";
    if ((await routeAgentQueue(context, target, { agents })) === "handled") return "handled";
  }

  if (method === "POST" && url.pathname === TEAM_API_ROUTES.respond.prompt) {
    const body = await readJson(request);
    await agents.respondToPrompt({
      requestId: promptRequestId(body.requestId),
      answers: promptAnswers(body.answers),
    });
    return empty(204);
  }
  if (method === "POST" && url.pathname === TEAM_API_ROUTES.respond.approval) {
    const body = await readJson(request);
    await agents.respondToApproval({
      requestId: promptRequestId(body.requestId),
      decision: approvalDecision(body.decision),
    });
    return empty(204);
  }
  if (method === "POST" && url.pathname === TEAM_API_ROUTES.respond.browserTakeover) {
    const body = await readJson(request);
    await agents.respondToBrowserTakeover({
      requestId: promptRequestId(body.requestId),
      decision: browserTakeoverDecision(body.decision),
    });
    return empty(204);
  }

  return "unmatched";
}
