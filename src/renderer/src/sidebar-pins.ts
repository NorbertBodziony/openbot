import { legacyAgentId } from "@openbot/contracts/validation";
import { z } from "zod";

export type SidebarPinnedItem = Readonly<{
  kind: "agent" | "person";
  id: string;
}>;

export type SidebarPinsByServer = Record<string, SidebarPinnedItem[]>;

export const SIDEBAR_PINS_STORAGE_KEY = "openbot:sidebar-pins:v1";
export const MAX_SIDEBAR_PINNED_ITEMS = 6;

type SidebarPinStorage = Pick<Storage, "getItem" | "setItem">;

const sidebarPinnedItemSchema = z.object({
  kind: z.enum(["agent", "person"]),
  id: z.string().trim().min(1),
});
const sidebarPinsSchema = z.record(
  z.string().trim().min(1),
  z.array(sidebarPinnedItemSchema.nullable().catch(null)).catch([]),
);

export function sidebarPinnedItemKey(item: SidebarPinnedItem): string {
  return `${item.kind}:${item.id}`;
}

export function normalizeSidebarPinnedItems(value: readonly SidebarPinnedItem[]): SidebarPinnedItem[] {
  const seen = new Set<string>();
  const items: SidebarPinnedItem[] = [];
  for (const candidate of value) {
    if (candidate.kind !== "agent") continue;
    const key = sidebarPinnedItemKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: candidate.kind, id: candidate.id });
    if (items.length === MAX_SIDEBAR_PINNED_ITEMS) break;
  }
  return items;
}

/**
 * Points pins a released build wrote at the agents that own them now. Migration v13 renamed agents inside
 * the host's database, but these pins live in browser storage it never touched, so every pinned agent
 * looks deleted after the upgrade -- it vanishes from the pinned group while still holding one of the six
 * slots. An id still in the roster answers for itself: v13 declines to rename onto an id that is taken, so
 * `bot-<uuid>` can be sitting beside the `agent-<uuid>` it would have become. A pin that matches nobody is
 * left exactly as found, because an agent can be absent for reasons that have nothing to do with the
 * rename.
 */
export function reownSidebarPinnedItems(
  items: readonly SidebarPinnedItem[],
  agentIds: ReadonlySet<string>,
): SidebarPinnedItem[] {
  const renamedFrom = new Map<string, string>();
  for (const agentId of agentIds) {
    const legacyId = legacyAgentId(agentId);
    if (legacyId !== agentId) renamedFrom.set(legacyId, agentId);
  }
  return items.map((item) => {
    if (item.kind !== "agent" || agentIds.has(item.id)) return item;
    const currentId = renamedFrom.get(item.id);
    return currentId === undefined ? item : { kind: item.kind, id: currentId };
  });
}

export function readSidebarPins(storage: SidebarPinStorage = window.localStorage): SidebarPinsByServer {
  try {
    const parsed = sidebarPinsSchema.safeParse(JSON.parse(storage.getItem(SIDEBAR_PINS_STORAGE_KEY) ?? "{}"));
    if (!parsed.success) return {};
    return Object.fromEntries(
      Object.entries(parsed.data).flatMap(([serverId, items]) => {
        const normalized = normalizeSidebarPinnedItems(items.flatMap((item) => (item ? [item] : [])));
        return serverId.trim() && normalized.length > 0 ? [[serverId, normalized]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function writeSidebarPins(
  pinsByServer: SidebarPinsByServer,
  storage: SidebarPinStorage = window.localStorage,
): void {
  try {
    storage.setItem(SIDEBAR_PINS_STORAGE_KEY, JSON.stringify(pinsByServer));
  } catch {
    // A UI preference must not block navigation when browser storage is unavailable.
  }
}
