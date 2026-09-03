// An agent's long-lived memories: the notes it carries between threads.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import type { AgentService } from "../../backend/agent-service";
import { decodeBotMemories, decodeBotMemory, decodeVoid, type RemoteServerManager } from "../remote-server-manager";
import { handleTrusted } from "../trusted-ipc";
import { parseAgentRequest, parseCreateBotMemory, parseDeleteBotMemory, parseUpdateBotMemory } from "./agent-inputs";
import { requireString } from "./validation";

interface MemoryIpcDependencies {
  service: AgentService;
  remoteServers: RemoteServerManager;
}

export function registerMemoryIpcHandlers({ service, remoteServers }: MemoryIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.agentListMemories, parseAgentRequest, (scoped) => {
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return scoped.serverId === "local"
      ? service.listMemories(botId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(botId)}/memories`,
          {},
          scoped.serverId,
          decodeBotMemories,
        );
  });
  handleTrusted(IPC_CHANNELS.agentCreateMemory, parseAgentRequest, (scoped) => {
    const parsed = parseCreateBotMemory(scoped.payload);
    return scoped.serverId === "local"
      ? service.createMemory(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/memories`,
          { method: "POST", body: { text: parsed.text } },
          scoped.serverId,
          decodeBotMemory,
        );
  });
  handleTrusted(IPC_CHANNELS.agentUpdateMemory, parseAgentRequest, (scoped) => {
    const parsed = parseUpdateBotMemory(scoped.payload);
    return scoped.serverId === "local"
      ? service.updateMemory(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/memories/${encodeURIComponent(parsed.memoryId)}`,
          { method: "PATCH", body: { text: parsed.text } },
          scoped.serverId,
          decodeBotMemory,
        );
  });
  handleTrusted(IPC_CHANNELS.agentDeleteMemory, parseAgentRequest, (scoped) => {
    const parsed = parseDeleteBotMemory(scoped.payload);
    if (scoped.serverId === "local") return service.deleteMemory(parsed);
    return remoteServers.request(
      `/v1/agents/${encodeURIComponent(parsed.botId)}/memories/${encodeURIComponent(parsed.memoryId)}`,
      { method: "DELETE" },
      scoped.serverId,
      decodeVoid,
    );
  });
  handleTrusted(IPC_CHANNELS.agentClearMemories, parseAgentRequest, (scoped) => {
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    if (scoped.serverId === "local") return service.clearMemories(botId);
    return remoteServers.request(
      `/v1/agents/${encodeURIComponent(botId)}/memories`,
      { method: "DELETE" },
      scoped.serverId,
      decodeVoid,
    );
  });
}
