import type { ServerSummary, SidebarLayoutAction, SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { createMemo, createSignal } from "solid-js";
import { serverSupportsCapability } from "./server-capabilities";
import { useServers } from "./servers";
import {
  normalizeSidebarPeopleOrder,
  readSidebarPeopleOrder,
  type SidebarPeopleOrderByServer,
  writeSidebarPeopleOrder,
} from "./sidebar-people-order";
import {
  MAX_SIDEBAR_PINNED_ITEMS,
  normalizeSidebarPinnedItems,
  readSidebarPins,
  reownSidebarPinnedItems,
  type SidebarPinnedItem,
  type SidebarPinsByServer,
  sidebarPinnedItemKey,
  writeSidebarPins,
} from "./sidebar-pins";
import {
  defaultSidebarLayout,
  readSidebarCollapsed,
  type SidebarCollapsedByServer,
  writeSidebarCollapsed,
} from "./sidebar-sections";
import { createSimpleContext } from "./simple-context";

/**
 * The shape of the agent list: the host's own section layout, plus the three
 * things the user arranges here and this computer remembers - pinned items,
 * people order and collapsed sections.
 *
 * Those three are stored per server and read under `activeServerId()`, so they
 * are *not* torn down on a switch: `localStorage` holds every server's
 * arrangement at once and switching back has to restore it. The layout is the
 * opposite - it belongs to the host, is refetched on every mount of the keyed
 * server scope, and so is the only piece of this module a switch discards.
 *
 * `removePinnedItemEverywhere` is the one write that ignores the active server.
 * A deleted agent has to lose its pin on every server that pinned it, because
 * nothing will ever re-render that entry into a valid state again.
 *
 * Ungated - see `app-providers.tsx`.
 */
const Sidebar = createSimpleContext({
  name: "Sidebar",
  init: () => {
    const { activeServerId, activeServerSupportsCapability } = useServers();

    const [sidebarLayout, setSidebarLayout] = createSignal<SidebarLayoutSnapshot>(defaultSidebarLayout());
    const [sidebarPinsByServer, setSidebarPinsByServer] = createSignal<SidebarPinsByServer>(readSidebarPins());
    const [sidebarPeopleOrderByServer, setSidebarPeopleOrderByServer] = createSignal<SidebarPeopleOrderByServer>(
      readSidebarPeopleOrder(),
    );
    const [sidebarCollapsedByServer, setSidebarCollapsedByServer] = createSignal<SidebarCollapsedByServer>(
      readSidebarCollapsed(),
    );

    const pinnedSidebarItems = createMemo(() => sidebarPinsByServer()[activeServerId()] ?? []);
    const sidebarPeopleOrder = createMemo(() => sidebarPeopleOrderByServer()[activeServerId()] ?? []);
    const collapsedSidebarSectionIds = createMemo(() => sidebarCollapsedByServer()[activeServerId()] ?? []);

    /** The layout read for a server load, answering the default where the host has no layout to give. */
    function loadLayout(server: ServerSummary | undefined): Promise<SidebarLayoutSnapshot> {
      return serverSupportsCapability(server, "sidebar-layout")
        ? window.openbot.agent.getSidebarLayout()
        : Promise.resolve(defaultSidebarLayout());
    }

    async function mutateSidebarLayout(action: SidebarLayoutAction): Promise<void> {
      if (!activeServerSupportsCapability("sidebar-layout")) {
        throw new Error("This host does not support sidebar layout changes.");
      }
      const layout = await window.openbot.agent.mutateSidebarLayout(action);
      setSidebarLayout(layout);
    }

    function toggleSidebarSection(sectionId: string): void {
      const serverId = activeServerId();
      setSidebarCollapsedByServer((current) => {
        const values = new Set(current[serverId] ?? []);
        if (values.has(sectionId)) values.delete(sectionId);
        else values.add(sectionId);
        const next = { ...current };
        if (values.size > 0) next[serverId] = [...values];
        else delete next[serverId];
        writeSidebarCollapsed(next);
        return next;
      });
    }

    function updateActiveServerPins(update: (items: SidebarPinnedItem[]) => SidebarPinnedItem[]): void {
      const serverId = activeServerId();
      setSidebarPinsByServer((current) => {
        const items = normalizeSidebarPinnedItems(update(current[serverId] ?? []));
        const next = { ...current };
        if (items.length > 0) next[serverId] = items;
        else delete next[serverId];
        writeSidebarPins(next);
        return next;
      });
    }

    /**
     * Brings this server's pins up to date with the roster it just sent. Nothing else rewrites them: the
     * pins are in browser storage, and the id migration ran inside the host's database.
     */
    function reconcileActiveServerPins(agentIds: readonly string[]): void {
      const roster = new Set(agentIds);
      const serverId = activeServerId();
      setSidebarPinsByServer((current) => {
        const items = current[serverId];
        if (!items) return current;
        const reowned = reownSidebarPinnedItems(items, roster);
        if (reowned.every((item, index) => item.id === items[index]?.id)) return current;
        const next = { ...current, [serverId]: reowned };
        writeSidebarPins(next);
        return next;
      });
    }

    function pinSidebarItem(item: SidebarPinnedItem): void {
      updateActiveServerPins((items) =>
        items.length >= MAX_SIDEBAR_PINNED_ITEMS ||
        items.some((candidate) => sidebarPinnedItemKey(candidate) === sidebarPinnedItemKey(item))
          ? items
          : [...items, item],
      );
    }

    function unpinSidebarItem(item: SidebarPinnedItem): void {
      const key = sidebarPinnedItemKey(item);
      updateActiveServerPins((items) => items.filter((candidate) => sidebarPinnedItemKey(candidate) !== key));
    }

    function reorderPinnedSidebarItems(items: SidebarPinnedItem[]): void {
      updateActiveServerPins(() => items);
    }

    function reorderSidebarPeople(memberIds: string[]): void {
      const serverId = activeServerId();
      setSidebarPeopleOrderByServer((current) => {
        const order = normalizeSidebarPeopleOrder(memberIds);
        const next = { ...current };
        if (order.length > 0) next[serverId] = order;
        else delete next[serverId];
        writeSidebarPeopleOrder(next);
        return next;
      });
    }

    function removePinnedSidebarItemEverywhere(item: SidebarPinnedItem): void {
      const key = sidebarPinnedItemKey(item);
      setSidebarPinsByServer((current) => {
        const next = Object.fromEntries(
          Object.entries(current).flatMap(([serverId, items]) => {
            const filtered = items.filter((candidate) => sidebarPinnedItemKey(candidate) !== key);
            return filtered.length > 0 ? [[serverId, filtered]] : [];
          }),
        );
        writeSidebarPins(next);
        return next;
      });
    }

    return {
      sidebarLayout,
      setSidebarLayout,
      loadLayout,
      mutateSidebarLayout,
      collapsedSidebarSectionIds,
      toggleSidebarSection,
      pinnedSidebarItems,
      reconcileActiveServerPins,
      pinSidebarItem,
      unpinSidebarItem,
      reorderPinnedSidebarItems,
      removePinnedSidebarItemEverywhere,
      sidebarPeopleOrder,
      reorderSidebarPeople,
    };
  },
});

export const SidebarProvider = Sidebar.provider;
export const useSidebar = Sidebar.use;
