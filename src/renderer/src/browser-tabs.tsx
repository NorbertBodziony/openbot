import type { BrowserControlState, BrowserTab, ServerSummary } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import { desktopAnalytics } from "./analytics";
import { usePlatform } from "./platform";
import { createScopeGuard } from "./scope-lifetime";
import { serverSupportsCapability } from "./server-capabilities";
import { useServerSwitch } from "./server-switch";
import { useServers } from "./servers";
import { createSimpleContext } from "./simple-context";

/** What `browser.getDisplayState()` answers, and what a remote list is folded into. */
interface BrowserDisplayState {
  tabs: BrowserTab[];
  activeTabId: string | null;
}

/**
 * The built-in browser's tabs and the control sessions attached to them.
 *
 * Every write to the tab list is racing something: a `browser-changed` event
 * from main, a close the user started, and the load that runs when a server is
 * selected all produce a list, and the newest one wins regardless of which
 * finished last. `browserChangeRevision` is that ordering. It is bumped by the
 * two writes that come from an *observed* change - the event, and a completed
 * close - and read by `beginBrowserLoad`, so a load started before either one
 * lands is discarded instead of repainting a stale list.
 *
 * `browserVisibilitySuspended` is read here but owned by `server-switch.tsx`:
 * it describes the gap between two server scopes, so it has to outlive both this
 * provider and the switch that replaces it.
 *
 * `loadDisplayState`/`loadControlState` build the reads rather than performing
 * them so their caller can put them in the same `Promise.all` as the rest of a
 * server load; both answer the empty state for a preview mount or a server
 * without `browser-control`, which is what makes the switch clear the tabs of
 * the server being left.
 *
 * Ungated - see `app-providers.tsx`.
 */
const BrowserTabs = createSimpleContext({
  name: "Browser tabs",
  init: () => {
    const { landingPreview } = usePlatform();
    const { currentServerSelection } = useServers();
    const { browserVisibilitySuspended } = useServerSwitch();
    const scopeIsCurrent = createScopeGuard();

    const [browserTabs, setBrowserTabs] = createSignal<BrowserTab[]>([]);
    const [activeBrowserTabId, setActiveBrowserTabId] = createSignal<string | null>(null);
    const [browserControlState, setBrowserControlState] = createSignal<BrowserControlState>({ sessions: [] });
    const browserTabActivationOperations = new Map<string, Promise<void>>();
    let browserChangeRevision = 0;

    function supportsBrowser(server: ServerSummary | undefined): boolean {
      return !landingPreview && serverSupportsCapability(server, "browser-control");
    }

    function loadDisplayState(server: ServerSummary | undefined): Promise<BrowserDisplayState> {
      if (!supportsBrowser(server)) return Promise.resolve({ tabs: [], activeTabId: null });
      return server?.kind === "remote"
        ? window.openbot.browser.listTabs().then((tabs) => ({ tabs, activeTabId: tabs[0]?.id ?? null }))
        : window.openbot.browser.getDisplayState();
    }

    function loadControlState(server: ServerSummary | undefined): Promise<BrowserControlState> {
      if (!supportsBrowser(server)) return Promise.resolve({ sessions: [] });
      return window.openbot.browser.getControlState();
    }

    /**
     * Claims the current revision and hands back the applier for it. Calling it
     * before the read starts is the point: anything that changes the tabs while
     * the read is in flight makes the applier a no-op.
     */
    function beginBrowserLoad(): (state: BrowserDisplayState) => void {
      const requestedAtRevision = browserChangeRevision;
      return (state) => {
        if (browserChangeRevision !== requestedAtRevision) return;
        setBrowserTabs(state.tabs);
        setActiveBrowserTabId(state.activeTabId ?? state.tabs[0]?.id ?? null);
      };
    }

    /** A `browser-changed` event: main is authoritative, so it outranks any load in flight. */
    function applyBrowserChange(tabs: BrowserTab[], activeTabId: string | null): void {
      browserChangeRevision += 1;
      setBrowserTabs(tabs);
      setActiveBrowserTabId(activeTabId);
    }

    function activateBrowserTab(tabId: string) {
      const analytics = desktopAnalytics.scope();
      const operation = window.openbot.browser.activate(tabId);
      browserTabActivationOperations.set(tabId, operation);
      void operation
        .then(() => analytics.track("browser_action", { action: "activate", result: "succeeded" }))
        .catch(() =>
          analytics.track("browser_action", {
            action: "activate",
            result: "failed",
            failure_code: "browser_activate_failed",
          }),
        )
        .finally(() => {
          if (browserTabActivationOperations.get(tabId) === operation) {
            browserTabActivationOperations.delete(tabId);
          }
        });
    }

    async function closeBrowserTab(tabId: string) {
      const analytics = desktopAnalytics.scope();
      const selectionIsCurrent = currentServerSelection();
      try {
        await browserTabActivationOperations.get(tabId)?.catch(() => undefined);
        if (browserVisibilitySuspended() || !selectionIsCurrent() || !scopeIsCurrent()) {
          return;
        }
        await window.openbot.browser.close(tabId);
        if (scopeIsCurrent()) {
          browserChangeRevision += 1;
          const currentTabs = browserTabs();
          const closedIndex = currentTabs.findIndex((tab) => tab.id === tabId);
          const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);
          setBrowserTabs(nextTabs);
          setActiveBrowserTabId((current) =>
            current === tabId ? (nextTabs[closedIndex]?.id ?? nextTabs[closedIndex - 1]?.id ?? null) : current,
          );
        }
        analytics.track("browser_action", { action: "close", result: "succeeded" });
      } catch (error) {
        analytics.track("browser_action", {
          action: "close",
          result: "failed",
          failure_code: "browser_close_failed",
        });
        throw error;
      }
    }

    return {
      browserTabs,
      activeBrowserTabId,
      browserVisibilitySuspended,
      browserControlState,
      setBrowserControlState,
      supportsBrowser,
      loadDisplayState,
      loadControlState,
      beginBrowserLoad,
      applyBrowserChange,
      activateBrowserTab,
      closeBrowserTab,
    };
  },
});

export const BrowserTabsProvider = BrowserTabs.provider;
export const useBrowserTabs = BrowserTabs.use;
