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
    const key = sidebarPinnedItemKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind: candidate.kind, id: candidate.id });
    if (items.length === MAX_SIDEBAR_PINNED_ITEMS) break;
  }
  return items;
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
