// An agent's core surface: status, bots, conversations, the queue and the prompts
// a turn can raise. Memories, routines and attachments are their own registrars.
// Every one of these routes to the local service or to a remote server by the
// `serverId` in the request.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type DuplicateBotResult,
  IPC_CHANNELS,
  type SendMessageInput,
  type SidebarLayoutSnapshot,
  type UpdateBotInput,
} from "@openbot/contracts/ipc";
import type { AgentService } from "../../backend/agent-service";
import type { SidebarLayoutStore } from "../../backend/sidebar-layout-store";
import type { HostService } from "../host-service";
import {
  decodeAccountUsage,
  decodeAgentModelOptions,
  decodeAgentStatus,
  decodeBotSummaries,
  decodeBotSummary,
  decodeInstalledSkills,
  decodeQueuedMessageReceipt,
  decodeQueueSnapshot,
  decodeSidebarLayoutSnapshot,
  decodeVoid,
  type RemoteServerManager,
} from "../remote-server-manager";
import type { SkillMarketplaceService } from "../skill-marketplace-service";
import { handleTrusted } from "../trusted-ipc";
import {
  parseAcknowledgeFailedTurn,
  parseAgentId,
  parseAgentRequest,
  parseApprovalResponse,
  parseBrowserTakeoverResponse,
  parseCancelQueuedMessage,
  parseCreateBot,
  parseInterrupt,
  parseMarkConversationRead,
  parseMessageReaction,
  parsePromptResponse,
  parseReadConversationPage,
  parseReorderQueue,
  parseSearchConversationMessages,
  parseSendMessage,
  parseSetAgentAvatar,
  parseSidebarLayoutAction,
  parseSteerQueuedMessage,
  parseUpdateBot,
  parseUpdateQueuedMessage,
} from "./agent-inputs";
import { requireString } from "./validation";

export interface AgentIpcDependencies {
  service: AgentService;
  sidebarLayout: SidebarLayoutStore;
  host: HostService;
  remoteServers: RemoteServerManager;
  skills: SkillMarketplaceService;
}

export function registerAgentIpcHandlers({
  service,
  sidebarLayout,
  host,
  remoteServers,
  skills,
}: AgentIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.agentGetStatus, parseAgentRequest, (parsed) => {
    const { serverId } = parsed;
    return serverId === "local"
      ? service.getStatus()
      : remoteServers.request("/v1/agents/status", {}, serverId, decodeAgentStatus);
  });
  handleTrusted(IPC_CHANNELS.agentGetUsage, parseAgentRequest, (parsed) => {
    const { serverId, payload } = parsed;
    const botId = parseAgentId(payload);
    if (serverId === "local") return service.getUsage(botId);
    if (!remoteServers.supportsCapability(serverId, "model-scoped-usage")) return { limits: [] };
    return remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}/usage`, {}, serverId, decodeAccountUsage);
  });
  handleTrusted(IPC_CHANNELS.agentListModels, parseAgentRequest, (parsed) => {
    const { serverId } = parsed;
    return serverId === "local"
      ? service.listModels()
      : remoteServers.request("/v1/agents/models", {}, serverId, decodeAgentModelOptions);
  });
  handleTrusted(IPC_CHANNELS.agentListBots, parseAgentRequest, (parsed) => {
    const { serverId } = parsed;
    return serverId === "local"
      ? service.listBots()
      : remoteServers.request("/v1/agents", {}, serverId, decodeBotSummaries);
  });
  handleTrusted(IPC_CHANNELS.agentListInstalledSkills, parseAgentRequest, (scoped) => {
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return scoped.serverId === "local"
      ? skills.listInstalledForChatTags(botId)
      : remoteServers
            .list()
            .find((server) => server.id === scoped.serverId)
            ?.compatibility?.capabilities.includes("installed-skills")
        ? remoteServers.request(
            `/v1/agents/${encodeURIComponent(botId)}/skills`,
            {},
            scoped.serverId,
            decodeInstalledSkills,
          )
        : Promise.resolve([]);
  });
  handleTrusted(
    IPC_CHANNELS.agentGetSidebarLayout,
    parseAgentRequest,
    ({ serverId }): Promise<SidebarLayoutSnapshot> => {
      return serverId === "local"
        ? Promise.resolve(sidebarLayout.getSnapshot())
        : remoteServers.request("/v1/sidebar-layout", {}, serverId, decodeSidebarLayoutSnapshot);
    },
  );
  handleTrusted(IPC_CHANNELS.agentMutateSidebarLayout, parseAgentRequest, (scoped): Promise<SidebarLayoutSnapshot> => {
    const action = parseSidebarLayoutAction(scoped.payload);
    return scoped.serverId === "local"
      ? sidebarLayout.mutate(action, new Set(service.listBots().map((bot) => bot.id)))
      : remoteServers.request(
          "/v1/sidebar-layout/actions",
          { method: "POST", body: action },
          scoped.serverId,
          decodeSidebarLayoutSnapshot,
        );
  });
  handleTrusted(IPC_CHANNELS.agentCreateBot, parseAgentRequest, ({ serverId, payload }) => {
    const parsed = parseCreateBot(payload);
    return serverId === "local"
      ? service.createBot(parsed)
      : remoteServers.request("/v1/agents", { method: "POST", body: parsed }, serverId, decodeBotSummary);
  });
  handleTrusted(IPC_CHANNELS.agentDuplicateBot, parseAgentRequest, (scoped): Promise<DuplicateBotResult> => {
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return routeDuplicateBot(service, sidebarLayout, remoteServers, scoped.serverId, botId);
  });
  handleTrusted(IPC_CHANNELS.agentUpdateBot, parseAgentRequest, (scoped) => {
    return routeUpdateBot(service, remoteServers, scoped.serverId, parseUpdateBot(scoped.payload));
  });
  handleTrusted(IPC_CHANNELS.agentSetAvatar, parseAgentRequest, (scoped) => {
    const parsed = parseSetAgentAvatar(scoped.payload);
    return scoped.serverId === "local"
      ? service.setAvatar(parsed.botId, parsed.image)
      : remoteServers.setAgentAvatar(parsed.botId, parsed.image, scoped.serverId);
  });
  handleTrusted(IPC_CHANNELS.agentDeleteBot, parseAgentRequest, (scoped) => {
    const botId = requireString(scoped.payload, "botId");
    return routeDeleteBot(service, sidebarLayout, remoteServers, scoped.serverId, botId);
  });
  handleTrusted(IPC_CHANNELS.agentReadConversation, parseAgentRequest, (scoped) => {
    return routeReadConversation(host, remoteServers, scoped.serverId, requireString(scoped.payload, "botId"));
  });
  handleTrusted(IPC_CHANNELS.agentReadConversationPage, parseAgentRequest, (scoped) => {
    const parsed = parseReadConversationPage(scoped.payload);
    return scoped.serverId === "local"
      ? host.readAgentConversationPage(parsed.botId, parsed.anchor, parsed.limit)
      : remoteServers.readAgentConversationPage(parsed.botId, parsed.anchor, parsed.limit, scoped.serverId);
  });
  handleTrusted(IPC_CHANNELS.agentSearchConversationMessages, parseAgentRequest, (scoped) => {
    const parsed = parseSearchConversationMessages(scoped.payload);
    return scoped.serverId === "local"
      ? host.searchAgentConversationMessages(parsed.query, parsed.botId, parsed.cursor, parsed.limit)
      : remoteServers.searchAgentConversationMessages(
          parsed.query,
          parsed.botId,
          parsed.cursor,
          parsed.limit,
          scoped.serverId,
        );
  });
  handleTrusted(IPC_CHANNELS.agentListConversationReads, parseAgentRequest, (parsed) => {
    const { serverId } = parsed;
    return serverId === "local"
      ? host.listAgentConversationReads()
      : remoteServers.listAgentConversationReads(serverId);
  });
  handleTrusted(IPC_CHANNELS.agentMarkConversationRead, parseAgentRequest, (scoped) => {
    const parsed = parseMarkConversationRead(scoped.payload);
    return scoped.serverId === "local"
      ? host.markAgentConversationRead(parsed)
      : remoteServers.markAgentConversationRead(parsed, scoped.serverId);
  });
  handleTrusted(IPC_CHANNELS.agentSendMessage, parseAgentRequest, (scoped) => {
    return routeSendMessage(service, remoteServers, scoped.serverId, parseSendMessage(scoped.payload));
  });
  handleTrusted(IPC_CHANNELS.agentSetMessageReaction, parseAgentRequest, (scoped) => {
    const parsed = parseMessageReaction(scoped.payload);
    return scoped.serverId === "local"
      ? service.setMessageReaction(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/reactions`,
          {
            method: "POST",
            body: parsed,
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentListQueue, parseAgentRequest, (scoped) => {
    return routeListQueue(service, remoteServers, scoped.serverId, requireString(scoped.payload, "botId"));
  });
  handleTrusted(IPC_CHANNELS.agentAcknowledgeFailedTurn, parseAgentRequest, (scoped) => {
    const parsed = parseAcknowledgeFailedTurn(scoped.payload);
    return scoped.serverId === "local"
      ? service.acknowledgeFailedTurn(parsed.botId, parsed.turnId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/failures/acknowledge`,
          { method: "POST", body: { turnId: parsed.turnId } },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentCancelQueuedMessage, parseAgentRequest, (scoped) => {
    const parsed = parseCancelQueuedMessage(scoped.payload);
    return scoped.serverId === "local"
      ? service.cancelQueuedMessage(parsed.botId, parsed.deliveryId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/cancel`,
          {
            method: "POST",
            body: { deliveryId: parsed.deliveryId },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentSteerQueuedMessage, parseAgentRequest, (scoped) => {
    const parsed = parseSteerQueuedMessage(scoped.payload);
    return scoped.serverId === "local"
      ? service.steerQueuedMessage(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/steer`,
          {
            method: "POST",
            body: { deliveryId: parsed.deliveryId, expectedTurnId: parsed.expectedTurnId },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentUpdateQueuedMessage, parseAgentRequest, (scoped) => {
    const parsed = parseUpdateQueuedMessage(scoped.payload);
    return scoped.serverId === "local"
      ? service.updateQueuedMessage(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/update`,
          {
            method: "POST",
            body: {
              deliveryId: parsed.deliveryId,
              text: parsed.text,
              keepAttachmentIds: parsed.keepAttachmentIds,
              attachmentDraftIds: parsed.attachmentDraftIds,
            },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentReorderQueue, parseAgentRequest, (scoped) => {
    const parsed = parseReorderQueue(scoped.payload);
    return scoped.serverId === "local"
      ? service.reorderQueue(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/reorder`,
          { method: "POST", body: { deliveryIds: parsed.deliveryIds } },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentInterrupt, parseAgentRequest, (scoped) => {
    const parsed = parseInterrupt(scoped.payload);
    return scoped.serverId === "local"
      ? service.interrupt(parsed.botId, parsed.turnId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/interrupt`,
          {
            method: "POST",
            body: { turnId: parsed.turnId },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentRespondToPrompt, parseAgentRequest, (scoped) => {
    const parsed = parsePromptResponse(scoped.payload);
    return scoped.serverId === "local"
      ? service.respondToPrompt(parsed)
      : remoteServers.request("/v1/prompts/respond", { method: "POST", body: parsed }, scoped.serverId, decodeVoid);
  });
  handleTrusted(IPC_CHANNELS.agentRespondToApproval, parseAgentRequest, (scoped) => {
    const parsed = parseApprovalResponse(scoped.payload);
    return scoped.serverId === "local"
      ? service.respondToApproval(parsed)
      : remoteServers.request("/v1/approvals/respond", { method: "POST", body: parsed }, scoped.serverId, decodeVoid);
  });
  handleTrusted(IPC_CHANNELS.agentRespondToBrowserTakeover, parseAgentRequest, (scoped) => {
    const parsed = parseBrowserTakeoverResponse(scoped.payload);
    return scoped.serverId === "local"
      ? service.respondToBrowserTakeover(parsed)
      : remoteServers.request(
          "/v1/browser-takeovers/respond",
          { method: "POST", body: parsed },
          scoped.serverId,
          decodeVoid,
        );
  });
}

function routeUpdateBot(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: UpdateBotInput,
) {
  return serverId === "local"
    ? service.updateBot(input)
    : remoteServers.request(
        `/v1/agents/${encodeURIComponent(input.botId)}`,
        {
          method: "PATCH",
          body: input,
        },
        serverId,
        decodeBotSummary,
      );
}

async function routeDeleteBot(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  remoteServers: RemoteServerManager,
  serverId: string,
  botId: string,
): Promise<void> {
  if (serverId === "local") {
    await service.deleteBot(botId);
    await sidebarLayout.removeAgent(botId);
    return;
  }
  await remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}`, { method: "DELETE" }, serverId, decodeVoid);
}

async function routeDuplicateBot(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  remoteServers: RemoteServerManager,
  serverId: string,
  botId: string,
): Promise<DuplicateBotResult> {
  if (serverId !== "local") {
    return remoteServers.duplicateBot(botId, serverId);
  }
  const bot = await service.duplicateBot(botId);
  try {
    const layout = await sidebarLayout.placeDuplicateAfter(botId, bot.id, [
      ...service.listBots().map((candidate) => candidate.id),
      bot.id,
    ]);
    return service.commitBotDuplication(bot.id, layout);
  } catch (error) {
    const rollbackResults = await Promise.allSettled([service.deleteBot(bot.id), sidebarLayout.removeAgent(bot.id)]);
    const rollbackErrors = rollbackResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Agent duplication failed and the incomplete copy could not be removed.",
      );
    }
    throw error;
  }
}

function routeReadConversation(host: HostService, remoteServers: RemoteServerManager, serverId: string, botId: string) {
  return serverId === "local"
    ? host.readAgentConversation(botId)
    : remoteServers.readAgentConversation(botId, serverId);
}

function routeSendMessage(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: SendMessageInput,
) {
  return serverId === "local"
    ? service.sendMessage(input)
    : remoteServers.request(
        `/v1/agents/${encodeURIComponent(input.botId)}/messages`,
        {
          method: "POST",
          body: input,
        },
        serverId,
        decodeQueuedMessageReceipt,
      );
}

function routeListQueue(service: AgentService, remoteServers: RemoteServerManager, serverId: string, botId: string) {
  return serverId === "local"
    ? service.listQueue(botId)
    : remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}/queue`, {}, serverId, decodeQueueSnapshot);
}
