import type { BrowserTab } from "@openbot/contracts/ipc";

/**
 * Which browser tab is in front, after the tab list changes underneath it.
 *
 * The rest of the built-in browser is timing - loads racing events racing a
 * server switch, all of it in `browser-tabs.tsx` where the revision counter
 * can see it. This is the part that is not: given a list of tabs and what was
 * in front, which tab is in front now.
 */

/**
 * The tab a freshly loaded workspace shows. Main names one, and falls back to
 * the first tab so a workspace with tabs never comes back with none in front.
 */
export function activeTabAfterLoad(state: { tabs: readonly BrowserTab[]; activeTabId: string | null }): string | null {
  return state.activeTabId ?? state.tabs[0]?.id ?? null;
}

/**
 * The tab list and front tab after one tab is closed.
 *
 * Closing a tab that was not in front changes nothing about what the user is
 * looking at. Closing the one in front moves to the tab that slid into its
 * place, which is the next tab along, and to the previous tab when the closed
 * one was last - the same place the eye already is, rather than jumping to the
 * far end of the strip.
 */
export function browserTabsAfterClose(
  tabs: readonly BrowserTab[],
  closedTabId: string,
  activeTabId: string | null,
): { tabs: BrowserTab[]; activeTabId: string | null } {
  const closedIndex = tabs.findIndex((tab) => tab.id === closedTabId);
  const remaining = tabs.filter((tab) => tab.id !== closedTabId);
  if (activeTabId !== closedTabId) return { tabs: remaining, activeTabId };
  return { tabs: remaining, activeTabId: remaining[closedIndex]?.id ?? remaining[closedIndex - 1]?.id ?? null };
}
