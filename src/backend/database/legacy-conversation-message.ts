import type { ConversationMessage } from "@openbot/contracts/ipc";
import { isConversationMessage } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

/**
 * A conversation message a released build persisted spells the product agent `bot`.
 *
 * Migration v13 rewrites id *values* and deliberately leaves JSON *keys* alone, because a key rewrite by
 * text substitution would also edit a message in which the user or the model quoted the key -- and this is
 * an application for writing code, so such a message is real. The keys therefore have to be tolerated on
 * read instead, and tolerating them is not cosmetic: `isConversationMessage` requires `exchange` to carry
 * `senderAgentId` and `recipientAgentIds`, and a reaction actor to be `{ kind: "agent" }`. An old message
 * failing that guard does not degrade -- `decodeConversationMessageJson` throws "Invalid conversation
 * message." and the whole page read fails, while replay drops the snapshot and then reports the thread as
 * having no conversation events at all. Every agent-to-agent message and every agent reaction written
 * before the rename is one of these.
 *
 * Only key names and the `kind` discriminant move. Message text is never touched.
 */
const LEGACY_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  botId: "agentId",
  recipientBotId: "recipientAgentId",
  recipientBotIds: "recipientAgentIds",
  senderBotId: "senderAgentId",
};

/** The message as the app spells it now, or `null` when it is not a conversation message in either. */
export function currentConversationMessage(value: unknown): ConversationMessage | null {
  // The common case is a message written after the rename, which needs no walk at all. `senderBotId` is
  // the one released key the guard accepts as it stands -- as an unknown extra -- so it is asked for by
  // name; every other one already fails the guard and takes the branch below.
  if (isDynamicRecord(value) && value.senderBotId === undefined && isConversationMessage(value)) return value;
  const current = toCurrentKeys(value);
  return isConversationMessage(current) ? current : null;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function toCurrentKeys(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(toCurrentKeys);
  if (isDynamicRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const current = LEGACY_MESSAGE_KEYS[key] ?? key;
      // A message holding both spellings is one the current build wrote beside a released leftover; the
      // spelling the app writes today wins.
      if (current !== key && value[current] !== undefined) continue;
      result[current] = key === "kind" && entry === "bot" ? "agent" : toCurrentKeys(entry);
    }
    return result;
  }
  // Anything else came out of `JSON.parse` as a leaf, or is the `undefined` an absent event field reads
  // as. Either way the guard above decides what it means; nothing here has a key to rename.
  return isString(value) || isNumber(value) || isBoolean(value) ? value : null;
}
