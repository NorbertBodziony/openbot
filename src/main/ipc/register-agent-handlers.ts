// An agent's core surface: status, agents, conversations, the queue and the prompts
// a turn can raise. Memories, routines and attachments are their own registrars.
// Every one of these routes to the local service or to a remote server by the
// `serverId` in the request.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type DuplicateAgentResult,
  IPC_CHANNELS,
  type SendMessageInput,
  type SidebarLayoutSnapshot,
  type UpdateAgentInput,
} from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { AgentService } from "../../backend/agent-service";
import type { SidebarLayoutStore } from "../../backend/sidebar-layout-store";
import type { HostService } from "../host-service";
import {
  decodeAccountUsageFromHost,
  decodeAgentModelOptions,
  decodeAgentStatusFromHost,
  decodeAgentSummaries,
  decodeAgentSummary,
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
  parseCreateAgent,
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
  parseUpdateAgent,
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
    const agentId = parseAgentId(parsed.payload);
    return routeToServer(parsed.serverId, {
      local: () => service.getUsage(agentId),
      remote: (serverId) =>
        remoteServers.supportsCapability(serverId, "model-scoped-usage")
          ? remoteServers.request(serverId, TEAM_API_ROUTES.agent.usage(agentId), decodeAccountUsageFromHost)
          : { limits: [] },
    });
  });
  handleTrusted(IPC_CHANNELS.agentListModels, parseAgentRequest, (parsed) => {
    return routeToServer(parsed.serverId, {
      local: () => service.listModels(),
      remote: (serverId) => remoteServers.request(serverId, TEAM_API_ROUTES.agents.models, decodeAgentModelOptions),
    });
  });
  handleTrusted(IPC_CHANNELS.agentList, parseAgentRequest, (parsed) => {
    return routeToServer(parsed.serverId, {
      local: () => service.listAgents(),
      remote: (serverId) => remoteServers.request(serverId, TEAM_API_ROUTES.agents.all, decodeAgentSummaries),
    });
  });
  handleTrusted(IPC_CHANNELS.agentListInstalledSkills, parseAgentRequest, (scoped) => {
    const agentId = requireString(scoped.payload, "agentId", INPUT_LIMITS.identifier);
    return routeToServer(scoped.serverId, {
      local: () => skills.listInstalledForChatTags(agentId),
      // A server too old to know the endpoint would answer 404, so ask its advertised capabilities first.
      remote: (serverId) =>
        remoteServers
          .list()
          .find((server) => server.id === serverId)
          ?.compatibility?.capabilities.includes("installed-skills")
          ? remoteServers.request(serverId, TEAM_API_ROUTES.agent.skills(agentId), decodeInstalledSkillsFromHost)
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
      local: () => sidebarLayout.mutate(action, new Set(service.listAgents().map((agent) => agent.id))),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.sidebarLayout.actions, decodeSidebarLayoutSnapshot, {
          method: "POST",
          body: action,
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentCreate, parseAgentRequest, (scoped) => {
    const parsed = parseCreateAgent(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.createAgent(parsed),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agents.all, decodeAgentSummary, {
          method: "POST",
          body: parsed,
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentDuplicate, parseAgentRequest, (scoped): Promise<DuplicateAgentResult> => {
    const agentId = requireString(scoped.payload, "agentId", INPUT_LIMITS.identifier);
    return routeDuplicateAgent(service, sidebarLayout, remoteServers, scoped.serverId, agentId);
  });
  handleTrusted(IPC_CHANNELS.agentUpdate, parseAgentRequest, (scoped) => {
    return routeUpdateAgent(service, remoteServers, scoped.serverId, parseUpdateAgent(scoped.payload));
  });
  handleTrusted(IPC_CHANNELS.agentSetAvatar, parseAgentRequest, (scoped) => {
    const parsed = parseSetAgentAvatar(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.setAvatar(parsed.agentId, parsed.image),
      remote: (serverId) => remoteServers.setAgentAvatar(parsed.agentId, parsed.image, serverId),
    });
  });
  handleTrusted(IPC_CHANNELS.agentDelete, parseAgentRequest, (scoped) => {
    const agentId = requireString(scoped.payload, "agentId");
    return routeDeleteAgent(service, sidebarLayout, remoteServers, scoped.serverId, agentId);
  });
  handleTrusted(IPC_CHANNELS.agentReadConversation, parseAgentRequest, (scoped) => {
    return routeReadConversation(host, remoteServers, scoped.serverId, requireString(scoped.payload, "agentId"));
  });
  handleTrusted(IPC_CHANNELS.agentReadConversationPage, parseAgentRequest, (scoped) => {
    const parsed = parseReadConversationPage(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => host.readAgentConversationPage(parsed.agentId, parsed.anchor, parsed.limit),
      remote: (serverId) =>
        remoteServers.readAgentConversationPage(parsed.agentId, parsed.anchor, parsed.limit, serverId),
    });
  });
  handleTrusted(IPC_CHANNELS.agentSearchConversationMessages, parseAgentRequest, (scoped) => {
    const parsed = parseSearchConversationMessages(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => host.searchAgentConversationMessages(parsed.query, parsed.agentId, parsed.cursor, parsed.limit),
      remote: (serverId) =>
        remoteServers.searchAgentConversationMessages(
          parsed.query,
          parsed.agentId,
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
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.reactions(parsed.agentId), decodeVoid, {
          method: "POST",
          body: parsed,
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentListQueue, parseAgentRequest, (scoped) => {
    return routeListQueue(service, remoteServers, scoped.serverId, requireString(scoped.payload, "agentId"));
  });
  handleTrusted(IPC_CHANNELS.agentAcknowledgeFailedTurn, parseAgentRequest, (scoped) => {
    const parsed = parseAcknowledgeFailedTurn(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.acknowledgeFailedTurn(parsed.agentId, parsed.turnId),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.failuresAcknowledge(parsed.agentId), decodeVoid, {
          method: "POST",
          body: { turnId: parsed.turnId },
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentCancelQueuedMessage, parseAgentRequest, (scoped) => {
    const parsed = parseCancelQueuedMessage(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.cancelQueuedMessage(parsed.agentId, parsed.deliveryId),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.queueCancel(parsed.agentId), decodeVoid, {
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
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.queueSteer(parsed.agentId), decodeVoid, {
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
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.queueUpdate(parsed.agentId), decodeVoid, {
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
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.queueReorder(parsed.agentId), decodeVoid, {
          method: "POST",
          body: { deliveryIds: parsed.deliveryIds },
        }),
    });
  });
  handleTrusted(IPC_CHANNELS.agentInterrupt, parseAgentRequest, (scoped) => {
    const parsed = parseInterrupt(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: () => service.interrupt(parsed.agentId, parsed.turnId),
      remote: (serverId) =>
        remoteServers.request(serverId, TEAM_API_ROUTES.agent.interrupt(parsed.agentId), decodeVoid, {
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

function routeUpdateAgent(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: UpdateAgentInput,
) {
  return routeToServer(serverId, {
    local: () => service.updateAgent(input),
    remote: (target) =>
      remoteServers.request(target, TEAM_API_ROUTES.agent.one(input.agentId), decodeAgentSummary, {
        method: "PATCH",
        body: input,
      }),
  });
}

function routeDeleteAgent(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  remoteServers: RemoteServerManager,
  serverId: string,
  agentId: string,
): Promise<void> {
  return routeToServer<void>(serverId, {
    local: async () => {
      await service.deleteAgent(agentId);
      await sidebarLayout.removeAgent(agentId);
    },
    remote: async (target) => {
      await remoteServers.request(target, TEAM_API_ROUTES.agent.one(agentId), decodeVoid, { method: "DELETE" });
    },
  });
}

function routeDuplicateAgent(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  remoteServers: RemoteServerManager,
  serverId: string,
  agentId: string,
): Promise<DuplicateAgentResult> {
  return routeToServer(serverId, {
    local: () => duplicateAgentLocally(service, sidebarLayout, agentId),
    remote: (target) => remoteServers.duplicateAgent(agentId, target),
  });
}

// The local copy is a two-store transaction: the agent, then its place in the sidebar. If placing it
// fails the half-made copy has to go, or the user is left with an agent they never asked for.
async function duplicateAgentLocally(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  agentId: string,
): Promise<DuplicateAgentResult> {
  const agent = await service.duplicateAgent(agentId);
  try {
    const layout = await sidebarLayout.placeDuplicateAfter(agentId, agent.id, [
      ...service.listAgents().map((candidate) => candidate.id),
      agent.id,
    ]);
    return service.commitAgentDuplication(agent.id, layout);
  } catch (error) {
    const rollbackResults = await Promise.allSettled([
      service.deleteAgent(agent.id),
      sidebarLayout.removeAgent(agent.id),
    ]);
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

function routeReadConversation(
  host: HostService,
  remoteServers: RemoteServerManager,
  serverId: string,
  agentId: string,
) {
  return routeToServer(serverId, {
    local: () => host.readAgentConversation(agentId),
    remote: (target) => remoteServers.readAgentConversation(agentId, target),
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
      remoteServers.request(target, TEAM_API_ROUTES.agent.messages(input.agentId), decodeQueuedMessageReceipt, {
        method: "POST",
        body: input,
      }),
  });
}

function routeListQueue(service: AgentService, remoteServers: RemoteServerManager, serverId: string, agentId: string) {
  return routeToServer(serverId, {
    local: () => service.listQueue(agentId),
    remote: (target) => remoteServers.request(target, TEAM_API_ROUTES.agent.queue(agentId), decodeQueueSnapshot),
  });
}
