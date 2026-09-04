// The agent marketplace: browsing, submitting and installing a published agent.

import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import type { AgentMarketplaceService } from "../agent-marketplace-service";
import { handleTrusted } from "../trusted-ipc";
import { parseInstallMarketplaceAgent, parseMarketplaceAgentQuery, parseSubmitMarketplaceAgent } from "./app-inputs";
import { nullishPayload, stringPayload } from "./validation";

export interface MarketplaceAgentIpcDependencies {
  marketplaceAgents: AgentMarketplaceService;
}

export function registerMarketplaceAgentIpcHandlers({ marketplaceAgents }: MarketplaceAgentIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.marketplaceAgentsList, nullishPayload(parseMarketplaceAgentQuery), (query) =>
    marketplaceAgents.list(query),
  );
  handleTrusted(IPC_CHANNELS.marketplaceAgentsGet, stringPayload("agentId"), (agentId) =>
    marketplaceAgents.get(agentId),
  );
  handleTrusted(IPC_CHANNELS.marketplaceAgentsListMine, () => marketplaceAgents.listMine());
  handleTrusted(IPC_CHANNELS.marketplaceAgentsPreview, stringPayload("agentId"), (agentId) =>
    marketplaceAgents.preview(agentId),
  );
  handleTrusted(IPC_CHANNELS.marketplaceAgentsSubmit, parseSubmitMarketplaceAgent, (submission) =>
    marketplaceAgents.submit(submission),
  );
  handleTrusted(IPC_CHANNELS.marketplaceAgentsInstall, parseInstallMarketplaceAgent, (installation) =>
    marketplaceAgents.install(installation),
  );
}
