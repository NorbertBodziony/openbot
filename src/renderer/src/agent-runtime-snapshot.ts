import type { AgentApproval, AgentEvent, AgentRuntimeSnapshot } from "@openbot/contracts/ipc";
import { cleanAgentMessageText } from "./agent-message-text";
import { promptRequestKey } from "./conversation-keys";
import type { BotMessage } from "./data";

type PromptEvent = Extract<AgentEvent, { type: "prompt" }>;
type BrowserTakeoverEvent = Extract<AgentEvent, { type: "browser-takeover-requested" }>;

export type PendingAttentionPrompts = Record<string, PromptEvent | BrowserTakeoverEvent | undefined>;

/**
 * Folding a runtime snapshot into what the renderer already holds.
 *
 * A snapshot is main's whole answer to "what are the agents doing", and it
 * arrives both on reconnect and as a compact update that main may have had to
 * truncate. `attentionComplete` is the flag that separates the two: when it is
 * true the snapshot lists every prompt and approval there is, so anything the
 * renderer still shows and the snapshot omits is gone; when it is false the
 * snapshot is a partial view and dropping what it omits would clear a prompt
 * the user is looking at.
 *
 * Kept apart from `agent-event-bridge.tsx` because that file is routing - one
 * event, several domains - while this is the arithmetic underneath it, and the
 * arithmetic is where the reconnect edge cases live.
 */
export function reconcileAttentionPrompts(
  current: PendingAttentionPrompts,
  snapshot: Pick<AgentRuntimeSnapshot, "attentionComplete" | "pendingPrompts" | "pendingBrowserTakeovers">,
  submittedRequests: Record<string, string | undefined>,
): PendingAttentionPrompts {
  const next: PendingAttentionPrompts = snapshot.attentionComplete ? {} : { ...current };
  for (const prompt of snapshot.pendingPrompts) {
    // A prompt whose answer is already on its way to main would otherwise come
    // back the moment a snapshot crosses the answer in flight.
    if (promptRequestKey(prompt.turnId, prompt.requestId) !== submittedRequests[prompt.botId]) {
      next[prompt.botId] = { type: "prompt", ...prompt };
    }
  }
  for (const request of snapshot.pendingBrowserTakeovers) {
    next[request.botId] = { type: "browser-takeover-requested", request };
  }
  return next;
}

export function reconcileAttentionApprovals(
  current: Record<string, AgentApproval | undefined>,
  snapshot: Pick<AgentRuntimeSnapshot, "attentionComplete" | "pendingApprovals">,
): Record<string, AgentApproval | undefined> {
  return {
    ...(snapshot.attentionComplete ? {} : current),
    ...Object.fromEntries(snapshot.pendingApprovals.map((approval) => [approval.botId, approval])),
  };
}

/**
 * The tail of each agent's transcript, as the snapshot last saw it. A message
 * the renderer already has stays as it is: it may be further along than the
 * snapshot's copy, which is capped at `AGENT_RUNTIME_TEXT_LIMIT`.
 */
export function appendLatestRuntimeMessages(
  current: Record<string, BotMessage[]>,
  latestMessages: AgentRuntimeSnapshot["latestMessages"],
): Record<string, BotMessage[]> {
  const next = { ...current };
  for (const message of latestMessages) {
    const messages = next[message.botId] ?? [];
    if (messages.some((candidate) => candidate.id === message.id)) continue;
    next[message.botId] = [
      ...messages,
      {
        id: message.id,
        author: "bot",
        body: cleanAgentMessageText(message.text),
        time: message.createdAt,
        createdAt: message.createdAt,
      },
    ];
  }
  return next;
}
