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
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { AgentService } from "../../backend/agent-service";
import type { SidebarLayoutStore } from "../../backend/sidebar-layout-store";
import type { HostService } from "../host-service";
import {
  decodeAccountUsageFromHost,
  decodeAgentModelOptions,
  decodeAgentStatusFromHost,
  decodeBotSummaries,
  decodeBotSummary,
  decodeInstalledSkillsFromHost,
  decodeQueuedMessageReceipt,
  decodeQueueSnapshot,
  decodeSidebarLayoutSnapshot,
} from "../remote-agent-decoding";
import { decodeVoid } from "../remote-host-decoding";
import type { RemoteServerManager } from "../remote-server-manager";
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
import { routeToServer } from "./route-to-server";
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
    return routeToServer(parsed.serverId, {
      local: () => service.getStatus(),
      remote: (serverId) => remoteServers.request(serverId, TEAM_API_ROUTES.agents.status, decodeAgentStatusFromHost),
    });
  });
  handleTrusted(IPC_CHANNELS.agentGetUsage, parseAgentRequest, (parsed) => {
    const botId = parseAgentId(parsed.payload);
    return routeToServer(parsed.serverId, {
      local: () => service.getUsage(botId),
      remote: (serverId) =>
        remoteServers.supportsCapability(serverId, "model-scoped-usage")
          ? remoteServers.request(serverId, TEAM_API_ROUTES.agent.usage(botId), decodeAccountUsageFromHost)
          : { limits: [] },
    });
  });
  handleTrusted(IPC_CHANNELS.agentListModels, parseAgentRequest, (parsed) => {
    return routeToServer(parsed.serverId, {
      local: () => service.listModels(),
      remote: (serverId) => remoteServers.request(serverId, TEAM_API_ROUTES.agents.models, decodeAgentModelOptions),
    });
  });
  handleTrusted(IPC_CHANNELS.agentListBots, parseAgentRequest, (parsed) => {
    return routeToServer(parsed.serverId, {
      local: () => service.listBots(),
      remote: (serverId) => remoteServers.request(serverId, TEAM_API_ROUTES.agents.all, decodeBotSummaries),
    });
  });
  handleTrusted(IPC_CHANNELS.agentListInstalledSkills, parseAgentRequest, (scoped) => {
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return routeToServer(scoped.serverId, {
      local: () => skills.listInstalledForChatTags(botId),
      // A server too old to know the endpoint would answer 404, so ask its advertised capabilities first.
      remote: (serverId) =>
        remoteServers
          .list()
          .find((server) => server.id === serverId)
          ?.compatibility?.capabilities.includes("installed-skills")
          ? remoteServers.request(serverId, TEAM_API_ROUTES.agent.skills(botId), decodeInstalledSkillsFromHost)
          : Promise.resolve([]),
    });
  });
  handleTrusted(IPC_CHANNELS.agentGetSidebarLayout, parseAgentRequest, (parsed): Promise<SidebarLayoutSnapshot> => {
    return routeToServer(parsed.serverId, {
      local: () => sidebarLayout.getSnapshot(),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.sidebarLayout.state, decodeSidebarLayoutSnapshot),
    });
  });
  handleTrusted(IPC_CHANNELS.agentMutateSidebarLayout, parseAgentRequest, (scoped): Promise<SidebarLayoutSnapshot> => {
    const action = parseSidebarLayoutAction(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => sidebarLayout.mutate(action, new Set(service.listBots().map((bot) => bot.id))),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.sidebarLayout.actions, decodeSidebarLayoutSnapshot, {
          method: "POST",
          body: action,
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentCreateBot, parseAgentRequest, (scoped) => {
    const parsed = parseCreateBot(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.createBot(parsed),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agents.all, decodeBotSummary, { method: "POST", body: parsed }),
    });
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
    return routeToServer(scoped.serverId, {
      local: () => service.setAvatar(parsed.botId, parsed.image),
      remote: (serverId) => remoteServers.setAgentAvatar(parsed.botId, parsed.image, serverId),
    });
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
    return routeToServer(scoped.serverId, {
      local: () => host.readAgentConversationPage(parsed.botId, parsed.anchor, parsed.limit),
      remote: (serverId) =>
        remoteServers.readAgentConversationPage(parsed.botId, parsed.anchor, parsed.limit, serverId),
    });
  });
  handleTrusted(IPC_CHANNELS.agentSearchConversationMessages, parseAgentRequest, (scoped) => {
    const parsed = parseSearchConversationMessages(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => host.searchAgentConversationMessages(parsed.query, parsed.botId, parsed.cursor, parsed.limit),
      remote: (serverId) =>
        remoteServers.searchAgentConversationMessages(
          parsed.query,
          parsed.botId,
          parsed.cursor,
          parsed.limit,
          serverId,
        ),
    });
  });
  handleTrusted(IPC_CHANNELS.agentListConversationReads, parseAgentRequest, (parsed) => {
    return routeToServer(parsed.serverId, {
      local: () => host.listAgentConversationReads(),
      remote: (serverId) => remoteServers.listAgentConversationReads(serverId),
    });
  });
  handleTrusted(IPC_CHANNELS.agentMarkConversationRead, parseAgentRequest, (scoped) => {
    const parsed = parseMarkConversationRead(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => host.markAgentConversationRead(parsed),
      remote: (serverId) => remoteServers.markAgentConversationRead(parsed, serverId),
    });
  });
  handleTrusted(IPC_CHANNELS.agentSendMessage, parseAgentRequest, (scoped) => {
    return routeSendMessage(service, remoteServers, scoped.serverId, parseSendMessage(scoped.payload));
  });
  handleTrusted(IPC_CHANNELS.agentSetMessageReaction, parseAgentRequest, (scoped) => {
    const parsed = parseMessageReaction(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.setMessageReaction(parsed),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.reactions(parsed.botId), decodeVoid, {
          method: "POST",
          body: parsed,
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentListQueue, parseAgentRequest, (scoped) => {
    return routeListQueue(service, remoteServers, scoped.serverId, requireString(scoped.payload, "botId"));
  });
  handleTrusted(IPC_CHANNELS.agentAcknowledgeFailedTurn, parseAgentRequest, (scoped) => {
    const parsed = parseAcknowledgeFailedTurn(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.acknowledgeFailedTurn(parsed.botId, parsed.turnId),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.failuresAcknowledge(parsed.botId), decodeVoid, {
          method: "POST",
          body: { turnId: parsed.turnId },
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentCancelQueuedMessage, parseAgentRequest, (scoped) => {
    const parsed = parseCancelQueuedMessage(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.cancelQueuedMessage(parsed.botId, parsed.deliveryId),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.queueCancel(parsed.botId), decodeVoid, {
          method: "POST",
          body: { deliveryId: parsed.deliveryId },
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentSteerQueuedMessage, parseAgentRequest, (scoped) => {
    const parsed = parseSteerQueuedMessage(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.steerQueuedMessage(parsed),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.queueSteer(parsed.botId), decodeVoid, {
          method: "POST",
          body: { deliveryId: parsed.deliveryId, expectedTurnId: parsed.expectedTurnId },
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentUpdateQueuedMessage, parseAgentRequest, (scoped) => {
    const parsed = parseUpdateQueuedMessage(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.updateQueuedMessage(parsed),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.queueUpdate(parsed.botId), decodeVoid, {
          method: "POST",
          body: {
            deliveryId: parsed.deliveryId,
            text: parsed.text,
            keepAttachmentIds: parsed.keepAttachmentIds,
            attachmentDraftIds: parsed.attachmentDraftIds,
          },
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentReorderQueue, parseAgentRequest, (scoped) => {
    const parsed = parseReorderQueue(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.reorderQueue(parsed),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.queueReorder(parsed.botId), decodeVoid, {
          method: "POST",
          body: { deliveryIds: parsed.deliveryIds },
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentInterrupt, parseAgentRequest, (scoped) => {
    const parsed = parseInterrupt(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.interrupt(parsed.botId, parsed.turnId),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.interrupt(parsed.botId), decodeVoid, {
          method: "POST",
          body: { turnId: parsed.turnId },
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentRespondToPrompt, parseAgentRequest, (scoped) => {
    const parsed = parsePromptResponse(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.respondToPrompt(parsed),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.respond.prompt, decodeVoid, { method: "POST", body: parsed }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentRespondToApproval, parseAgentRequest, (scoped) => {
    const parsed = parseApprovalResponse(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.respondToApproval(parsed),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.respond.approval, decodeVoid, { method: "POST", body: parsed }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentRespondToBrowserTakeover, parseAgentRequest, (scoped) => {
    const parsed = parseBrowserTakeoverResponse(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.respondToBrowserTakeover(parsed),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.respond.browserTakeover, decodeVoid, {
          method: "POST",
          body: parsed,
        }),
    });
  });
}

function routeUpdateBot(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: UpdateBotInput,
) {
  return routeToServer(serverId, {
    local: () => service.updateBot(input),
    remote: (target) =>
      remoteServers.request(target, TEAM_API_ROUTES.agent.one(input.botId), decodeBotSummary, {
        method: "PATCH",
        body: input,
      }),
  });
}

function routeDeleteBot(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  remoteServers: RemoteServerManager,
  serverId: string,
  botId: string,
): Promise<void> {
  return routeToServer<void>(serverId, {
    local: async () => {
      await service.deleteBot(botId);
      await sidebarLayout.removeAgent(botId);
    },
    remote: async (target) => {
      await remoteServers.request(target, TEAM_API_ROUTES.agent.one(botId), decodeVoid, { method: "DELETE" });
    },
  });
}

function routeDuplicateBot(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  remoteServers: RemoteServerManager,
  serverId: string,
  botId: string,
): Promise<DuplicateBotResult> {
  return routeToServer(serverId, {
    local: () => duplicateBotLocally(service, sidebarLayout, botId),
    remote: (target) => remoteServers.duplicateBot(botId, target),
  });
}

// The local copy is a two-store transaction: the agent, then its place in the sidebar. If placing it
// fails the half-made copy has to go, or the user is left with an agent they never asked for.
async function duplicateBotLocally(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  botId: string,
): Promise<DuplicateBotResult> {
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
  return routeToServer(serverId, {
    local: () => host.readAgentConversation(botId),
    remote: (target) => remoteServers.readAgentConversation(botId, target),
  });
}

function routeSendMessage(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: SendMessageInput,
) {
  return routeToServer(serverId, {
    local: () => service.sendMessage(input),
    remote: (target) =>
      remoteServers.request(target, TEAM_API_ROUTES.agent.messages(input.botId), decodeQueuedMessageReceipt, {
        method: "POST",
        body: input,
      }),
  });
}

function routeListQueue(service: AgentService, remoteServers: RemoteServerManager, serverId: string, botId: string) {
  return routeToServer(serverId, {
    local: () => service.listQueue(botId),
    remote: (target) => remoteServers.request(target, TEAM_API_ROUTES.agent.queue(botId), decodeQueueSnapshot),
  });
}
