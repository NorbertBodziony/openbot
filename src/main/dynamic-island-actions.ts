import type { DynamicIslandAction } from "@openbot/contracts/ipc";

type CriticalAction = Extract<DynamicIslandAction, { type: "answer-prompt" }>;

export interface DynamicIslandActionAgent {
  respondToPrompt(input: { requestId: string | number; answers: Record<string, string[]> }): Promise<void>;
}

export interface DynamicIslandRemoteAgent {
  request(
    path: string,
    init: { method: "POST"; body: unknown },
    serverId: string,
    decoder: (value: unknown) => void,
  ): Promise<void>;
}

export async function performDynamicIslandCriticalAction(
  action: CriticalAction,
  local: DynamicIslandActionAgent,
  remote: DynamicIslandRemoteAgent,
  decodeVoid: (value: unknown) => void,
): Promise<void> {
  const input = { requestId: action.requestId, answers: action.answers };
  if (action.serverId === "local") await local.respondToPrompt(input);
  else await remote.request("/v1/prompts/respond", { method: "POST", body: input }, action.serverId, decodeVoid);
}
