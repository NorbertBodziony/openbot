import type { AgentSummary, BrowserTab, ServerSummary } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import {
  AGENTS,
  confirmOnboardingModel,
  emitAgentEvent,
  emitBrowserPictureInPicture,
  installOpenbotStub,
  testServer,
} from "./app-test-harness";

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
    installOpenbotStub();
  });

  it("moves the live embedded browser between the sidebar and desktop Picture in Picture", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-pip",
          title: "Picture in Picture test",
          url: "https://example.com/pip",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
      ],
      activeTabId: "tab-pip",
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(await screen.findByRole("complementary", { name: "Browser" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Open browser Picture in Picture" }));

    await waitFor(() => expect(window.openbot.browser.openPictureInPicture).toHaveBeenCalledWith(undefined));
    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();
    expect(window.openbot.browser.close).not.toHaveBeenCalled();

    emitBrowserPictureInPicture?.({
      type: "bounds-changed",
      bounds: { x: 720, y: 360, width: 460, height: 340 },
    });
    expect(window.localStorage.getItem("openbot:browser-pip-native-bounds")).toBe("720,360,460,340");

    emitBrowserPictureInPicture?.({ type: "dock" });
    expect(await screen.findByRole("complementary", { name: "Browser" })).toBeInTheDocument();
    expect(window.openbot.browser.close).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Open browser Picture in Picture" }));
    await waitFor(() =>
      expect(window.openbot.browser.openPictureInPicture).toHaveBeenLastCalledWith({
        x: 720,
        y: 360,
        width: 460,
        height: 340,
      }),
    );
    emitBrowserPictureInPicture?.({ type: "hide" });
    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();
    expect(window.openbot.browser.close).not.toHaveBeenCalled();
  });

  it("keeps a newly opened browser tab active when the initial tab request resolves late", async () => {
    const googleTab: BrowserTab = {
      id: "tab-google",
      title: "Google",
      url: "https://www.google.com",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    const substackTab: BrowserTab = {
      id: "tab-substack",
      title: "Substack | Chat",
      url: "https://substack.com/chat",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    let resolveInitialState: (state: { tabs: BrowserTab[]; activeTabId: string | null }) => void = () => undefined;
    vi.mocked(window.openbot.browser.getDisplayState).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitialState = resolve;
      }),
    );

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(window.openbot.browser.getDisplayState).toHaveBeenCalledTimes(1));
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [googleTab, substackTab],
      activeTabId: substackTab.id,
    });
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    const substackTrigger = await screen.findByRole("tab", { name: "Substack | Chat" });
    expect(substackTrigger).toHaveAttribute("aria-selected", "true");

    resolveInitialState({ tabs: [googleTab], activeTabId: googleTab.id });

    await waitFor(() => expect(substackTrigger).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("tab", { name: "Google" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("textbox", { name: "Browser address" })).toHaveValue("https://substack.com/chat");
  });

  it("restores the active local browser tab after returning from a remote server", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveRemoteTabs: ((tabs: BrowserTab[]) => void) | undefined;
    const firstTab: BrowserTab = {
      id: "tab-first",
      title: "First local tab",
      url: "https://example.com/first",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    const activeTab: BrowserTab = {
      id: "tab-active",
      title: "Active local tab",
      url: "https://example.com/active",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.browser.getDisplayState)
      .mockResolvedValueOnce({ tabs: [], activeTabId: null })
      .mockResolvedValueOnce({ tabs: [firstTab, activeTab], activeTabId: activeTab.id });
    vi.mocked(window.openbot.browser.listTabs).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRemoteTabs = resolve;
      }),
    );

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(window.openbot.browser.getDisplayState).toHaveBeenCalledTimes(1));
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-1"));
    await waitFor(() => expect(resolveRemoteTabs).toBeDefined());
    resolveRemoteTabs?.([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    await waitFor(() => expect(window.openbot.browser.getDisplayState).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Local server" })).toHaveAttribute("aria-pressed", "true"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));

    expect(await screen.findByRole("tab", { name: "Active local tab" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "First local tab" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("textbox", { name: "Browser address" })).toHaveValue("https://example.com/active");
  });

  it("restores desktop Picture in Picture per conversation without overriding it during agent control", async () => {
    window.localStorage.setItem("openbot:browser-pip-native-bounds", "640,320,460,340");
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-pip-restore",
          title: "Restored PiP",
          url: "https://example.com",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
      ],
      activeTabId: "tab-pip-restore",
    });
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open browser Picture in Picture" }));
    await waitFor(() =>
      expect(window.openbot.browser.openPictureInPicture).toHaveBeenLastCalledWith({
        x: 640,
        y: 320,
        width: 460,
        height: 340,
      }),
    );

    emitAgentEvent?.({
      type: "browser-control-changed",
      state: {
        sessions: [
          {
            id: "thread-chief:turn-pip",
            threadId: "thread-chief",
            turnId: "turn-pip",
            callId: "call-pip",
            tabId: "tab-pip-restore",
            action: "click",
            phase: "acting",
            startedAt: "2026-08-24T08:00:00.000Z",
          },
        ],
      },
    });
    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    await waitFor(() => expect(window.openbot.browser.closePictureInPicture).toHaveBeenCalled());
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() => expect(window.openbot.browser.openPictureInPicture).toHaveBeenCalledTimes(2));
  });

  it("shows the browser control indicator only while an agent acts", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-1",
          title: "Local smoke page",
          url: "http://127.0.0.1:4321",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
        {
          id: "tab-2",
          title: "Second page",
          url: "https://example.com/second",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
        {
          id: "tab-3",
          title: "Third page",
          url: "https://example.com/third",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
      ],
      activeTabId: "tab-1",
    });
    emitAgentEvent?.({
      type: "browser-control-changed",
      state: {
        sessions: [
          {
            id: "thread-chief:turn-1",
            threadId: "thread-chief",
            turnId: "turn-1",
            callId: "call-1",
            tabId: null,
            action: "type",
            phase: "acting",
            startedAt: "2026-08-12T10:00:00.000Z",
          },
        ],
      },
    });

    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();
    const browserControl = screen.getByRole("button", { name: "Chief is controlling the browser" });
    expect(browserControl).toHaveAttribute("aria-expanded", "false");
    expect(window.openbot.browser.open).not.toHaveBeenCalled();

    await fireEvent.click(browserControl);
    const controlledTab = await screen.findByRole("tab", {
      name: "Local smoke page, controlled by Chief",
    });
    expect(controlledTab).toHaveAttribute("aria-description", "Press Delete or Control/Command W to close");
    await fireEvent.keyDown(screen.getByRole("tab", { name: "Third page" }), { key: "Delete" });
    expect(window.openbot.browser.close).toHaveBeenCalledWith("tab-3");
    await fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(window.openbot.browser.open).toHaveBeenCalledWith({
      url: "https://www.google.com",
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
      focus: true,
    });
    expect(screen.queryByText("Typing…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chief is controlling the browser" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    emitAgentEvent?.({
      type: "browser-control-changed",
      state: {
        sessions: [
          {
            id: "thread-chief:turn-1",
            threadId: "thread-chief",
            turnId: "turn-1",
            callId: "call-1",
            tabId: "tab-1",
            action: "type",
            phase: "waiting",
            startedAt: "2026-08-12T10:00:00.000Z",
          },
        ],
      },
    });
    expect(screen.queryByRole("button", { name: "Chief is controlling the browser" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide computer" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Local smoke page" })).toBe(controlledTab);

    emitAgentEvent?.({
      type: "browser-control-changed",
      state: {
        sessions: [
          {
            id: "thread-chief:turn-1",
            threadId: "thread-chief",
            turnId: "turn-1",
            callId: "call-1",
            tabId: "tab-1",
            action: "type",
            phase: "waiting",
            startedAt: "2026-08-12T10:00:00.000Z",
          },
          {
            id: "thread-chief:turn-2",
            threadId: "thread-chief",
            turnId: "turn-2",
            callId: "call-2",
            tabId: "tab-1",
            action: "click",
            phase: "acting",
            startedAt: "2026-08-12T10:00:01.000Z",
          },
        ],
      },
    });
    expect(screen.getByRole("tab", { name: "Local smoke page, controlled by Chief" })).toBe(controlledTab);

    emitAgentEvent?.({ type: "browser-control-changed", state: { sessions: [] } });
    expect(screen.getByRole("tab", { name: "Local smoke page" })).toBe(controlledTab);
  });

  it("coalesces repeated empty-browser opens and does not reopen the panel after a late response", async () => {
    const openedTab: BrowserTab = {
      id: "tab-delayed",
      title: "Delayed page",
      url: "https://www.google.com",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    let resolveOpen: ((tab: BrowserTab) => void) | undefined;
    vi.mocked(window.openbot.browser.open).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(await screen.findByRole("complementary", { name: "Browser" })).toBeInTheDocument();
    expect(window.openbot.browser.open).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "Hide computer" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    await fireEvent.click(screen.getByRole("button", { name: "Hide computer" }));
    expect(window.openbot.browser.open).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();

    emitAgentEvent?.({ type: "browser-changed", tabs: [openedTab], activeTabId: openedTab.id });
    resolveOpen?.(openedTab);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open computer" })).toHaveAttribute("aria-expanded", "false");
    expect(window.openbot.browser.open).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(await screen.findByRole("tab", { name: "Delayed page" })).toHaveAttribute("aria-selected", "true");
    await fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(window.openbot.browser.reload).toHaveBeenCalledWith(openedTab.id);

    await fireEvent.click(screen.getByRole("button", { name: "Hide computer" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(await screen.findByRole("tab", { name: "Delayed page" })).toHaveAttribute("aria-selected", "true");
    expect(window.openbot.browser.open).toHaveBeenCalledTimes(1);
  });

  it("allows a replacement when a loading browser tab is closed before its open request settles", async () => {
    const loadingTab: BrowserTab = {
      id: "tab-loading",
      title: "Loading…",
      url: "https://www.google.com/",
      loading: true,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    let resolveFirstOpen: ((tab: BrowserTab) => void) | undefined;
    vi.mocked(window.openbot.browser.open).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstOpen = resolve;
        }),
    );

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(window.openbot.browser.open).toHaveBeenCalledTimes(1);

    emitAgentEvent?.({ type: "browser-changed", tabs: [loadingTab], activeTabId: loadingTab.id });
    const tab = await screen.findByRole("tab", { name: "Loading…" });
    await fireEvent.keyDown(tab, { key: "Delete" });
    expect(window.openbot.browser.close).toHaveBeenCalledWith(loadingTab.id);

    emitAgentEvent?.({ type: "browser-changed", tabs: [], activeTabId: null });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument());

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(window.openbot.browser.open).toHaveBeenCalledTimes(2);

    resolveFirstOpen?.(loadingTab);
  });

  it("reveals the requested browser tab and resumes the agent from the takeover card", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await waitFor(() => expect(emitAgentEvent).toBeDefined());
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-public",
          title: "Public page",
          url: "https://example.com",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
        {
          id: "tab-login",
          title: "Sign in",
          url: "https://example.com/login",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
      ],
      activeTabId: "tab-public",
    });
    emitAgentEvent?.({
      type: "browser-takeover-requested",
      request: {
        requestId: "takeover-1",
        agentId: "chief",
        threadId: "thread-chief",
        turnId: "turn-1",
        tabId: "tab-login",
      },
    });

    expect(await screen.findByRole("region", { name: "Browser takeover" })).toHaveTextContent("Action required");
    expect(screen.getByRole("heading", { name: "Complete the step on example.com" })).toBeVisible();
    expect(await screen.findByRole("img", { name: "Preview of Sign in" })).toBeVisible();
    expect(await screen.findByRole("complementary", { name: "Browser" })).toBeVisible();
    await waitFor(() => expect(window.openbot.browser.activate).toHaveBeenCalledWith("tab-login"));
    expect(window.openbot.browser.capturePreview).toHaveBeenCalledTimes(1);
    expect(window.openbot.browser.capturePreview).toHaveBeenCalledWith("tab-login");
    expect(screen.queryByRole("textbox", { name: "Message Chief" })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "I’m done" }));
    await waitFor(() =>
      expect(window.openbot.agent.respondToBrowserTakeover).toHaveBeenCalledWith({
        requestId: "takeover-1",
        decision: "complete",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "Browser takeover" })).not.toBeInTheDocument());
    const completedCard = await screen.findByRole("region", { name: "Browser takeover complete" });
    expect(completedCard).toHaveTextContent("Done");
    expect(within(completedCard).getByRole("img", { name: "Preview of Sign in" })).toBeVisible();
    expect(within(completedCard).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Chief" })).toBeVisible();
  });

  it("keeps browser takeover actions available when the preview fails", async () => {
    vi.mocked(window.openbot.browser.capturePreview).mockRejectedValueOnce(new Error("Preview unavailable"));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await waitFor(() => expect(emitAgentEvent).toBeDefined());
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-login",
          title: "Sign in",
          url: "https://example.com/login",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
      ],
      activeTabId: "tab-login",
    });
    emitAgentEvent?.({
      type: "browser-takeover-requested",
      request: {
        requestId: "takeover-preview-failed",
        agentId: "chief",
        threadId: "thread-chief",
        turnId: "turn-preview-failed",
        tabId: "tab-login",
      },
    });

    const card = await screen.findByRole("region", { name: "Browser takeover" });
    await waitFor(() => expect(within(card).queryByRole("img")).not.toBeInTheDocument());
    await fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(window.openbot.agent.respondToBrowserTakeover).toHaveBeenCalledWith({
        requestId: "takeover-preview-failed",
        decision: "cancel",
      }),
    );
    const cancelledCard = await screen.findByRole("region", { name: "Browser takeover cancelled" });
    expect(cancelledCard).toHaveTextContent("Cancelled");
    expect(within(cancelledCard).queryByRole("button")).not.toBeInTheDocument();
  });

  it("coalesces repeated tab closes and ignores navigation while a close is pending", async () => {
    let resolveClose: (() => void) | undefined;
    vi.mocked(window.openbot.browser.close).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const firstTab = {
      id: "tab-shortcut-1",
      title: "First page",
      url: "https://example.com/first",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    const secondTab = {
      id: "tab-shortcut-2",
      title: "Second page",
      url: "https://example.com/second",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [firstTab, secondTab],
      activeTabId: secondTab.id,
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    await screen.findByRole("complementary", { name: "Browser" });
    const closingTab = await screen.findByRole("tab", { name: "Second page" });
    await fireEvent.pointerDown(closingTab, { button: 1 });
    await fireEvent.pointerDown(closingTab, { button: 1 });
    expect(window.openbot.browser.close).toHaveBeenCalledWith(secondTab.id);
    expect(window.openbot.browser.close).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(window.openbot.browser.navigate).not.toHaveBeenCalled();

    resolveClose?.();
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Second page" })).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "First page" })).toHaveAttribute("aria-selected", "true");
  });

  it("waits for tab activation before it closes the same tab", async () => {
    let resolveActivation: (() => void) | undefined;
    vi.mocked(window.openbot.browser.activate).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveActivation = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const firstTab = {
      id: "tab-activation-first",
      title: "First activation page",
      url: "https://example.com/first",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    const secondTab = {
      id: "tab-activation-closing",
      title: "Closing activation page",
      url: "https://example.com/closing",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [firstTab, secondTab],
      activeTabId: firstTab.id,
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    const closingTab = await screen.findByRole("tab", { name: "Closing activation page" });
    await fireEvent.click(closingTab);
    await waitFor(() => expect(window.openbot.browser.activate).toHaveBeenCalledWith(secondTab.id));
    await fireEvent.keyDown(closingTab, { key: "Delete" });
    expect(window.openbot.browser.close).not.toHaveBeenCalled();

    resolveActivation?.();
    await waitFor(() => expect(window.openbot.browser.close).toHaveBeenCalledWith(secondTab.id));
  });

  it("drops a pending tab close when a server switch begins", async () => {
    const local = testServer("local", true);
    const studio = testServer("remote-1", false);
    let resolveActivation: (() => void) | undefined;
    let resolveSelection: ((servers: ServerSummary[]) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, studio]);
    vi.mocked(window.openbot.servers.select).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve;
        }),
    );
    vi.mocked(window.openbot.browser.activate).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveActivation = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const firstTab = {
      id: "tab-switch-first",
      title: "First switch page",
      url: "https://example.com/first",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    const closingTab = {
      id: "tab-switch-closing",
      title: "Closing switch page",
      url: "https://example.com/closing",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [firstTab, closingTab],
      activeTabId: firstTab.id,
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    const closingTabElement = await screen.findByRole("tab", { name: "Closing switch page" });
    await fireEvent.click(closingTabElement);
    await waitFor(() => expect(resolveActivation).toBeDefined());
    await fireEvent.keyDown(closingTabElement, { key: "Delete" });
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(resolveSelection).toBeDefined());

    resolveActivation?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.openbot.browser.close).not.toHaveBeenCalled();

    resolveSelection?.([
      { ...local, active: false },
      { ...studio, active: true },
    ]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("keeps the browser open when a new tab replaces the last tab during its delayed close", async () => {
    let resolveClose: (() => void) | undefined;
    vi.mocked(window.openbot.browser.close).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const closingTab = {
      id: "tab-closing-last",
      title: "Closing page",
      url: "https://example.com/closing",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    const replacementTab = {
      id: "tab-replacement",
      title: "Replacement page",
      url: "https://example.com/replacement",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerAgentId: "chief",
    };
    emitAgentEvent?.({ type: "browser-changed", tabs: [closingTab], activeTabId: closingTab.id });
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    await fireEvent.keyDown(await screen.findByRole("tab", { name: "Closing page" }), { key: "Delete" });
    await waitFor(() => expect(resolveClose).toBeDefined());

    emitAgentEvent?.({ type: "browser-changed", tabs: [replacementTab], activeTabId: replacementTab.id });
    expect(await screen.findByRole("tab", { name: "Replacement page" })).toBeInTheDocument();
    resolveClose?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByRole("complementary", { name: "Browser" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Replacement page" })).toBeInTheDocument();
  });

  it("closes the active remote browser tab with Control W", async () => {
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([
      testServer("local", true),
      testServer("remote-1", false),
    ]);
    vi.mocked(window.openbot.servers.select).mockResolvedValueOnce([
      testServer("local", false),
      testServer("remote-1", true),
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "local-tab",
          title: "Local page",
          url: "https://example.com/local",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
      ],
      activeTabId: "local-tab",
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    await screen.findByRole("tab", { name: "Local page" });
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-1"));
    const hideBrowserCall = vi
      .mocked(window.openbot.browser.setVisible)
      .mock.calls.findIndex(([input]) => input.visible === false);
    expect(hideBrowserCall).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(window.openbot.browser.setVisible).mock.invocationCallOrder[hideBrowserCall]).toBeLessThan(
      vi.mocked(window.openbot.servers.select).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "remote-tab",
          title: "Remote page",
          url: "https://example.com/remote",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
      ],
      activeTabId: "remote-tab",
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Open computer" }));
    await screen.findByRole("tab", { name: "Remote page" });
    await fireEvent.keyDown(window, { key: "w", ctrlKey: true });

    expect(window.openbot.browser.close).toHaveBeenCalledWith("remote-tab");
  });

  it("blocks browser controls while the remote browser is suspended during a server switch", async () => {
    const local = testServer("local", true);
    const studio = testServer("remote-1", false);
    const office = { ...testServer("remote-2", false), name: "Office PC", apiUrl: "https://office.example.com" };
    let resolveOfficeSelection: ((servers: ServerSummary[]) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, studio, office]);
    vi.mocked(window.openbot.servers.select)
      .mockResolvedValueOnce([
        { ...local, active: false },
        { ...studio, active: true },
        { ...office, active: false },
      ])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOfficeSelection = resolve;
          }),
      );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-1"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "remote-tab-during-switch",
          title: "Remote page",
          url: "https://example.com/remote",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
      ],
      activeTabId: "remote-tab-during-switch",
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Open computer" }));
    const remoteTab = await screen.findByRole("tab", { name: "Remote page" });
    const address = screen.getByRole("textbox", { name: "Browser address" });
    const addressForm = address.closest("form");
    if (!addressForm) throw new Error("Browser address form was not rendered.");
    const backButton = screen.getByRole("button", { name: "Go back" });
    const reloadButton = screen.getByRole("button", { name: "Reload page" });
    vi.mocked(window.openbot.browser.open).mockClear();
    vi.mocked(window.openbot.browser.activate).mockClear();
    vi.mocked(window.openbot.browser.close).mockClear();
    vi.mocked(window.openbot.browser.reload).mockClear();
    vi.mocked(window.openbot.browser.navigate).mockClear();

    await fireEvent.click(screen.getByRole("button", { name: "Office PC server" }));
    await waitFor(() => expect(resolveOfficeSelection).toBeDefined());
    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();
    const computerButton = screen.getByRole("button", { name: "Open computer" });
    expect(computerButton).toBeDisabled();
    await fireEvent.click(computerButton);
    await fireEvent.click(remoteTab);
    await fireEvent.keyDown(remoteTab, { key: "Delete" });
    await fireEvent.click(backButton);
    await fireEvent.click(reloadButton);
    await fireEvent.submit(addressForm);
    await fireEvent.keyDown(window, { key: "w", ctrlKey: true });

    expect(window.openbot.browser.open).not.toHaveBeenCalled();
    expect(window.openbot.browser.activate).not.toHaveBeenCalled();
    expect(window.openbot.browser.close).not.toHaveBeenCalled();
    expect(window.openbot.browser.reload).not.toHaveBeenCalled();
    expect(window.openbot.browser.navigate).not.toHaveBeenCalled();
    resolveOfficeSelection?.([
      { ...local, active: false },
      { ...studio, active: false },
      { ...office, active: true },
    ]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Office PC server" })).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("restores the visible browser after a server switch fails", async () => {
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([
      testServer("local", true),
      testServer("remote-1", false),
    ]);
    vi.mocked(window.openbot.servers.select).mockRejectedValueOnce(new Error("Workspace refresh failed"));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "local-tab",
          title: "Local page",
          url: "https://example.com/local",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
      ],
      activeTabId: "local-tab",
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    await screen.findByRole("complementary", { name: "Browser" });
    await waitFor(() =>
      expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true, target: "main" }),
      ),
    );
    vi.mocked(window.openbot.browser.setVisible).mockClear();

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));

    await screen.findByText("Could not select the server");
    expect(await screen.findByRole("complementary", { name: "Browser" })).toBeInTheDocument();
    window.dispatchEvent(new Event("resize"));
    await waitFor(() =>
      expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith(
        expect.objectContaining({ visible: true, target: "main" }),
      ),
    );
  });

  it("keeps the latest workspace when an older server load resolves late", async () => {
    const local = testServer("local", true);
    const studio = { ...testServer("remote-1", false), name: "Studio Mac" };
    const office = { ...testServer("remote-2", false), name: "Office PC", apiUrl: "https://office.example.com" };
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, studio, office]);
    vi.mocked(window.openbot.servers.select)
      .mockResolvedValueOnce([
        { ...local, active: false },
        { ...studio, active: true },
        { ...office, active: false },
      ])
      .mockResolvedValueOnce([
        { ...local, active: false },
        { ...studio, active: false },
        { ...office, active: true },
      ]);

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    let resolveStudioAgents: ((agents: AgentSummary[]) => void) | undefined;
    vi.mocked(window.openbot.agent.listAgents)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStudioAgents = resolve;
          }),
      )
      .mockResolvedValueOnce([{ ...AGENTS[0], name: "Office Chief" }]);

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(resolveStudioAgents).toBeDefined());
    await fireEvent.click(screen.getByRole("button", { name: "Office PC server" }));

    expect(await screen.findByRole("heading", { name: "Office Chief" })).toBeInTheDocument();
    resolveStudioAgents?.([{ ...AGENTS[0], name: "Studio Chief" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByRole("button", { name: "Office PC server" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Office Chief" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Studio Chief" })).not.toBeInTheDocument();
  });

  it("restores the authoritative workspace when a newer server selection fails", async () => {
    const local = testServer("local", true);
    const studio = { ...testServer("remote-1", false), name: "Studio Mac" };
    const office = { ...testServer("remote-2", false), name: "Office PC", apiUrl: "https://office.example.com" };
    const studioActive = [
      { ...local, active: false },
      { ...studio, active: true },
      { ...office, active: false },
    ];
    let resolveStudioSelection: ((servers: ServerSummary[]) => void) | undefined;
    let rejectOfficeSelection: ((error: Error) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, studio, office]);
    vi.mocked(window.openbot.servers.select)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStudioSelection = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOfficeSelection = reject;
          }),
      )
      .mockResolvedValueOnce(studioActive);

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    vi.mocked(window.openbot.agent.listAgents).mockResolvedValueOnce([{ ...AGENTS[0], name: "Studio Chief" }]);

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(resolveStudioSelection).toBeDefined());
    await fireEvent.click(screen.getByRole("button", { name: "Office PC server" }));
    await waitFor(() => expect(rejectOfficeSelection).toBeDefined());
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce(studioActive);
    resolveStudioSelection?.(studioActive);
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejectOfficeSelection?.(new Error("Office unavailable"));

    expect(await screen.findByRole("heading", { name: "Studio Chief" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true");
    expect(window.openbot.servers.select).toHaveBeenCalledTimes(3);
  });

  it("closes the browser panel when its last tab is closed from the embedded page", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-embedded-shortcut",
          title: "Focused page",
          url: "https://example.com",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerAgentId: "chief",
        },
      ],
      activeTabId: "tab-embedded-shortcut",
    });
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(await screen.findByRole("complementary", { name: "Browser" })).toBeInTheDocument();

    emitAgentEvent?.({ type: "browser-changed", tabs: [], activeTabId: null });

    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument());
    expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith({ visible: false });
  });

  it("opens workspace Markdown in the right sidebar and keeps external opening explicit", async () => {
    const workspacePath = "/tmp/OpenBot/Agents/chief/recipe-tomato-basil-pasta.md";
    const sharedPath = "/tmp/OpenBot/Shared/menu.txt";
    vi.mocked(window.openbot.agent.readConversation).mockImplementation(async (agentId) => ({
      agentId,
      threadId: agentId === "chief" ? "thread-chief" : null,
      activeTurnId: null,
      revision: 1,
      messages:
        agentId === "chief"
          ? [
              {
                id: "message-file-preview",
                author: "assistant",
                text: `Created [recipe-tomato-basil-pasta.md](${workspacePath}) and [menu.txt](${sharedPath}).`,
                createdAt: "2026-08-24T12:16:00.000Z",
                status: "completed",
              },
            ]
          : [],
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    }));
    vi.mocked(window.openbot.agent.previewWorkspaceFile).mockResolvedValueOnce({
      name: "recipe-tomato-basil-pasta.md",
      size: 41,
      mimeType: "text/plain",
      previewKind: "markdown",
      bytes: new TextEncoder().encode("# Tomato Basil Pasta\n\nUse **fresh basil**."),
    });
    vi.mocked(window.openbot.agent.previewSharedFile).mockResolvedValueOnce({
      name: "menu.txt",
      size: 12,
      mimeType: "text/plain",
      previewKind: "text",
      bytes: new TextEncoder().encode("Pasta menu"),
    });

    render(() => <App />);
    await fireEvent.click(
      await screen.findByRole("button", { name: "Open workspace file recipe-tomato-basil-pasta.md" }),
    );

    expect(await screen.findByRole("complementary", { name: "File preview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Tomato Basil Pasta" })).toBeInTheDocument();
    expect(screen.getByText("fresh basil").tagName).toBe("STRONG");
    expect(window.openbot.agent.previewWorkspaceFile).toHaveBeenCalledWith({ agentId: "chief", path: workspacePath });
    expect(window.openbot.agent.openWorkspaceFile).not.toHaveBeenCalled();
    expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith({ visible: false });

    await fireEvent.click(screen.getByRole("button", { name: "Open file externally" }));
    expect(window.openbot.agent.openWorkspaceFile).toHaveBeenCalledWith({ agentId: "chief", path: workspacePath });
    await fireEvent.click(screen.getByRole("button", { name: "Close file preview" }));
    expect(screen.queryByRole("complementary", { name: "File preview" })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Open shared file menu.txt" }));
    expect(await screen.findByText("Pasta menu")).toBeInTheDocument();
    expect(window.openbot.agent.previewSharedFile).toHaveBeenCalledWith({ path: sharedPath });
    expect(window.openbot.agent.openSharedFile).not.toHaveBeenCalled();
  });
});
