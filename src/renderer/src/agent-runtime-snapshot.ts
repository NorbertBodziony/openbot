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

/**
 * The prompts a server scope starts with, out of what the coordinator remembers
 * that server was blocked on.
 *
 * The coordinator's memory is the renderer's own projection played back, so it
 * still lists a prompt the user answered while main was working out that the
 * answer had arrived. Seeding it unfiltered remounts `QuestionPromptBubble` on
 * its first page - the bubble hides the questions in local state that the
 * remount throws away - and the user is asked again. The two markers outlive the
 * scope for exactly this window; `reconcileAttentionPrompts` consults the
 * submitted one against main's snapshots, and this consults both against the
 * coordinator's, which is the only other way a prompt enters the scope.
 *
 * Only prompts are filtered. A browser takeover leaves `pendingPrompts` the
 * moment main accepts the response, so the projection above this has already
 * dropped it.
 */
export function seededAttentionPrompts(
  seed: PendingAttentionPrompts | undefined,
  presentedResolutions: Record<string, string | undefined>,
  submittedRequests: Record<string, string | undefined>,
): PendingAttentionPrompts {
  if (!seed) return {};
  const next: PendingAttentionPrompts = {};
  for (const [botId, entry] of Object.entries(seed)) {
    if (!entry) continue;
    if (entry.type === "prompt") {
      const key = promptRequestKey(entry.turnId, entry.requestId);
      if (key === presentedResolutions[botId] || key === submittedRequests[botId]) continue;
    }
    next[botId] = entry;
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
