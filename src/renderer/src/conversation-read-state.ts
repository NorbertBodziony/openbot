import type {
  ConversationMessageAuthor,
  ConversationReadState,
  DirectConversationSnapshot,
  DirectMessage,
} from "@openbot/contracts/ipc";
import {
  HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX,
  ROUTINE_EVENT_ITEM_TYPE_PREFIX,
  ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX,
} from "@openbot/contracts/ipc";
import type { BotMessage } from "./data";

/**
 * What the renderer has already asked main to mark read, per conversation. A
 * pending entry carries the state it optimistically painted so a repeat for the
 * same message repaints it instead of asking again; a succeeded entry carries
 * what main actually returned.
 */
export type AgentAutoReadEntry =
  | { messageId: string; status: "pending"; optimisticState: ConversationReadState | null }
  | { messageId: string; status: "succeeded"; state: ConversationReadState };

/**
 * Routine, routine-run and hosted-site markers are bookkeeping the agent writes
 * about itself, so they never make a conversation unread.
 */
export function isRoutineEventItem(message: { itemType?: string }): boolean {
  return (
    message.itemType?.startsWith(ROUTINE_EVENT_ITEM_TYPE_PREFIX) === true ||
    message.itemType?.startsWith(ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX) === true ||
    message.itemType?.startsWith(HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX) === true
  );
}

/**
 * Whether a message is something the user has yet to see: it did not come from
 * them, and it is not one of the rows an agent writes about its own work.
 *
 * The two shapes this applies to disagree on how the user is spelled - the IPC
 * message authors them `"user"`, the renderer projection `"you"` - so each gets
 * its own entry point over this one rule rather than a predicate typed loosely
 * enough to accept both and silently take either spelling.
 */
function isIncoming(message: { itemType?: string }, fromUser: boolean): boolean {
  return (
    !fromUser &&
    message.itemType !== "commentary" &&
    message.itemType !== "agent_attachment" &&
    !isRoutineEventItem(message)
  );
}

/** The rule for a message as main sends it. */
function isIncomingConversationMessage(message: { author: ConversationMessageAuthor; itemType?: string }): boolean {
  return isIncoming(message, message.author === "user");
}

/**
 * The rule for a message as the renderer holds it, which also excludes the two
 * kinds of row the renderer synthesizes itself: streamed thinking and UI notices.
 * Neither exists in main, so neither can be read.
 */
function isIncomingAgentMessage(message: BotMessage): boolean {
  return (
    isIncoming(message, message.author === "you") &&
    !message.id.startsWith("thinking:") &&
    !message.id.startsWith("ui-")
  );
}

/** The newest message that could move the read boundary, or `undefined`. */
export function latestIncomingConversationMessage<
  Message extends { author: ConversationMessageAuthor; itemType?: string },
>(messages: readonly Message[]): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isIncomingConversationMessage(message)) return message;
  }
  return undefined;
}

/** The same boundary over what the renderer is showing. */
export function latestVisibleAgentMessageId(messages: readonly BotMessage[] | undefined): string | null {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isIncomingAgentMessage(message)) return message.id;
  }
  return null;
}

/** Recounts a read state against the messages it applies to. */
export function readStateForMessages(
  state: ConversationReadState,
  messages: readonly { author: ConversationMessageAuthor; id: string; itemType?: string }[],
): ConversationReadState {
  const throughIndex = state.throughMessageId
    ? messages.findIndex((message) => message.id === state.throughMessageId)
    : -1;
  const unread = messages.slice(throughIndex + 1).filter(isIncomingConversationMessage);
  return {
    ...state,
    unreadCount: unread.length,
    firstUnreadMessageId: unread[0]?.id ?? null,
  };
}

/**
 * Raises a stored read state to match messages the renderer can already see.
 * Main counts unread from what it has persisted; the renderer may hold newer
 * messages, and a count that is already at least as high is left alone so a
 * refresh never walks the badge backwards.
 */
export function preserveKnownAgentUnread(
  state: ConversationReadState,
  boundary: string | null,
  messages: BotMessage[],
): ConversationReadState {
  const throughMessageId = state.throughMessageId ?? boundary;
  const throughIndex = throughMessageId ? messages.findIndex((message) => message.id === throughMessageId) : -1;
  if (throughMessageId && throughIndex < 0) return state;
  const unread = messages.slice(throughIndex + 1).filter(isIncomingAgentMessage);
  if (unread.length <= state.unreadCount) return state;
  return {
    ...state,
    unreadCount: unread.length,
    firstUnreadMessageId: unread[0]?.id ?? null,
  };
}

/** The same guard for a direct thread, where the boundary is a sequence number. */
export function preserveKnownDirectUnread(
  state: NonNullable<DirectConversationSnapshot["readState"]>,
  boundary: number,
  messages: DirectMessage[],
  currentMemberId: string | undefined,
): NonNullable<DirectConversationSnapshot["readState"]> {
  const throughSequence = Math.max(state.throughSequence, boundary);
  const unread = messages.filter(
    (message) => message.senderMemberId !== currentMemberId && message.sequence > throughSequence,
  );
  if (unread.length <= state.unreadCount) return state;
  return {
    ...state,
    unreadCount: unread.length,
    firstUnreadMessageId: unread[0]?.id ?? null,
  };
}

/**
 * The read state an in-flight or finished mark-read still stands behind: what
 * main returned if it answered, otherwise what the renderer painted ahead of it.
 */
export function retainedAutoReadState(entry: AgentAutoReadEntry | undefined): ConversationReadState | null {
  if (!entry) return null;
  return entry.status === "succeeded" ? entry.state : entry.optimisticState;
}

/**
 * The newest revision applied for a conversation, or -1 when none is. Snapshots
 * and pages may re-apply their own revision, so they compare with `<`; a delta
 * has to advance it, so it compares with `<=`.
 */
export function appliedConversationRevision(revisions: Record<string, number>, botId: string): number {
  return revisions[botId] ?? -1;
}

/** What to do about a message the renderer would like to mark read. */
export type AgentAutoReadDecision =
  /** Already asked for this message: repaint what that ask stands behind. */
  | { readonly kind: "retained"; readonly state: ConversationReadState | null }
  /** Unread the user has not acknowledged: leave the badge alone. */
  | { readonly kind: "deferred" }
  /** Ask main, painting `optimisticState` now and restoring `rollbackState` if it fails. */
  | {
      readonly kind: "mark";
      readonly optimisticState: ConversationReadState | null;
      readonly rollbackState: ConversationReadState | null;
    };

/**
 * Whether opening a conversation clears its badge.
 *
 * Unread the user never acknowledged survives: arriving at a conversation that
 * already had unread messages does not silently read them. Three things
 * override that - the caller clearing optimistically (a page that arrived while
 * the conversation was open and focused), the user having opened this
 * conversation themselves, and a retry of a mark-read that failed earlier.
 *
 * `rollbackState` is non-null exactly when `optimisticState` is, because there
 * is nothing to restore unless something was painted; when the conversation had
 * unread that the caller cleared anyway, restoring means putting back the count
 * that was there, and otherwise it means putting back a single unread message.
 */
export function decideAgentAutoRead(input: {
  readonly messageId: string;
  readonly current: ConversationReadState | undefined;
  readonly tracked: AgentAutoReadEntry | undefined;
  readonly optimisticallyClearUnread: boolean;
  readonly explicitlyOpened: boolean;
  readonly retryingRead: boolean;
}): AgentAutoReadDecision {
  if (input.tracked?.messageId === input.messageId) {
    return { kind: "retained", state: retainedAutoReadState(input.tracked) };
  }
  const current = input.current;
  const hasUnread = Boolean(current && current.unreadCount > 0);
  if (!input.optimisticallyClearUnread && !input.explicitlyOpened && !input.retryingRead && hasUnread) {
    return { kind: "deferred" };
  }
  if (!current || (hasUnread && !input.optimisticallyClearUnread)) {
    return { kind: "mark", optimisticState: null, rollbackState: null };
  }
  return {
    kind: "mark",
    optimisticState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: input.messageId },
    rollbackState: hasUnread ? current : { ...current, unreadCount: 1, firstUnreadMessageId: input.messageId },
  };
}
