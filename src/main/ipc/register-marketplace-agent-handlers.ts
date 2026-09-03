// The agent marketplace: browsing, submitting and installing a published agent.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { isNumber, isString } from "@openbot/contracts/runtime-values";
import type { AgentMarketplaceService } from "../agent-marketplace-service";
import { handleTrusted } from "../trusted-ipc";
import { isObject, requireString } from "./validation";

export interface MarketplaceAgentIpcDependencies {
  marketplaceAgents: AgentMarketplaceService;
}

export function registerMarketplaceAgentIpcHandlers({ marketplaceAgents }: MarketplaceAgentIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.marketplaceAgentsList, (input: unknown) => {
    if (input === null || input === undefined) return marketplaceAgents.list();
    if (!isObject(input)) throw new Error("Invalid agent marketplace query.");
    if (input.sort !== undefined && input.sort !== "installs") throw new Error("Unknown agent sort order.");
    return marketplaceAgents.list({
      ...(isString(input.query) ? { query: input.query.slice(0, 100) } : {}),
      ...(input.featured === true ? { featured: true } : {}),
      ...(input.sort === "installs" ? { sort: "installs" as const } : {}),
      ...(isString(input.cursor) ? { cursor: input.cursor } : {}),
      ...(isNumber(input.limit) ? { limit: input.limit } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.marketplaceAgentsGet, (input: unknown) =>
    marketplaceAgents.get(requireString(input, "agentId")),
  );
  handleTrusted(IPC_CHANNELS.marketplaceAgentsListMine, () => marketplaceAgents.listMine());
  handleTrusted(IPC_CHANNELS.marketplaceAgentsPreview, (input: unknown) =>
    marketplaceAgents.preview(requireString(input, "botId")),
  );
  handleTrusted(IPC_CHANNELS.marketplaceAgentsSubmit, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid agent submission.");
    return marketplaceAgents.submit({
      botId: requireString(input.botId, "botId"),
      ...(input.agentId === undefined ? {} : { agentId: requireString(input.agentId, "agentId") }),
    });
  });
  handleTrusted(IPC_CHANNELS.marketplaceAgentsInstall, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid agent installation.");
    return marketplaceAgents.install({
      agentId: requireString(input.agentId, "agentId"),
      ...(input.botId === undefined ? {} : { botId: requireString(input.botId, "botId", INPUT_LIMITS.identifier) }),
      timezone: requireString(input.timezone, "timezone", 255),
      receiptId: requireString(input.receiptId, "receiptId", INPUT_LIMITS.identifier),
    });
  });
}
