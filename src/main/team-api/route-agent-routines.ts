// One agent's routines: the standing instructions that run on a schedule.
//
// The bodies are parsed by the same `parseCreateRoutine` / `parseUpdateRoutine` the IPC handlers
// use, so a routine created over the Team API cannot differ from one created in the app.

import { parseCreateRoutine, parseListRoutineRuns, parseUpdateRoutine } from "../ipc/agent-inputs";
import type { TeamApiAgents } from "./dependencies";
import type { AgentRouteTarget, RouteOutcome, TeamApiRequestContext } from "./request-context";
import { pathIdentifier, readJson } from "./request-helpers";

export interface AgentRoutineRouteDependencies {
  agents: Pick<
    TeamApiAgents,
    "listRoutines" | "createRoutine" | "updateRoutine" | "deleteRoutine" | "testRoutine" | "listRoutineRuns"
  >;
}

export async function routeAgentRoutines(
  context: TeamApiRequestContext,
  { agentId, action }: AgentRouteTarget,
  { agents }: AgentRoutineRouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, request, json, empty } = context;

  if (action === "routines") {
    if (method === "GET") {
      return json(200, agents.listRoutines(agentId));
    }
    if (method === "POST") {
      const body = await readJson(request);
      return json(201, agents.createRoutine(parseCreateRoutine({ ...body, agentId })));
    }
  }
  const routineMatch = action.match(/^routines\/([^/]+)(?:\/(test|runs))?$/);
  if (routineMatch) {
    const routineId = pathIdentifier(routineMatch[1], "routineId");
    const routineAction = routineMatch[2] ?? "";
    if (method === "PATCH" && !routineAction) {
      const body = await readJson(request);
      return json(200, agents.updateRoutine(parseUpdateRoutine({ ...body, agentId, routineId })));
    }
    if (method === "DELETE" && !routineAction) {
      await agents.deleteRoutine({ agentId, routineId });
      return empty(204);
    }
    if (method === "POST" && routineAction === "test") {
      return json(201, await agents.testRoutine({ agentId, routineId }));
    }
    if (method === "GET" && routineAction === "runs") {
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      return json(200, agents.listRoutineRuns(parseListRoutineRuns({ agentId, routineId, limit })));
    }
  }

  return "unmatched";
}
