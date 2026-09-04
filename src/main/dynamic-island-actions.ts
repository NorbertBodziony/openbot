import type { DynamicIslandAction } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { routeToServer } from "./ipc/route-to-server";

type CriticalAction = Extract<DynamicIslandAction, { type: "answer-prompt" | "respond-approval" }>;

export interface DynamicIslandActionAgent {
  respondToPrompt(input: { requestId: string | number; answers: Record<string, string[]> }): Promise<void>;
  respondToApproval(input: { requestId: string | number; decision: "accept" | "decline" }): Promise<void>;
}

export interface DynamicIslandRemoteAgent {
  request(
    serverId: string,
    path: string,
    decoder: (value: unknown) => void,
    init: { method: "POST"; body: unknown },
  ): Promise<void>;
}

export async function performDynamicIslandCriticalAction(
  action: CriticalAction,
  local: DynamicIslandActionAgent,
  remote: DynamicIslandRemoteAgent,
  decodeVoid: (value: unknown) => void,
): Promise<void> {
  if (action.type === "answer-prompt") {
    const input = { requestId: action.requestId, answers: action.answers };
    await routeToServer<void>(action.serverId, {
      local: () => local.respondToPrompt(input),
      remote: (serverId) =>
        remote.request(serverId, TEAM_API_ROUTES.respond.prompt, decodeVoid, { method: "POST", body: input }),
    });
    return;
  }
  const input = { requestId: action.requestId, decision: action.decision };
  await routeToServer<void>(action.serverId, {
    local: () => local.respondToApproval(input),
    remote: (serverId) =>
      remote.request(serverId, TEAM_API_ROUTES.respond.approval, decodeVoid, { method: "POST", body: input }),
  });
}
