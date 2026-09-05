import { z } from "zod";

export type SidebarPeopleOrderByServer = Record<string, string[]>;

export const SIDEBAR_PEOPLE_ORDER_STORAGE_KEY = "openbot:sidebar-people-order:v1";

type SidebarPeopleOrderStorage = Pick<Storage, "getItem" | "setItem">;

const peopleOrderSchema = z.record(
  z.string().trim().min(1),
  z.array(z.string().trim().min(1).nullable().catch(null)).catch([]),
);

export function normalizeSidebarPeopleOrder(value: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawId of value) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function readSidebarPeopleOrder(
  storage: SidebarPeopleOrderStorage = window.localStorage,
): SidebarPeopleOrderByServer {
  try {
    const parsed = peopleOrderSchema.safeParse(JSON.parse(storage.getItem(SIDEBAR_PEOPLE_ORDER_STORAGE_KEY) ?? "{}"));
    if (!parsed.success) return {};
    return Object.fromEntries(
      Object.entries(parsed.data).flatMap(([serverId, values]) => {
        const order = normalizeSidebarPeopleOrder(values.flatMap((value) => (value ? [value] : [])));
        return order.length > 0 ? [[serverId, order]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function writeSidebarPeopleOrder(
  orderByServer: SidebarPeopleOrderByServer,
  storage: SidebarPeopleOrderStorage = window.localStorage,
): void {
  try {
    storage.setItem(SIDEBAR_PEOPLE_ORDER_STORAGE_KEY, JSON.stringify(orderByServer));
  } catch {
    // A private ordering preference must not block sidebar navigation.
  }
}
