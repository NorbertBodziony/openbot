import type { BrowserPreview, BrowserTab } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { desktopAnalytics } from "../../../analytics";
import type { ConversationProps } from "../../ConversationView";

export interface BrowserTakeoverPreviewState {
  status: "idle" | "loading" | "ready" | "failed";
  preview: BrowserPreview | null;
}

export interface BrowserTakeoverResolutionState {
  decision: "complete" | "cancel";
  tab: BrowserTab | undefined;
  preview: BrowserPreview | null;
  previewStatus: BrowserTakeoverPreviewState["status"];
  messageMarker: string | null;
}

export function canonicalBrowserUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

export interface BrowserPanels {
  setActiveRightPanel: (mode: "none" | "browser" | "browser-pip" | "settings" | "file-preview") => void;
  hideBrowserPanel: () => void;
  screenOpen: () => boolean;
}

export interface BrowserStoreDeps {
  props: ConversationProps;
  browserOpenRequests: Map<
    string,
    {
      promise: Promise<void>;
      serverId: string;
      botId: string | null;
      url: string;
      existingTabIds: Set<string>;
    }
  >;
  browserAddress: () => string;
  setBrowserAddress: (address: string) => void;
  setBrowserAddressEditing: (editing: boolean) => void;
  setComposerError: (error: string | null) => void;
  panels: BrowserPanels;
}

export function createBrowserStore(deps: BrowserStoreDeps) {
  const browserInteractionAvailable = () =>
    deps.props.browserEnabled !== false && !deps.props.browserVisibilitySuspended;
  const browserTabs = createMemo(() => {
    if (deps.props.browserEnabled === false) return [];
    const bot = deps.props.bot;
    if (!bot) return [];
    return deps.props.browserTabs.filter((tab) =>
      tab.ownerBotId ? tab.ownerBotId === bot.id : Boolean(bot.threadId && tab.ownerThreadId === bot.threadId),
    );
  });
  const closingBrowserTabIds = new Set<string>();
  createEffect(
    () => new Set(browserTabs().map((tab) => tab.id)),
    (visibleTabIds) => {
      for (const tabId of closingBrowserTabIds) {
        if (!visibleTabIds.has(tabId)) closingBrowserTabIds.delete(tabId);
      }
    },
  );
  createEffect(
    () => browserTabs().map((tab) => ({ id: tab.id, url: tab.url })),
    (tabs) => {
      const serverId = deps.props.server?.id ?? "local";
      const botId = deps.props.bot?.id ?? null;
      for (const [requestKey, request] of deps.browserOpenRequests) {
        if (request.serverId !== serverId || request.botId !== botId) continue;
        const tabAppeared = tabs.some(
          (tab) => canonicalBrowserUrl(tab.url) === request.url && !request.existingTabIds.has(tab.id),
        );
        if (tabAppeared) deps.browserOpenRequests.delete(requestKey);
      }
    },
  );
  const activeBrowserTab = createMemo(
    () => browserTabs().find((tab) => tab.id === deps.props.activeBrowserTabId) ?? browserTabs()[0],
  );
  const browserTakeoverTab = createMemo(() => {
    const tabId = deps.props.browserTakeover?.tabId;
    return tabId ? browserTabs().find((tab) => tab.id === tabId) : undefined;
  });
  const [browserTakeoverPreview, setBrowserTakeoverPreview] = createSignal<BrowserTakeoverPreviewState>({
    status: "idle",
    preview: null,
  });
  let browserTakeoverPreviewKey: string | null = null;
  let browserTakeoverPreviewGeneration = 0;
  createEffect(
    () => ({
      request: deps.props.browserTakeover,
      tab: browserTakeoverTab(),
      suspended: deps.props.browserVisibilitySuspended,
    }),
    ({ request, tab, suspended }) => {
      if (!request || suspended) {
        browserTakeoverPreviewKey = null;
        browserTakeoverPreviewGeneration += 1;
        setBrowserTakeoverPreview({ status: "idle", preview: null });
        return;
      }

      const requestKey = String(request.requestId);
      if (!tab) {
        if (browserTakeoverPreviewKey !== requestKey) {
          setBrowserTakeoverPreview({ status: "loading", preview: null });
        }
        return;
      }
      if (browserTakeoverPreviewKey === requestKey) return;

      browserTakeoverPreviewKey = requestKey;
      const generation = ++browserTakeoverPreviewGeneration;
      setBrowserTakeoverPreview({ status: "loading", preview: null });
      void window.openbot.browser
        .capturePreview(tab.id)
        .then((preview) => {
          if (browserTakeoverPreviewGeneration !== generation) return;
          setBrowserTakeoverPreview({ status: "ready", preview });
        })
        .catch(() => {
          if (browserTakeoverPreviewGeneration !== generation) return;
          setBrowserTakeoverPreview({ status: "failed", preview: null });
        });
    },
  );
  const latestMessageMarker = createMemo(() => {
    const message = deps.props.messages.at(-1);
    return message
      ? `${message.id}:${message.body.length}:${message.streaming === true ? "streaming" : "settled"}`
      : null;
  });
  const [browserTakeoverResolution, setBrowserTakeoverResolution] = createSignal<BrowserTakeoverResolutionState | null>(
    null,
  );
  createEffect(
    () => deps.props.browserTakeover?.requestId,
    (requestId) => {
      if (requestId !== undefined) setBrowserTakeoverResolution(null);
    },
  );
  createEffect(latestMessageMarker, (messageMarker) => {
    const resolution = untrack(browserTakeoverResolution);
    if (resolution && resolution.messageMarker !== messageMarker) setBrowserTakeoverResolution(null);
  });
  const respondToBrowserTakeover = async (decision: "complete" | "cancel") => {
    const request = deps.props.browserTakeover;
    if (!request) return false;
    const resolution = {
      decision,
      tab: browserTakeoverTab(),
      preview: browserTakeoverPreview().preview,
      previewStatus: browserTakeoverPreview().status,
      messageMarker: latestMessageMarker(),
    } satisfies BrowserTakeoverResolutionState;
    const completed = await deps.props.onRespondToBrowserTakeover(decision);
    if (completed && latestMessageMarker() === resolution.messageMarker) setBrowserTakeoverResolution(resolution);
    return completed;
  };
  let previousBrowserTabCount = 0;
  createEffect(
    () => ({ count: browserTabs().length, open: deps.panels.screenOpen() }),
    ({ count, open }) => {
      if (deps.props.browserEnabled === false) return;
      const browserWasClosed = open && previousBrowserTabCount > 0 && count === 0;
      previousBrowserTabCount = count;
      if (browserWasClosed) deps.panels.hideBrowserPanel();
    },
  );

  createEffect(
    () => {
      const tabId = deps.props.browserTakeover?.tabId;
      return {
        tabId,
        tabExists: Boolean(tabId && browserTabs().some((tab) => tab.id === tabId)),
        activeTabId: deps.props.activeBrowserTabId,
      };
    },
    ({ tabId, tabExists, activeTabId }) => {
      if (!tabId || !tabExists) return;
      deps.panels.setActiveRightPanel("browser");
      if (activeTabId !== tabId) activateBrowserTab(tabId);
    },
  );

  const activeBrowserControl = createMemo(() => {
    if (deps.props.browserEnabled === false) return undefined;
    const sessions = deps.props.browserControlState.sessions;
    const activeTab = activeBrowserTab();
    const forActiveTab = activeTab?.ownerThreadId
      ? sessions.filter((session) => session.threadId === activeTab.ownerThreadId)
      : [];
    const forActiveBot = deps.props.bot?.threadId
      ? sessions.filter((session) => session.threadId === deps.props.bot?.threadId)
      : [];
    const candidates = forActiveTab.length > 0 ? forActiveTab : forActiveBot;
    return (
      [...candidates]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .find((session) => session.phase === "acting") ?? candidates.at(-1)
    );
  });
  const actingBrowserControl = createMemo(() => {
    const control = activeBrowserControl();
    return control?.phase === "acting" ? control : undefined;
  });
  const browserControlBot = createMemo(() => {
    const control = activeBrowserControl();
    return control ? deps.props.bots.find((bot) => bot.threadId === control.threadId) : undefined;
  });
  const browserControlForTab = (tab: BrowserTab) => {
    const sessions = deps.props.browserControlState.sessions.filter(
      (session) =>
        session.tabId === tab.id ||
        (session.tabId === null && tab.id === activeBrowserTab()?.id && session.threadId === tab.ownerThreadId),
    );
    const newestFirst = [...sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return newestFirst.find((session) => session.phase === "acting") ?? newestFirst[0];
  };
  const browserControllerForTab = (tab: BrowserTab) => {
    const control = browserControlForTab(tab);
    return control ? deps.props.bots.find((bot) => bot.threadId === control.threadId) : undefined;
  };

  async function openBrowserAddress(address = deps.browserAddress()) {
    if (!browserInteractionAvailable()) return;
    const value = address.trim();
    if (!value) return;
    deps.setBrowserAddressEditing(false);
    const analytics = desktopAnalytics.scope();
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const serverId = deps.props.server?.id ?? "local";
    const botId = deps.props.bot?.id ?? null;
    const canonicalUrl = canonicalBrowserUrl(url);
    const requestKey = JSON.stringify([serverId, botId, canonicalUrl]);
    const pendingRequest = deps.browserOpenRequests.get(requestKey);
    if (pendingRequest) return pendingRequest.promise;
    const request = (async () => {
      try {
        const tab = await window.openbot.browser.open({
          url,
          ownerThreadId: deps.props.bot?.threadId ?? null,
          ownerBotId: deps.props.bot?.id ?? null,
          focus: true,
        });
        deps.setBrowserAddress(tab.url);
        analytics.track("browser_action", { action: "open", result: "succeeded" });
      } catch {
        deps.setBrowserAddress(url);
        analytics.track("browser_action", {
          action: "open",
          result: "failed",
          failure_code: "browser_open_failed",
        });
      }
    })();
    const pendingRequestState = {
      promise: request,
      serverId,
      botId,
      url: canonicalUrl,
      existingTabIds: new Set(browserTabs().map((tab) => tab.id)),
    };
    deps.browserOpenRequests.set(requestKey, pendingRequestState);
    try {
      await request;
    } finally {
      if (deps.browserOpenRequests.get(requestKey) === pendingRequestState) {
        deps.browserOpenRequests.delete(requestKey);
      }
    }
  }

  async function closeBrowserTab(tabId: string) {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    closingBrowserTabIds.add(tabId);
    try {
      await deps.props.onCloseBrowserTab(tabId);
    } catch {
      deps.setComposerError("Could not close the browser tab.");
    } finally {
      closingBrowserTabIds.delete(tabId);
    }
  }

  function activateBrowserTab(tabId: string) {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    deps.props.onActivateBrowserTab(tabId);
  }

  async function reloadBrowserTab(tabId: string) {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    const analytics = desktopAnalytics.scope();
    try {
      await window.openbot.browser.reload(tabId);
      analytics.track("browser_action", { action: "reload", result: "succeeded" });
    } catch {
      deps.setComposerError("Could not reload the browser tab.");
      analytics.track("browser_action", {
        action: "reload",
        result: "failed",
        failure_code: "browser_reload_failed",
      });
    }
  }

  async function navigateBrowserTab(tabId: string, direction: "back" | "forward") {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    try {
      await window.openbot.browser.navigate({ tabId, direction });
    } catch {
      deps.setComposerError(`Could not navigate ${direction}.`);
    }
  }

  return {
    browserInteractionAvailable,
    browserTabs,
    activeBrowserTab,
    browserTakeoverTab,
    browserTakeoverPreview,
    browserTakeoverResolution,
    respondToBrowserTakeover,
    activeBrowserControl,
    actingBrowserControl,
    browserControlBot,
    browserControlForTab,
    browserControllerForTab,
    openBrowserAddress,
    closeBrowserTab,
    activateBrowserTab,
    reloadBrowserTab,
    navigateBrowserTab,
    getPreviousBrowserTabCount: () => previousBrowserTabCount,
  };
}

export type BrowserStore = ReturnType<typeof createBrowserStore>;
