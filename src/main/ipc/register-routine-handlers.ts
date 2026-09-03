// Routines: the scheduled standing instructions attached to one agent.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import type { AgentService } from "../../backend/agent-service";
import {
  decodeRoutine,
  decodeRoutineRun,
  decodeRoutineRuns,
  decodeRoutines,
  decodeVoid,
  type RemoteServerManager,
} from "../remote-server-manager";
import { handleTrusted } from "../trusted-ipc";
import {
  parseAgentRequest,
  parseCreateRoutine,
  parseDeleteRoutine,
  parseListRoutineRuns,
  parseTestRoutine,
  parseUpdateRoutine,
} from "./agent-inputs";
import { requireString } from "./validation";

interface RoutineIpcDependencies {
  service: AgentService;
  remoteServers: RemoteServerManager;
}

export function registerRoutineIpcHandlers({ service, remoteServers }: RoutineIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.agentListRoutines, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return scoped.serverId === "local"
      ? service.listRoutines(botId)
      : remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}/routines`, {}, scoped.serverId, decodeRoutines);
  });
  handleTrusted(IPC_CHANNELS.agentCreateRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseCreateRoutine(scoped.payload);
    return scoped.serverId === "local"
      ? service.createRoutine(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines`,
          { method: "POST", body: parsed },
          scoped.serverId,
          decodeRoutine,
        );
  });
  handleTrusted(IPC_CHANNELS.agentUpdateRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseUpdateRoutine(scoped.payload);
    return scoped.serverId === "local"
      ? service.updateRoutine(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}`,
          { method: "PATCH", body: parsed },
          scoped.serverId,
          decodeRoutine,
        );
  });
  handleTrusted(IPC_CHANNELS.agentDeleteRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseDeleteRoutine(scoped.payload);
    if (scoped.serverId === "local") return service.deleteRoutine(parsed);
    return remoteServers.request(
      `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}`,
      { method: "DELETE" },
      scoped.serverId,
      decodeVoid,
    );
  });
  handleTrusted(IPC_CHANNELS.agentTestRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseTestRoutine(scoped.payload);
    return scoped.serverId === "local"
      ? service.testRoutine(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}/test`,
          { method: "POST" },
          scoped.serverId,
          decodeRoutineRun,
        );
  });
  handleTrusted(IPC_CHANNELS.agentListRoutineRuns, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseListRoutineRuns(scoped.payload);
    return scoped.serverId === "local"
      ? service.listRoutineRuns(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}/runs?limit=${parsed.limit}`,
          {},
          scoped.serverId,
          decodeRoutineRuns,
        );
  });
}
