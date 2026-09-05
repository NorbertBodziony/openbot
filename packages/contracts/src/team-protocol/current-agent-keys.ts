import { isBoolean, isNumber, isString } from "../runtime-values";
import type { TeamProtocolV1JsonObject, TeamProtocolV1JsonValue } from "./v1";

/**
 * The Team API v1-v3 wire spells the product agent `bot`, and always will: a released protocol never
 * changes meaning. In-app types spell it `agent`. This module is the only place the two vocabularies
 * meet, so every versioned adapter runs its payloads through it instead of leaking a current name
 * onto the wire.
 *
 * Without it the failure is silent, not loud. The frozen codecs project through a key allowlist
 * (`TEAM_PROTOCOL_V1_EVENT_KEYS`), so an unrecognized key is dropped rather than rejected, the
 * encode then fails validation and returns `null`, and callers read `null` as "nothing to send".
 * `tsc` stays green because `v1-adapter.ts` bridges the two type worlds with a bare assertion.
 */

/** Frozen wire spelling -> current in-app spelling. */
const WIRE_TO_CURRENT_KEYS: Readonly<Record<string, string>> = {
  bot: "agent",
  botId: "agentId",
  bots: "agents",
  ownerBotId: "ownerAgentId",
  recipientBotId: "recipientAgentId",
  recipientBotIds: "recipientAgentIds",
  senderBotId: "senderAgentId",
  typingBotId: "typingAgentId",
};

const CURRENT_TO_WIRE_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(WIRE_TO_CURRENT_KEYS).map(([wire, current]) => [current, wire]),
);

/** Values, not keys: the discriminants that spell the product agent. Keyed by the property holding them. */
const WIRE_TO_CURRENT_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  kind: { bot: "agent" },
  origin: { bot: "agent" },
  type: { "bots-changed": "agents-changed" },
};

const CURRENT_TO_WIRE_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.fromEntries(
  Object.entries(WIRE_TO_CURRENT_VALUES).map(([key, mapping]) => [
    key,
    Object.fromEntries(Object.entries(mapping).map(([wire, current]) => [current, wire])),
  ]),
);

/**
 * `marketplaceSource.agentId` is the one wire `agentId` that does not mean the product agent -- it
 * names a marketplace listing, which in-app is `listingId`. Inside this subtree the mapping runs the
 * other way, so a global key map would corrupt it in both directions.
 */
const MARKETPLACE_SOURCE_KEY = "marketplaceSource";
const WIRE_TO_CURRENT_MARKETPLACE_KEYS: Readonly<Record<string, string>> = { agentId: "listingId" };
const CURRENT_TO_WIRE_MARKETPLACE_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(WIRE_TO_CURRENT_MARKETPLACE_KEYS).map(([wire, current]) => [current, wire]),
);

/**
 * Sidebar layout already spells the product agent `agent` on both sides (`agentId`, `beforeAgentId`,
 * `agentAssignments`, `agentOrder`), so translating it would invent a `botId` the frozen codec has
 * never accepted. Its payloads pass through untouched.
 */
const OPAQUE_KEYS: ReadonlySet<string> = new Set(["layout"]);

/**
 * Objects whose keys are data, not vocabulary: `responses` and `answers` are both keyed by question id, and
 * `references` by message id. A question id is any nonempty string the caller chose, so one spelled `agentId`
 * would be renamed to `botId` on the wire while the `id` on the question itself stayed as written -- and
 * the client could no longer tell which answer belonged to which question. The values inside are still
 * translated; only the keys are left as found. `answers` is a map only in the prompt-response *request*; in
 * a resolution it is an array of strings, which never reaches this set.
 */
const DYNAMIC_MAP_KEYS: ReadonlySet<string> = new Set(["responses", "references", "answers"]);

/**
 * Routes whose *body* is a dynamic map. Sidebar layout already spells the product agent `agent` on both
 * sides, and the conversation-reads response is read state keyed by agent id -- neither has a key this
 * translation should touch, and both would be corrupted by one.
 */
function isUntranslatedPath(path: string): boolean {
  const { pathname } = new URL(path, "http://openbot.invalid");
  return pathname.startsWith("/v1/sidebar-layout") || pathname === "/v1/agents/conversation-reads";
}

type Direction = "toWire" | "toCurrent";

function walk(value: TeamProtocolV1JsonValue, direction: Direction, key: string): TeamProtocolV1JsonValue {
  if (value === null || isBoolean(value) || isNumber(value)) return value;
  if (isString(value)) {
    const mapping = (direction === "toWire" ? CURRENT_TO_WIRE_VALUES : WIRE_TO_CURRENT_VALUES)[key];
    return mapping?.[value] ?? value;
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, direction, key));
  return walkObject(value, direction, key);
}

function walkObject(value: TeamProtocolV1JsonObject, direction: Direction, key: string): TeamProtocolV1JsonObject {
  const keys =
    key === MARKETPLACE_SOURCE_KEY
      ? direction === "toWire"
        ? CURRENT_TO_WIRE_MARKETPLACE_KEYS
        : WIRE_TO_CURRENT_MARKETPLACE_KEYS
      : direction === "toWire"
        ? CURRENT_TO_WIRE_KEYS
        : WIRE_TO_CURRENT_KEYS;
  const result: TeamProtocolV1JsonObject = {};
  const dynamic = DYNAMIC_MAP_KEYS.has(key);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const resultKey = dynamic ? entryKey : (keys[entryKey] ?? entryKey);
    result[resultKey] = OPAQUE_KEYS.has(entryKey) ? entryValue : walk(entryValue, direction, entryKey);
  }
  return result;
}

/** Rewrite a current-shaped payload into the frozen wire vocabulary. */
export function toWireAgentKeys(value: TeamProtocolV1JsonValue): TeamProtocolV1JsonValue {
  return walk(value, "toWire", "");
}

/** Rewrite a wire payload into the current in-app vocabulary. */
export function toCurrentAgentKeys(value: TeamProtocolV1JsonValue): TeamProtocolV1JsonValue {
  return walk(value, "toCurrent", "");
}

/** As {@link toWireAgentKeys}, but leaves the routes named in {@link isUntranslatedPath} alone. */
export function toWireAgentKeysForPath(path: string, value: TeamProtocolV1JsonValue): TeamProtocolV1JsonValue {
  return isUntranslatedPath(path) ? value : toWireAgentKeys(value);
}

/** As {@link toCurrentAgentKeys}, but leaves the routes named in {@link isUntranslatedPath} alone. */
export function toCurrentAgentKeysForPath(path: string, value: TeamProtocolV1JsonValue): TeamProtocolV1JsonValue {
  return isUntranslatedPath(path) ? value : toCurrentAgentKeys(value);
}

/** As {@link toCurrentAgentKeysForPath}, for the object-shaped results the HTTP adapters return. */
export function toCurrentAgentKeysObjectForPath(
  path: string,
  value: TeamProtocolV1JsonObject,
): TeamProtocolV1JsonObject {
  return isUntranslatedPath(path) ? value : walkObject(value, "toCurrent", "");
}

/** As {@link toWireAgentKeys}, for the object-shaped payloads the HTTP adapters hand to the codecs. */
export function toWireAgentKeysObjectForPath(path: string, value: TeamProtocolV1JsonObject): TeamProtocolV1JsonObject {
  return isUntranslatedPath(path) ? value : walkObject(value, "toWire", "");
}
