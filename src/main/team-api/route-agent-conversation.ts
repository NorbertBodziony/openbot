// Reading and writing one agent's conversation, as one member sees it.
//
// Everything here is filtered by what the client said it understands. A marker type a released
// client has never heard of is dropped from the messages it is sent, and the read cursor is walked
// back to the newest message that survived the filter - otherwise the client would store a cursor
// pointing at something it cannot render and never catch up.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isMessageReaction } from "@openbot/contracts/ipc";
import { TEAM_PROTOCOL_V3 } from "@openbot/contracts/team-protocol/v3";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import type { AgentRouteTarget, RouteOutcome, TeamApiRequestContext } from "./request-context";
import {
  conversationForCapabilities,
  markerExclusionsForCapabilities,
  nullableString,
  pageAnchor,
  pageLimit,
  readJson,
  stringArray,
  stringField,
} from "./request-helpers";

export interface AgentConversationRouteDependencies {
  agents: Pick<
    TeamApiAgents,
    | "readConversationFor"
    | "readConversationPageFor"
    | "markConversationRead"
    | "markConversationUnread"
    | "sendMessage"
    | "setMessageReaction"
  >;
}

export async function routeAgentConversation(
  context: TeamApiRequestContext,
  { botId, action }: AgentRouteTarget,
  { agents }: AgentConversationRouteDependencies,
): Promise<RouteOutcome> {
  const { method, url, request, member, protocol, capabilities, json, empty } = context;

  if (method === "GET" && action === "conversation") {
    const conversation = await agents.readConversationFor(botId, member.id);
    return json(200, conversationForCapabilities(conversation, capabilities));
  }
  if (method === "GET" && action === "conversation-page") {
    const page = await agents.readConversationPageFor(
      botId,
      member.id,
      pageAnchor(url),
      pageLimit(url),
      markerExclusionsForCapabilities(capabilities),
    );
    return json(200, page);
  }
  if (method === "POST" && action === "conversation/unread") {
    // `context.protocol` is the same `requestProtocol(request)` this branch used to recompute for
    // itself. It has to be: the negotiated protocol also picks the adapter `json` encodes with, so a
    // route deciding on a different number than the encoder would answer in a shape it just refused.
    if (protocol !== TEAM_PROTOCOL_V3 || !capabilities.has("conversation-unread")) {
      throw new HttpError(400, "This client does not support marking conversations unread.");
    }
    await readJson(request);
    return json(200, await agents.markConversationUnread(botId, member.id));
  }
  if (method === "POST" && action === "conversation/read") {
    const body = await readJson(request);
    return json(
      200,
      await agents.markConversationRead(
        botId,
        member.id,
        nullableString(body, "throughMessageId"),
        markerExclusionsForCapabilities(capabilities),
      ),
    );
  }
  if (method === "POST" && action === "messages") {
    const body = await readJson(request);
    return json(
      202,
      await agents.sendMessage({
        botId,
        text: stringField(body, "text", true, INPUT_LIMITS.messageText),
        attachmentDraftIds: stringArray(body, "attachmentDraftIds"),
        replyToMessageId: nullableString(body, "replyToMessageId"),
      }),
    );
  }

  if (method === "POST" && action === "reactions") {
    const body = await readJson(request);
    const emoji = body.emoji;
    if (emoji !== null && !isMessageReaction(emoji)) throw new HttpError(400, "Invalid emoji.");
    await agents.setMessageReaction({
      botId,
      messageId: stringField(body, "messageId"),
      emoji,
    });
    return empty(204);
  }
  return "unmatched";
}
