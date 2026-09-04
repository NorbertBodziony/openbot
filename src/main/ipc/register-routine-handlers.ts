// Routines: the scheduled standing instructions attached to one agent.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { AgentService } from "../../backend/agent-service";
import { decodeRoutine, decodeRoutineRun, decodeRoutineRuns, decodeRoutines } from "../remote-agent-decoding";
import { decodeVoid } from "../remote-host-decoding";
import type { RemoteServerManager } from "../remote-server-manager";
import { handleTrusted } from "../trusted-ipc";
import {
  parseAgentRequest,
  parseCreateRoutine,
  parseDeleteRoutine,
  parseListRoutineRuns,
  parseTestRoutine,
  parseUpdateRoutine,
} from "./agent-inputs";
import { routeToServer } from "./route-to-server";
import { requireString } from "./validation";

interface RoutineIpcDependencies {
  service: AgentService;
  remoteServers: RemoteServerManager;
}

export function registerRoutineIpcHandlers({ service, remoteServers }: RoutineIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.agentListRoutines, parseAgentRequest, (scoped) => {
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return routeToServer(scoped.serverId, {
      local: () => service.listRoutines(botId),
      remote: (serverId) => remoteServers.request(TEAM_API_ROUTES.agent.routines(botId), {}, serverId, decodeRoutines),
    });
  });
  handleTrusted(IPC_CHANNELS.agentCreateRoutine, parseAgentRequest, (scoped) => {
    const parsed = parseCreateRoutine(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.createRoutine(parsed),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.agent.routines(parsed.botId),
          { method: "POST", body: parsed },
          serverId,
          decodeRoutine,
        ),
    });
  });
  handleTrusted(IPC_CHANNELS.agentUpdateRoutine, parseAgentRequest, (scoped) => {
    const parsed = parseUpdateRoutine(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.updateRoutine(parsed),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.agent.routine(parsed.botId, parsed.routineId),
          { method: "PATCH", body: parsed },
          serverId,
          decodeRoutine,
        ),
    });
  });
  handleTrusted(IPC_CHANNELS.agentDeleteRoutine, parseAgentRequest, (scoped) => {
    const parsed = parseDeleteRoutine(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.deleteRoutine(parsed),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.agent.routine(parsed.botId, parsed.routineId),
          { method: "DELETE" },
          serverId,
          decodeVoid,
        ),
    });
  });
  handleTrusted(IPC_CHANNELS.agentTestRoutine, parseAgentRequest, (scoped) => {
    const parsed = parseTestRoutine(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.testRoutine(parsed),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.agent.routineTest(parsed.botId, parsed.routineId),
          { method: "POST" },
          serverId,
          decodeRoutineRun,
        ),
    });
  });
  handleTrusted(IPC_CHANNELS.agentListRoutineRuns, parseAgentRequest, (scoped) => {
    const parsed = parseListRoutineRuns(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.listRoutineRuns(parsed),
      remote: (serverId) =>
        remoteServers.request(
          `${TEAM_API_ROUTES.agent.routineRuns(parsed.botId, parsed.routineId)}?limit=${parsed.limit}`,
          {},
          serverId,
          decodeRoutineRuns,
        ),
    });
  });
}
