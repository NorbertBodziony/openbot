// An agent's long-lived memories: the notes it carries between threads.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { AgentService } from "../../backend/agent-service";
import { decodeBotMemories, decodeBotMemory, decodeVoid, type RemoteServerManager } from "../remote-server-manager";
import { handleTrusted } from "../trusted-ipc";
import { parseAgentRequest, parseCreateBotMemory, parseDeleteBotMemory, parseUpdateBotMemory } from "./agent-inputs";
import { routeToServer } from "./route-to-server";
import { requireString } from "./validation";

interface MemoryIpcDependencies {
  service: AgentService;
  remoteServers: RemoteServerManager;
}

export function registerMemoryIpcHandlers({ service, remoteServers }: MemoryIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.agentListMemories, parseAgentRequest, (scoped) => {
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return routeToServer(scoped.serverId, {
      local: () => service.listMemories(botId),
      remote: (serverId) =>
        remoteServers.request(TEAM_API_ROUTES.agent.memories(botId), {}, serverId, decodeBotMemories),
    });
  });
  handleTrusted(IPC_CHANNELS.agentCreateMemory, parseAgentRequest, (scoped) => {
    const parsed = parseCreateBotMemory(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.createMemory(parsed),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.agent.memories(parsed.botId),
          { method: "POST", body: { text: parsed.text } },
          serverId,
          decodeBotMemory,
        ),
    });
  });
  handleTrusted(IPC_CHANNELS.agentUpdateMemory, parseAgentRequest, (scoped) => {
    const parsed = parseUpdateBotMemory(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.updateMemory(parsed),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.agent.memory(parsed.botId, parsed.memoryId),
          { method: "PATCH", body: { text: parsed.text } },
          serverId,
          decodeBotMemory,
        ),
    });
  });
  handleTrusted(IPC_CHANNELS.agentDeleteMemory, parseAgentRequest, (scoped) => {
    const parsed = parseDeleteBotMemory(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.deleteMemory(parsed),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.agent.memory(parsed.botId, parsed.memoryId),
          { method: "DELETE" },
          serverId,
          decodeVoid,
        ),
    });
  });
  handleTrusted(IPC_CHANNELS.agentClearMemories, parseAgentRequest, (scoped) => {
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return routeToServer(scoped.serverId, {
      local: () => service.clearMemories(botId),
      remote: (serverId) =>
        remoteServers.request(TEAM_API_ROUTES.agent.memories(botId), { method: "DELETE" }, serverId, decodeVoid),
    });
  });
}
