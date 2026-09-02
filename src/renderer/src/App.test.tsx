import type { BotSummary, ConversationPage, ConversationSnapshot } from "@openbot/contracts/ipc";
import { routineConversationEventItemType } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { expect, it, vi } from "vitest";
import { App, AppControllerProvider, createAppController, createBotInitialMessage, useAppController } from "./App";
import { desktopAnalytics } from "./analytics";
import {
  BOTS,
  confirmOnboardingModel,
  emitAgentEvent,
  emitDynamicIslandAction,
  emitPresence,
  emitScopedAgentEvent,
  emitServers,
  installOpenbotStub,
  presenceMember,
  testConversationPage,
  testServer,
} from "./app-test-harness";
import { SIDEBAR_PINS_STORAGE_KEY } from "./sidebar-pins";
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "./sidebar-sections";

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
    installOpenbotStub();
  });

  it("keeps shell state and subscriptions when a view boundary remounts", async () => {
    function ShellProbe() {
      const controller = useAppController();
      return (
        <output data-testid="shell-controller-state">
          {controller.activeServer()?.id}|{controller.activeBot()?.id}|{controller.activeMessages().length}|
          {controller.leftPanelWidth()}
        </output>
      );
    }

    function Harness() {
      const controller = createAppController({});
      const [viewVisible, setViewVisible] = createSignal(true);
      return (
        <AppControllerProvider controller={controller}>
          <button type="button" onClick={() => setViewVisible((current) => !current)}>
            Toggle shell view
          </button>
          <button
            type="button"
            onClick={() => {
              controller.setLeftPanelWidth(360);
              controller.selectBot("sales-outbound");
            }}
          >
            Set shell state
          </button>
          <Show when={viewVisible()}>
            <ShellProbe />
          </Show>
        </AppControllerProvider>
      );
    }

    render(() => <Harness />);
    await waitFor(() => expect(screen.getByTestId("shell-controller-state")).toHaveTextContent("local|chief|0|280"));
    await fireEvent.click(screen.getByRole("button", { name: "Set shell state" }));
    await waitFor(() =>
      expect(screen.getByTestId("shell-controller-state")).toHaveTextContent("local|sales-outbound|0|360"),
    );

    const agentSubscriptionCount = vi.mocked(window.openbot.agent.onEvent).mock.calls.length;
    const authSubscriptionCount = vi.mocked(window.openbot.auth.onEvent).mock.calls.length;
    const presenceSubscriptionCount = vi.mocked(window.openbot.servers.onPresence).mock.calls.length;

    await fireEvent.click(screen.getByRole("button", { name: "Toggle shell view" }));
    expect(screen.queryByTestId("shell-controller-state")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Toggle shell view" }));

    expect(screen.getByTestId("shell-controller-state")).toHaveTextContent("local|sales-outbound|0|360");
    expect(window.openbot.agent.onEvent).toHaveBeenCalledTimes(agentSubscriptionCount);
    expect(window.openbot.auth.onEvent).toHaveBeenCalledTimes(authSubscriptionCount);
    expect(window.openbot.servers.onPresence).toHaveBeenCalledTimes(presenceSubscriptionCount);
  });

  it("keeps an old routine marker unavailable when paginated history omits its deletion", async () => {
    vi.mocked(window.openbot.agent.listRoutines).mockResolvedValue([]);
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue(
      testConversationPage("chief", [
        {
          id: "old-routine-event",
          author: "system",
          source: "system",
          text: "Archived brief",
          createdAt: "2026-08-30T10:00:00.000Z",
          status: "completed",
          itemType: routineConversationEventItemType("updated", "deleted-routine"),
        },
      ]),
    );

    render(() => <App />);

    expect(await screen.findByText("Archived brief")).toBeInTheDocument();
    await waitFor(() => expect(window.openbot.agent.listRoutines).toHaveBeenCalledWith("chief"));
    expect(screen.queryByRole("button", { name: "Open routine Archived brief" })).not.toBeInTheDocument();
  });

  it("shows the interactive account dock in the landing preview and omits browser and remote control", async () => {
    const configure = vi.spyOn(desktopAnalytics, "configure");
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({
      status: "signed_in",
      user: {
        id: "user-1",
        email: "norbertbodziony@gmail.com",
        name: "Norbert",
        avatarUrl: null,
      },
    });
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([
      {
        id: "remote-1",
        name: "Studio Mac",
        logoUrl: null,
        kind: "remote",
        state: "online",
        apiUrl: "https://studio.example.com",
        remoteDesktopAvailable: true,
        role: "owner",
        active: true,
      },
    ]);

    render(() => <App landingPreview />);
    await screen.findByRole("heading", { name: "Chief" });

    const usageButton = await screen.findByRole("button", { name: "Weekly usage, 59% left" });
    await fireEvent.click(usageButton);
    expect(screen.getByRole("dialog", { name: "Weekly usage" })).toBeInTheDocument();

    const accountButton = screen.getByRole("button", { name: "Open account actions" });
    await fireEvent.click(accountButton);
    const accountDialog = screen.getByRole("dialog", { name: "Account actions" });
    expect(accountDialog).toBeInTheDocument();
    expect(screen.getByText("Norbert")).toBeInTheDocument();
    expect(screen.getByText("norbertbodziony@gmail.com")).toBeInTheDocument();
    expect(within(accountDialog).queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    await fireEvent.click(within(accountDialog).getByRole("button", { name: "Providers & permissions" }));
    const permissionsDialog = await screen.findByRole("dialog", { name: "Providers & permissions" });
    expect(within(permissionsDialog).queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    await fireEvent.click(within(permissionsDialog).getByRole("button", { name: "Cancel" }));
    expect(window.openbot.auth.logout).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Open computer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remote control/iu })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Add remote server" }));
    expect(screen.queryByRole("dialog", { name: "Join a server" })).not.toBeInTheDocument();
    expect(window.openbot.browser.listTabs).not.toHaveBeenCalled();
    expect(window.openbot.browser.getControlState).not.toHaveBeenCalled();
    expect(window.openbot.browser.setVisible).not.toHaveBeenCalled();
    expect(window.openbot.remoteDesktop.list).not.toHaveBeenCalled();
    expect(window.openbot.remoteDesktop.onEvent).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    configure.mockRestore();
  });

  it("renders message links and opens them in the external browser", async () => {
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValueOnce({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "linked-message",
          author: "assistant",
          text: "Read [Meta](https://about.fb.com/news/) or https://example.com/report.",
          createdAt: "2026-08-12T09:00:00.000Z",
          status: "completed",
        },
      ],
    });
    render(() => <App />);
    const metaLink = await screen.findByRole("link", { name: "Meta" });
    expect(metaLink).toHaveAttribute("href", "https://about.fb.com/news/");
    expect(screen.getByRole("link", { name: "https://example.com/report" })).toHaveAttribute(
      "href",
      "https://example.com/report",
    );
    expect(screen.queryByText("https://about.fb.com/news/")).not.toBeInTheDocument();

    await fireEvent.click(metaLink);
    expect(window.openbot.openUrl).toHaveBeenCalledWith("https://about.fb.com/news/");
    expect(window.openbot.browser.open).not.toHaveBeenCalled();
  });

  it("refreshes stored history when Codex becomes ready after the window opens", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValue({
      phase: "starting",
      cliVersion: "0.144.1",
      auth: { kind: "unknown" },
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Starting local Codex…",
      fullAccess: true,
    });
    vi.mocked(window.openbot.agent.readConversation)
      .mockResolvedValueOnce({
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 0,
        messages: [],
      })
      .mockResolvedValueOnce({
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "restored-answer",
            author: "assistant",
            text: "Restored after Codex became ready",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      });

    render(() => <App />);
    await screen.findByText("Connecting to agent CLIs…");
    emitAgentEvent?.({
      type: "status",
      status: {
        phase: "ready",
        cliVersion: "0.144.1",
        auth: { kind: "chatgpt", email: "norbert@example.com" },
        capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
        message: null,
        fullAccess: true,
      },
    });

    expect(await screen.findByText("Restored after Codex became ready")).toBeInTheDocument();
    expect(window.openbot.agent.readConversation).toHaveBeenCalledTimes(2);
  });

  it("restores and persists pinned chats for the active server", async () => {
    window.localStorage.setItem(SIDEBAR_PINS_STORAGE_KEY, JSON.stringify({ local: [{ kind: "agent", id: "chief" }] }));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const pinnedChief = screen.getByRole("button", { name: "Chief, pinned agent" });
    expect(screen.getByRole("region", { name: "Pinned chats" })).toBeInTheDocument();
    await fireEvent.contextMenu(pinnedChief, { clientX: 120, clientY: 90 });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Unpin" }), { button: 0 });

    await waitFor(() => expect(screen.queryByRole("region", { name: "Pinned chats" })).not.toBeInTheDocument());
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_PINS_STORAGE_KEY) ?? "{}")).toEqual({});
    expect(screen.getByRole("button", { name: /Chief, Chief of staff/ })).toBeInTheDocument();
  });

  it("loads shared sidebar sections and connects section actions to the desktop API", async () => {
    const sectionId = "11111111-1111-4111-8111-111111111111";
    const layout = {
      revision: 3,
      sections: [{ id: sectionId, name: "Core team" }],
      order: ["people", sectionId, "unassigned"],
      agentAssignments: { chief: sectionId },
      agentOrder: ["chief", "sales-outbound"],
    };
    vi.mocked(window.openbot.agent.getSidebarLayout).mockResolvedValueOnce(layout);
    vi.mocked(window.openbot.agent.mutateSidebarLayout).mockResolvedValueOnce({ ...layout, revision: 4 });

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const sectionToggle = await screen.findByRole("button", { name: "Core team" });
    const section = sectionToggle.closest<HTMLElement>("[data-section-id]");
    if (!section) throw new Error("Shared sidebar section is missing.");
    expect(within(section).getByRole("button", { name: /Chief, Chief of staff/ })).toBeInTheDocument();

    await fireEvent.click(sectionToggle);
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) ?? "{}")).toEqual({
      local: [sectionId],
    });

    await fireEvent.contextMenu(screen.getByLabelText("Sidebar free area"));
    const sidebarMenu = await screen.findByRole("menu", { name: "Sidebar actions" });
    await fireEvent.pointerUp(within(sidebarMenu).getByRole("menuitem", { name: "New section" }), { button: 0 });
    const sectionName = await screen.findByRole("textbox", { name: "New section name" });
    await fireEvent.input(sectionName, { target: { value: "Product" } });
    await fireEvent.keyDown(sectionName, { key: "Enter" });

    await waitFor(() =>
      expect(window.openbot.agent.mutateSidebarLayout).toHaveBeenCalledWith({ type: "create", name: "Product" }),
    );
  });

  it("creates a Bot from a suggestion with one complete backend input", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Create new Bot" }));
    expect(await screen.findByRole("heading", { name: "Create a new Bot" })).toBeInTheDocument();
    expect(window.openbot.agent.createBot).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: /^Trip Planner\./ }));

    const name = screen.getByRole("textbox", { name: "Name" });
    const purpose = screen.getByRole("textbox", { name: "What should this Bot help with?" });
    expect(name).toHaveValue("Trip Planner");
    expect(purpose).toHaveValue(
      "Compare travel options and turn my rough ideas into practical, day-by-day itineraries.",
    );
    await fireEvent.click(screen.getByRole("button", { name: "Create Bot" }));

    await waitFor(() => expect(window.openbot.agent.createBot).toHaveBeenCalledOnce());
    const draft = {
      name: "Trip Planner",
      purpose: "Compare travel options and turn my rough ideas into practical, day-by-day itineraries.",
    };
    expect(window.openbot.agent.createBot).toHaveBeenCalledWith({
      name: draft.name,
      description: draft.purpose,
      avatarSeed: expect.any(String),
      avatarHue: 215,
      initialMessage: createBotInitialMessage(draft),
    });
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Trip Planner" })).toBeInTheDocument();
  });

  it("opens and cancels Bot creation from a private conversation", async () => {
    render(() => <App peopleEnabled />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        presenceMember("member-self", "person@example.com", "Person"),
        presenceMember("member-alice", "alice@example.com", "Alice"),
      ],
    });
    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    expect(await screen.findByRole("main", { name: "Direct conversation with Alice" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Create new Bot" }));

    expect(await screen.findByRole("heading", { name: "Create a new Bot" })).toBeInTheDocument();
    expect(window.openbot.agent.createBot).not.toHaveBeenCalled();
    expect(window.openbot.servers.setDirectTyping).toHaveBeenCalledWith({
      memberId: "member-alice",
      typing: false,
    });
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("main", { name: "Direct conversation with Alice" })).toBeInTheDocument();
  });

  it("hides People navigation and direct conversations by default", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        presenceMember("member-self", "person@example.com", "Person"),
        presenceMember("member-alice", "alice@example.com", "Alice"),
      ],
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "People" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Alice/ })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("main", { name: /Direct conversation/ })).not.toBeInTheDocument();
    expect(window.openbot.servers.listDirectThreads).not.toHaveBeenCalled();
  });

  it("resizes and persists the left and right side panels", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const leftResizer = screen.getByRole("separator", { name: "Resize left sidebar" });
    await fireEvent.keyDown(leftResizer, { key: "ArrowRight" });
    expect(leftResizer).toHaveAttribute("aria-valuenow", "292");
    expect(window.localStorage.getItem("openbot:left-panel-width")).toBe("292");

    await fireEvent.keyDown(leftResizer, { key: "Home" });
    expect(leftResizer).toHaveAttribute("aria-valuenow", "88");
    expect(leftResizer).toHaveAttribute("aria-valuetext", "Compact (88px)");
    expect(window.localStorage.getItem("openbot:left-panel-width")).toBe("292");

    await fireEvent.keyDown(leftResizer, { key: "ArrowRight" });
    expect(leftResizer).toHaveAttribute("aria-valuenow", "240");
    await fireEvent.keyDown(leftResizer, { key: "End" });
    expect(leftResizer).toHaveAttribute("aria-valuenow", "400");
    await fireEvent.dblClick(leftResizer);
    expect(leftResizer).toHaveAttribute("aria-valuenow", "280");

    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const rightResizer = await screen.findByRole("separator", { name: "Resize right panel" });
    await fireEvent.keyDown(rightResizer, { key: "ArrowLeft" });
    expect(rightResizer).toHaveAttribute("aria-valuenow", "308");
    expect(window.localStorage.getItem("openbot:settings-panel-width")).toBe("308");

    await fireEvent.dblClick(rightResizer);
    expect(rightResizer).toHaveAttribute("aria-valuenow", "296");

    await fireEvent.keyDown(rightResizer, { key: "Home" });
    expect(rightResizer).toHaveAttribute("aria-valuenow", "180");
    await fireEvent.keyDown(rightResizer, { key: "End" });
    expect(rightResizer).toHaveAttribute("aria-valuenow", String(Math.min(1600, window.innerWidth - 96)));
  });

  it("opens conversation search with the primary Find shortcut and closes it on Escape", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const searchReturnTarget = screen.getByRole("button", { name: "View agent settings" });
    searchReturnTarget.focus();

    await fireEvent.keyDown(searchReturnTarget, { key: "f", metaKey: true });

    const search = screen.getByRole("search", { name: "Search conversation" });
    const input = screen.getByRole("searchbox", { name: "Search messages" });
    expect(search).toBeVisible();

    await fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "Search conversation" })).not.toBeInTheDocument();
  });

  it("opens global search with Command K and navigates to bot and message results", async () => {
    vi.mocked(window.openbot.agent.searchConversationMessages).mockResolvedValue({
      results: [
        {
          botId: "sales-outbound",
          message: {
            id: "sales-search-result",
            author: "assistant",
            source: "assistant",
            text: "Ask @[Research](agent:research-hidden-id) to use @[Sources](skill:sources-hidden-id).",
            createdAt: "2026-08-20T09:30:00.000Z",
            status: "completed",
          },
        },
      ],
      total: 1,
      nextCursor: null,
    });
    vi.mocked(window.openbot.agent.readConversation).mockImplementation(async (botId) => ({
      botId,
      threadId: null,
      activeTurnId: null,
      revision: 1,
      messages:
        botId === "sales-outbound"
          ? [
              {
                id: "sales-search-result",
                author: "assistant",
                source: "assistant",
                text: "Ask @[Research](agent:research-hidden-id) to use @[Sources](skill:sources-hidden-id).",
                createdAt: "2026-08-20T09:30:00.000Z",
                status: "completed",
              },
            ]
          : [],
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    }));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.keyDown(window, { key: "k", metaKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Search OpenBot" });
    const input = screen.getByRole("combobox", { name: "Search OpenBot" });
    expect(dialog).toBeVisible();

    await fireEvent.click(screen.getByRole("tab", { name: "Messages" }));
    await fireEvent.input(input, { target: { value: "sources-hidden-id" } });
    await screen.findByText("No matching messages or bots");
    await fireEvent.input(input, { target: { value: "research" } });
    const messageResult = await screen.findByRole("option", { name: /Ask @Research to use Sources \(skill\)\./ });
    expect(messageResult).not.toHaveTextContent("research-hidden-id");
    await fireEvent.click(messageResult);
    await screen.findByRole("heading", { name: "Sales Outbound" });
    expect(window.openbot.agent.searchConversationMessages).toHaveBeenCalledWith({
      query: "research",
      limit: 100,
    });
    expect(window.openbot.agent.readConversationPage).toHaveBeenCalledWith({
      botId: "sales-outbound",
      anchor: { type: "around", messageId: "sales-search-result" },
      limit: 50,
    });

    await fireEvent.keyDown(window, { key: "k", metaKey: true });
    await fireEvent.click(screen.getByRole("tab", { name: "Bots" }));
    const botSearch = screen.getByRole("combobox", { name: "Search OpenBot" });
    await fireEvent.input(botSearch, { target: { value: "chief" } });
    await fireEvent.click(await screen.findByRole("option", { name: /Chief/ }));
    await screen.findByRole("heading", { name: "Chief" });
  });

  it("keeps an accessible compact sidebar and expands search without losing its width", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    expect(screen.getByRole("button", { name: "Open Marketplace" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();
    const resizer = screen.getByRole("separator", { name: "Resize left sidebar" });
    await fireEvent.keyDown(resizer, { key: "Home" });

    expect(screen.getByRole("separator", { name: "Resize left sidebar" })).toHaveAttribute("aria-valuenow", "88");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Show sidebar" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");

    const compactAccountButton = await screen.findByRole("button", { name: "Open account menu" });
    await fireEvent.click(compactAccountButton);
    const compactAccountDialog = screen.getByRole("dialog", { name: "Account actions" });
    expect(within(compactAccountDialog).getByRole("button", { name: /Check for updates/ })).toBeInTheDocument();
    expect(within(compactAccountDialog).getByRole("button", { name: "Marketplace" })).toBeInTheDocument();
    expect(within(compactAccountDialog).getByRole("button", { name: "Providers & permissions" })).toBeInTheDocument();
    expect(within(compactAccountDialog).getByRole("button", { name: "Send feedback" })).toBeInTheDocument();
    expect(within(compactAccountDialog).getByRole("button", { name: "Message" })).toBeInTheDocument();
    expect(within(compactAccountDialog).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(within(compactAccountDialog).getByRole("button", { name: "Settings" })).toBeInTheDocument();
    const compactUsageButton = await within(compactAccountDialog).findByRole("button", {
      name: "Weekly usage, 59% left",
    });
    expect(within(compactAccountDialog).queryByRole("button", { name: /photo/i })).not.toBeInTheDocument();
    vi.mocked(window.openbot.agent.getUsage).mockRejectedValueOnce(new Error("Usage service unavailable."));
    const usageRequestsBeforeRefresh = vi.mocked(window.openbot.agent.getUsage).mock.calls.length;
    await fireEvent.click(compactUsageButton);
    await waitFor(() => expect(window.openbot.agent.getUsage).toHaveBeenCalledTimes(usageRequestsBeforeRefresh + 1));
    expect(await within(compactAccountDialog).findByText("Usage service unavailable.")).toBeInTheDocument();
    await fireEvent.keyDown(compactAccountDialog, { key: "Escape" });

    await fireEvent.click(compactAccountButton);
    await fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Account actions" })).getByRole("button", { name: "Settings" }),
    );
    const compactSettingsDialog = await screen.findByRole("dialog", { name: "General" });
    await fireEvent.click(within(compactSettingsDialog).getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());

    await fireEvent.click(screen.getByRole("button", { name: "Expand sidebar and search chats" }));

    expect(screen.getByRole("complementary", { name: "Bot navigation" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize left sidebar" })).toHaveAttribute("aria-valuenow", "280");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "Open Marketplace" })).toBeInTheDocument();
  });

  it("removes a completed Dynamic Island answer without sending it twice", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await waitFor(() => expect(emitDynamicIslandAction).toBeDefined());
    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-island",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        {
          id: "source",
          header: "Choose a source",
          question: "Which source should I use?",
          isSecret: false,
          options: [
            { label: "Official data", description: "Use the public dataset" },
            { label: "Industry report", description: "Use the detailed report" },
          ],
        },
      ],
    });
    await screen.findByText("Which source should I use?");

    emitDynamicIslandAction?.({
      type: "answer-prompt",
      serverId: "local",
      botId: "chief",
      requestId: "prompt-island",
      answers: { source: ["Official data"] },
    });

    await Promise.resolve();

    expect(window.openbot.agent.respondToPrompt).not.toHaveBeenCalled();
    expect(screen.queryByText("Which source should I use?")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Chief" })).toBeVisible();
  });

  it("keeps a Dynamic Island failure until acknowledgement succeeds", async () => {
    vi.mocked(window.openbot.agent.acknowledgeFailedTurn).mockRejectedValueOnce(
      new Error("Acknowledgement unavailable"),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await waitFor(() => expect(emitDynamicIslandAction).toBeDefined());
    emitScopedAgentEvent?.({
      serverId: "local",
      event: {
        type: "turn-completed",
        botId: "chief",
        threadId: "thread-1",
        turnId: "turn-failed",
        status: "failed",
      },
    });
    const action = {
      type: "open-failure",
      serverId: "local",
      botId: "chief",
      turnId: "turn-failed",
    } as const;
    emitDynamicIslandAction?.(action);

    expect(await screen.findByText("Acknowledgement unavailable")).toBeInTheDocument();
    expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
      mode: "failed",
    });
    emitDynamicIslandAction?.(action);
    await waitFor(() => expect(window.openbot.agent.acknowledgeFailedTurn).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "idle",
      }),
    );
  });

  it("marks the selected Dynamic Island message as read after opening it", async () => {
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: "thread-1",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "reply-island",
          author: "assistant",
          text: "The result is ready.",
          createdAt: "2026-08-29T10:42:00.000Z",
          status: "completed",
        },
      ],
      readState: { unreadCount: 1, firstUnreadMessageId: "reply-island", throughMessageId: null },
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await waitFor(() => expect(emitDynamicIslandAction).toBeDefined());

    emitDynamicIslandAction?.({
      type: "open-message",
      serverId: "local",
      botId: "chief",
      messageId: "reply-island",
    });

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "reply-island",
        },
        "local",
      ),
    );
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "idle",
      }),
    );
  });

  it("stops opening a Dynamic Island message when the active server changes", async () => {
    let resolveFocusedPage: ((page: ConversationPage) => void) | undefined;
    vi.mocked(window.openbot.agent.readConversationPage).mockImplementation(async (input) => {
      if (input.anchor?.type === "around") {
        return await new Promise<ConversationPage>((resolve) => {
          resolveFocusedPage = resolve;
        });
      }
      return testConversationPage(input.botId);
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await waitFor(() => expect(emitDynamicIslandAction).toBeDefined());

    emitDynamicIslandAction?.({
      type: "open-message",
      serverId: "local",
      botId: "chief",
      messageId: "reply-island",
    });
    await waitFor(() =>
      expect(window.openbot.agent.readConversationPage).toHaveBeenCalledWith({
        botId: "chief",
        anchor: { type: "around", messageId: "reply-island" },
        limit: 50,
      }),
    );
    emitServers?.([testServer("local", false), testServer("remote-1", true)]);
    await screen.findByRole("button", { name: "Studio Mac server" });
    resolveFocusedPage?.(
      testConversationPage("chief", [
        {
          id: "reply-island",
          author: "assistant",
          text: "The result is ready.",
          createdAt: "2026-08-29T10:42:00.000Z",
          status: "completed",
        },
      ]),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      vi
        .mocked(window.openbot.agent.readConversationPage)
        .mock.calls.filter(([input]) => input.anchor?.type === "latest" && input.limit === 1),
    ).toHaveLength(0);
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
  });

  it("cancels a Dynamic Island action when its server selection is superseded", async () => {
    const local = testServer("local", true);
    const studio = testServer("remote-1", false);
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
    await confirmOnboardingModel();
    await waitFor(() => expect(emitDynamicIslandAction).toBeDefined());

    let resolveStudioBots: ((bots: BotSummary[]) => void) | undefined;
    vi.mocked(window.openbot.agent.listBots)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStudioBots = resolve;
          }),
      )
      .mockResolvedValueOnce([{ ...BOTS[0], name: "Office Chief" }]);
    emitDynamicIslandAction?.({
      type: "open-message",
      serverId: "remote-1",
      botId: "chief",
      messageId: "stale-remote-message",
    });
    await waitFor(() => expect(resolveStudioBots).toBeDefined());
    await fireEvent.click(screen.getByRole("button", { name: "Office PC server" }));
    expect(await screen.findByRole("heading", { name: "Office Chief" })).toBeInTheDocument();

    resolveStudioBots?.([{ ...BOTS[0], name: "Studio Chief" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      vi
        .mocked(window.openbot.agent.readConversationPage)
        .mock.calls.some(
          ([input]) => input.anchor?.type === "around" && input.anchor.messageId === "stale-remote-message",
        ),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Office PC server" })).toHaveAttribute("aria-pressed", "true");
  });

  it("cancels a Dynamic Island action when selection activates another server", async () => {
    const local = testServer("local", true);
    const studio = testServer("remote-1", false);
    const office = { ...testServer("remote-2", false), name: "Office PC", apiUrl: "https://office.example.com" };
    const officeActive = [
      { ...local, active: false },
      { ...studio, active: false },
      { ...office, active: true },
    ];
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, studio, office]);
    vi.mocked(window.openbot.servers.select).mockResolvedValueOnce(officeActive).mockResolvedValueOnce(officeActive);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await waitFor(() => expect(emitDynamicIslandAction).toBeDefined());
    vi.mocked(window.openbot.agent.listBots).mockResolvedValueOnce([{ ...BOTS[0], name: "Office Chief" }]);

    emitDynamicIslandAction?.({
      type: "open-message",
      serverId: "remote-1",
      botId: "chief",
      messageId: "wrong-server-message",
    });

    expect(await screen.findByRole("heading", { name: "Office Chief" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Office PC server" })).toHaveAttribute("aria-pressed", "true");
    expect(window.openbot.servers.select).toHaveBeenNthCalledWith(1, "remote-1");
    expect(window.openbot.servers.select).toHaveBeenNthCalledWith(2, "remote-2");
    expect(
      vi
        .mocked(window.openbot.agent.readConversationPage)
        .mock.calls.some(
          ([input]) => input.anchor?.type === "around" && input.anchor.messageId === "wrong-server-message",
        ),
    ).toBe(false);
  });

  it("discards a chat-open reload that resolves during a server switch", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveOldPage: ((page: ConversationPage) => void) | undefined;
    let resolveRemoteBots: ((bots: BotSummary[]) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockResolvedValueOnce([
      { ...local, active: false },
      { ...remote, active: true },
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    vi.mocked(window.openbot.agent.readConversationPage)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldPage = resolve;
          }),
      )
      .mockResolvedValueOnce(
        testConversationPage(
          "chief",
          [
            {
              id: "reply-new-server",
              author: "assistant",
              text: "Unread reply from the new server",
              createdAt: "2026-08-30T02:05:00.000Z",
              status: "completed",
            },
          ],
          {
            readState: { unreadCount: 1, firstUnreadMessageId: "reply-new-server", throughMessageId: null },
          },
        ),
      );
    vi.mocked(window.openbot.agent.listBots).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemoteBots = resolve;
        }),
    );

    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() => expect(resolveOldPage).toBeDefined());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(resolveRemoteBots).toBeDefined());
    resolveOldPage?.(
      testConversationPage(
        "chief",
        [
          {
            id: "reply-old-server",
            author: "assistant",
            text: "Reply from the old server",
            createdAt: "2026-08-30T02:04:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-old-server", throughMessageId: null },
        },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("Reply from the old server")).not.toBeInTheDocument();
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
    resolveRemoteBots?.(BOTS);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByText("Unread reply from the new server");
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();
  });

  it("rejects a permission approval and keeps the error visible", async () => {
    vi.mocked(window.openbot.agent.respondToApproval).mockRejectedValueOnce(
      new Error("This approval is no longer active."),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "approval",
      approval: {
        requestId: 14,
        botId: "chief",
        threadId: "thread-1",
        turnId: "turn-1",
        kind: "permissions",
        command: null,
        cwd: null,
        reason: "The agent needs access to the project files.",
        grantRoot: null,
        permissions: {
          fileSystem: { read: ["/tmp/project"], write: ["/tmp/project/out"] },
          network: true,
        },
      },
    });

    expect(await screen.findByText("Grant permissions?")).toBeInTheDocument();
    expect(screen.getByText("Network access")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(window.openbot.agent.respondToApproval).toHaveBeenCalledWith({
        requestId: 14,
        decision: "decline",
      }),
    );
    expect(await screen.findByText("This approval is no longer active.")).toBeInTheDocument();
  });

  it("opens the recipient chat from a persistent agent exchange", async () => {
    vi.mocked(window.openbot.agent.readConversation).mockImplementation(async (botId) => ({
      botId,
      threadId: "thread-1",
      activeTurnId: null,
      revision: 1,
      messages:
        botId === "chief"
          ? [
              {
                id: "outbox-message-1",
                author: "system",
                source: "system",
                text: "Prepare report",
                createdAt: new Date().toISOString(),
                status: "completed",
                exchange: {
                  direction: "outgoing",
                  messageId: "message-1",
                  senderBotId: "chief",
                  recipientBotIds: ["sales-outbound"],
                  replyToMessageId: null,
                  deliveries: [
                    {
                      id: "delivery-1",
                      recipientBotId: "sales-outbound",
                      status: "queued",
                      position: 1,
                      error: null,
                    },
                  ],
                },
              },
            ]
          : [],
    }));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    expect(await screen.findByText("Messaged")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Open chat with Sales Outbound" }));
    expect(await screen.findByRole("heading", { name: "Sales Outbound" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Messages with Sales Outbound" })).not.toBeInTheDocument();
  });

  it("shows an incoming agent marker without duplicating raw collaborator input", async () => {
    vi.mocked(window.openbot.agent.readConversation).mockImplementation(async (botId) => ({
      botId,
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      messages:
        botId === "chief"
          ? [
              {
                id: "delivery-reply-1",
                author: "agent",
                source: "agent",
                senderBotId: "sales-outbound",
                text: "RAW_COLLABORATOR_RESULT",
                createdAt: "2026-08-12T10:00:00.000Z",
                status: "completed",
                exchange: {
                  direction: "incoming",
                  messageId: "reply-1",
                  senderBotId: "sales-outbound",
                  recipientBotIds: ["chief"],
                  replyToMessageId: "request-1",
                  deliveries: [
                    {
                      id: "delivery-reply-1",
                      recipientBotId: "chief",
                      status: "completed",
                      position: null,
                      error: null,
                    },
                  ],
                },
              },
              {
                id: "assistant-summary-1",
                author: "assistant",
                text: "Sales Outbound reports that the pipeline is ready.",
                createdAt: "2026-08-12T10:00:01.000Z",
                status: "completed",
              },
            ]
          : [],
    }));

    render(() => <App />);
    expect(await screen.findByRole("button", { name: "Open chat with Sales Outbound" })).toBeInTheDocument();
    expect(screen.queryByText("RAW_COLLABORATOR_RESULT")).not.toBeInTheDocument();
    expect(screen.getByText("Sales Outbound reports that the pipeline is ready.")).toBeInTheDocument();
  });

  it("does not let a late history refresh overwrite a newer streamed snapshot", async () => {
    let resolveHistory: ((snapshot: ConversationSnapshot) => void) | undefined;
    vi.mocked(window.openbot.agent.readConversation).mockImplementation(
      (botId) =>
        new Promise<ConversationSnapshot>((resolve) => {
          resolveHistory = resolve;
          expect(botId).toBe("chief");
        }),
    );

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-live",
        revision: 2,
        messages: [
          {
            id: "live-message",
            author: "assistant",
            text: "Newest streamed answer",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "streaming",
          },
        ],
      },
    });
    expect(await screen.findByText("Newest streamed answer")).toBeInTheDocument();

    resolveHistory?.({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "old-message",
          author: "assistant",
          text: "Stale history answer",
          createdAt: "2026-08-12T09:59:59.000Z",
          status: "completed",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText("Newest streamed answer")).toBeInTheDocument();
      expect(screen.queryByText("Stale history answer")).not.toBeInTheDocument();
    });
  });
});
