import {
  SIDEBAR_PEOPLE_SECTION_ID,
  SIDEBAR_UNASSIGNED_SECTION_ID,
  type SidebarLayoutSnapshot,
} from "@openbot/contracts/ipc";
import { z } from "zod";

export type SidebarCollapsedByServer = Record<string, string[]>;

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "openbot:sidebar-collapsed:v1";

type SidebarCollapsedStorage = Pick<Storage, "getItem" | "setItem">;

const collapsedSchema = z.record(
  z.string().trim().min(1),
  z.array(z.string().trim().min(1).nullable().catch(null)).catch([]),
);

export function defaultSidebarLayout(): SidebarLayoutSnapshot {
  return {
    revision: 0,
    sections: [],
    order: [SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID],
    agentAssignments: {},
    agentOrder: [],
  };
}

export function readSidebarCollapsed(storage: SidebarCollapsedStorage = window.localStorage): SidebarCollapsedByServer {
  try {
    const parsed = collapsedSchema.safeParse(JSON.parse(storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) ?? "{}"));
    if (!parsed.success) return {};
    return Object.fromEntries(
      Object.entries(parsed.data).flatMap(([serverId, values]) => {
        const sectionIds = [...new Set(values.flatMap((value) => (value ? [value] : [])))];
        return sectionIds.length > 0 ? [[serverId, sectionIds]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function writeSidebarCollapsed(
  collapsedByServer: SidebarCollapsedByServer,
  storage: SidebarCollapsedStorage = window.localStorage,
): void {
  try {
    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsedByServer));
  } catch {
    // A private display preference must not block shared sidebar navigation.
  }
}
