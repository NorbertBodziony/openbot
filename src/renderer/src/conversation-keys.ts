/**
 * Composite keys for the renderer's per-conversation caches. A NUL separator
 * cannot appear in a server id, agent id or message id, so the parts stay
 * unambiguous without escaping.
 */

/** Identifies one agent conversation, which is an agent *on a server*. */
export function agentConversationKey(serverId: string, agentId: string): string {
  return `${serverId}\0${agentId}`;
}

/** Identifies one message within an agent's conversation. */
export function agentMessageKey(agentId: string, messageId: string): string {
  return `${agentId}\0${messageId}`;
}

/** Identifies one composer draft, which is an agent *on a server*. */
export function composerDraftKey(target: { agentId: string; serverId: string }): string {
  return target.serverId === "local" ? target.agentId : `${target.serverId}:${target.agentId}`;
}

/** Drops every cached body belonging to one agent. */
export function deleteAgentMessageBodies(messages: Map<string, string>, agentId: string): void {
  const prefix = `${agentId}\0`;
  for (const key of messages.keys()) {
    if (key.startsWith(prefix)) messages.delete(key);
  }
}

/**
 * Identifies one outstanding question. A request id is only unique within its
 * turn, so both parts are needed; either one missing means there is nothing to
 * answer yet.
 */
export function promptRequestKey(turnId: string | undefined, requestId: string | number | undefined): string | null {
  if (!turnId || requestId === undefined) return null;
  return JSON.stringify([turnId, String(requestId)]);
}

export function messagePromptRequestKey(message: {
  turnId?: string;
  questionPrompt?: { requestId: string | number };
}): string | null {
  return promptRequestKey(message.turnId, message.questionPrompt?.requestId);
}
