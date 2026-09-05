// One agent's memories: the standing notes it carries into every turn.
//
// `memoryId` is decoded by `pathIdentifier` on the first line of the parametric branch, before any
// method is matched, so a malformed id is a 400 and not a 404. That ordering is the released
// behaviour and the status-contract test pins it.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { TeamApiAgents } from "./dependencies";
import type { AgentRouteTarget, RouteOutcome, TeamApiRequestContext } from "./request-context";
import { pathIdentifier, readJson, stringField } from "./request-helpers";

export interface AgentMemoryRouteDependencies {
  agents: Pick<TeamApiAgents, "listMemories" | "createMemory" | "updateMemory" | "deleteMemory" | "clearMemories">;
}

export async function routeAgentMemories(
  context: TeamApiRequestContext,
  { agentId, action }: AgentRouteTarget,
  { agents }: AgentMemoryRouteDependencies,
): Promise<RouteOutcome> {
  const { method, request, json, empty } = context;

  if (action === "memories") {
    if (method === "GET") {
      return json(200, agents.listMemories(agentId));
    }
    if (method === "POST") {
      const body = await readJson(request);
      return json(
        201,
        agents.createMemory({
          agentId,
          text: stringField(body, "text", false, INPUT_LIMITS.agentMemoryText),
        }),
      );
    }
    if (method === "DELETE") {
      agents.clearMemories(agentId);
      return empty(204);
    }
  }
  const memoryMatch = action.match(/^memories\/([^/]+)$/);
  if (memoryMatch) {
    const memoryId = pathIdentifier(memoryMatch[1], "memoryId");
    if (method === "PATCH") {
      const body = await readJson(request);
      return json(
        200,
        agents.updateMemory({
          agentId,
          memoryId,
          text: stringField(body, "text", false, INPUT_LIMITS.agentMemoryText),
        }),
      );
    }
    if (method === "DELETE") {
      agents.deleteMemory({ agentId, memoryId });
      return empty(204);
    }
  }

  return "unmatched";
}
