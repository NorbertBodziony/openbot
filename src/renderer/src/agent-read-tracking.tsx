import type { AgentAutoReadEntry } from "./features/conversation/conversation-read-state";
import { createSimpleContext } from "./simple-context";

/**
 * What the renderer remembers about reads it has asked for but not settled.
 *
 * All three are keyed by `agentConversationKey(serverId, agentId)`, and all three
 * are consulted by a promise that can outlive the workspace that started it: a
 * `markConversationRead` issued on one server may still be in flight when the
 * user moves to another. That is why they sit above the per-server scope rather
 * than inside it - a rejection that lands after the switch has to leave its retry
 * marker where the scope that comes back will find it, or the failed read is
 * silently forgotten and the message stays unread forever.
 *
 * `agentChatsRetriedOnOpen` is deliberately *not* here. It is keyed by agent id
 * alone, it means "this open already retried once", and an open belongs to the
 * workspace the user is looking at, so it stays with the conversation scope and
 * dies with it.
 */
const AgentReadTracking = createSimpleContext({
  name: "Agent read tracking",
  init: () => ({
    /** Chats whose next applied page should mark the latest message read. */
    agentChatsToMarkRead: new Set<string>(),
    /** Chats whose read failed, so the next page has to apply it again. */
    agentChatsToRetryRead: new Set<string>(),
    /** The optimistic read in flight for a chat, owned by whoever wrote it. */
    autoReadAgentMessages: new Map<string, AgentAutoReadEntry>(),
  }),
});

export const AgentReadTrackingProvider = AgentReadTracking.provider;
export const useAgentReadTracking = AgentReadTracking.use;
