import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AttachmentImportEvent,
  BotSummary,
  ConversationSnapshot,
  UpdateStatus,
} from "../../shared/ipc";
import { App } from "./App";

let emitAgentEvent: ((event: AgentEvent) => void) | undefined;
let emitAttachmentImport: ((event: AttachmentImportEvent) => void) | undefined;
let emitUpdateStatus: ((status: UpdateStatus) => void) | undefined;

const BOTS: BotSummary[] = [
  {
    id: "chief",
    name: "Chief",
    role: "Chief of staff",
    description: "Coordinates work",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    avatarShape: "blob",
    avatarColor: "orange",
    threadId: "thread-chief",
    workspacePath: "/tmp/OpenBot/Bots/chief",
    preview: "No messages yet",
    updatedAt: null,
  },
  {
    id: "sales-outbound",
    name: "Sales Outbound",
    role: "Outbound specialist",
    description: "",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    avatarShape: "cloud",
    avatarColor: "violet",
    threadId: null,
    workspacePath: "/tmp/OpenBot/Bots/sales-outbound",
    preview: "No messages yet",
    updatedAt: null,
  },
];

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
    emitAgentEvent = undefined;
    emitAttachmentImport = undefined;
    emitUpdateStatus = undefined;
    window.localStorage.clear();
    Object.defineProperty(window, "openbot", {
      configurable: true,
      value: {
        getAppInfo: vi
          .fn()
          .mockResolvedValue({ name: "OpenBot", version: "0.1.0", platform: "darwin" }),
        getFullAccessConsent: vi.fn().mockResolvedValue(true),
        acceptFullAccessConsent: vi.fn().mockResolvedValue(undefined),
        openExternal: vi.fn().mockResolvedValue(undefined),
        agent: {
          getStatus: vi.fn().mockResolvedValue({
            phase: "ready",
            cliVersion: "0.144.1",
            auth: { kind: "chatgpt", email: "norbert@example.com" },
            capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
            message: null,
            fullAccess: true,
          }),
          getUsage: vi.fn().mockResolvedValue({
            limits: [
              {
                id: "codex",
                primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_786_563_600 },
                secondary: {
                  usedPercent: 41,
                  windowDurationMins: 10_080,
                  resetsAt: 1_787_040_000,
                },
              },
            ],
          }),
          listModels: vi.fn().mockResolvedValue([
            {
              id: "gpt-5.6-luna",
              name: "Luna",
              description: "Fast and efficient for everyday agent work.",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["low", "medium", "high"],
            },
            {
              id: "gpt-5.6-terra",
              name: "Terra",
              description: "Balanced speed and capability for involved tasks.",
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: ["medium", "high"],
            },
            {
              id: "gpt-5.6-sol",
              name: "Sol",
              description: "Most capable for complex, long-running work.",
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: ["medium", "high", "xhigh"],
            },
          ]),
          listBots: vi.fn().mockResolvedValue(BOTS),
          createBot: vi.fn().mockResolvedValue({ ...BOTS[0], id: "bot-new", name: "New agent" }),
          updateBot: vi.fn().mockImplementation(async (input) => ({
            ...BOTS.find((bot) => bot.id === input.botId),
            ...input,
          })),
          deleteBot: vi.fn().mockResolvedValue(undefined),
          readConversation: vi.fn().mockImplementation(async (botId) => ({
            botId,
            threadId: null,
            activeTurnId: null,
            revision: 0,
            messages: [],
          })),
          chooseAttachments: vi.fn().mockResolvedValue([]),
          onAttachmentImport: vi.fn((listener) => {
            emitAttachmentImport = listener;
            return () => undefined;
          }),
          discardDraftAttachment: vi.fn().mockResolvedValue(undefined),
          openAttachment: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue({
            messageId: "message-1",
            deliveries: [
              { id: "delivery-1", recipientBotId: "chief", status: "queued", position: 1 },
            ],
          }),
          setMessageReaction: vi.fn().mockResolvedValue(undefined),
          listQueue: vi
            .fn()
            .mockImplementation(async (botId) => ({ botId, paused: false, deliveries: [] })),
          cancelQueuedMessage: vi.fn().mockResolvedValue(undefined),
          setQueuePaused: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined),
          respondToPrompt: vi.fn().mockResolvedValue(undefined),
          onEvent: vi.fn((listener) => {
            emitAgentEvent = listener;
            return () => undefined;
          }),
        },
        browser: {
          open: vi.fn().mockResolvedValue(undefined),
          activate: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          listTabs: vi.fn().mockResolvedValue([]),
          getControlState: vi.fn().mockResolvedValue({ sessions: [] }),
          setVisible: vi.fn().mockResolvedValue(undefined),
        },
        update: {
          getStatus: vi.fn().mockResolvedValue({
            phase: "idle",
            currentVersion: "0.1.0",
            availableVersion: null,
            progress: null,
            checkedAt: null,
            message: null,
          }),
          check: vi.fn().mockResolvedValue({
            phase: "up-to-date",
            currentVersion: "0.1.0",
            availableVersion: null,
            progress: null,
            checkedAt: "2026-08-12T22:00:00.000Z",
            message: null,
          }),
          download: vi.fn().mockResolvedValue({
            phase: "downloading",
            currentVersion: "0.1.0",
            availableVersion: "0.2.0",
            progress: 0,
            checkedAt: "2026-08-12T22:00:00.000Z",
            message: null,
          }),
          install: vi.fn().mockResolvedValue(undefined),
          onEvent: vi.fn((listener) => {
            emitUpdateStatus = listener;
            return () => undefined;
          }),
        },
        maintenance: {
          exportData: vi.fn().mockResolvedValue({ saved: true }),
          exportDiagnostics: vi.fn().mockResolvedValue({ saved: true }),
        },
      },
    });
  });

  it("requires explicit consent before enabling full-access agents", async () => {
    vi.mocked(window.openbot.getFullAccessConsent).mockResolvedValueOnce(false);
    render(() => <App />);

    expect(
      await screen.findByRole("dialog", { name: "OpenBot agents can control this Mac" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chief" })).not.toBeInTheDocument();

    const acceptButton = screen.getByRole("button", { name: "I understand — enable agents" });
    expect(acceptButton).toHaveFocus();
    await fireEvent.click(acceptButton);
    expect(window.openbot.acceptFullAccessConsent).toHaveBeenCalledOnce();
    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
  });

  it("keeps full-access agents disabled when consent persistence fails", async () => {
    vi.mocked(window.openbot.getFullAccessConsent).mockResolvedValueOnce(false);
    vi.mocked(window.openbot.acceptFullAccessConsent).mockRejectedValueOnce(
      new Error("Could not save consent."),
    );
    render(() => <App />);

    await fireEvent.click(
      await screen.findByRole("button", { name: "I understand — enable agents" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save consent.");
    expect(screen.queryByRole("heading", { name: "Chief" })).not.toBeInTheDocument();
  });

  it("uses the backend bot list and shows local onboarding for a real empty snapshot", async () => {
    render(() => <App />);
    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
    expect(
      await screen.findByRole("listbox", { name: "What do you want me helping with most?" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Salesforce account queue/i)).not.toBeInTheDocument();
  });

  it("guides signed-out users before enabling chat", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: "0.144.1",
      auth: { kind: "signed-out" },
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Run `codex login`, then restart OpenBot.",
      fullAccess: true,
    });
    render(() => <App />);

    expect(await screen.findByText("Codex setup required")).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: /helping with most/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "false");
    fireEvent.click(screen.getByRole("button", { name: "Setup guide" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("codex-setup"));
  });

  it("shows a compact account menu with weekly usage and contact actions", async () => {
    render(() => <App />);
    const accountButton = await screen.findByRole("button", { name: "Open account menu" });
    expect(accountButton).toHaveTextContent("norbert@example.com");

    fireEvent.click(accountButton);
    await waitFor(() => expect(window.openbot.agent.getUsage).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Weekly usage")).toBeInTheDocument();
    expect(screen.getByText("59%")).toBeInTheDocument();
    expect(screen.queryByText(/ChatGPT Pro/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Developer preview/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Lifetime/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Export data" }));
    await waitFor(() => expect(window.openbot.maintenance.exportData).toHaveBeenCalledOnce());
    await waitFor(() => expect(accountButton).toHaveAttribute("aria-expanded", "false"));

    await fireEvent.click(accountButton);
    await screen.findByRole("menuitem", { name: "Export diagnostics" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Export diagnostics" }));
    await waitFor(() =>
      expect(window.openbot.maintenance.exportDiagnostics).toHaveBeenCalledOnce(),
    );
    await waitFor(() => expect(accountButton).toHaveAttribute("aria-expanded", "false"));

    await fireEvent.click(accountButton);
    await screen.findByRole("menuitem", { name: "Send feedback" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send feedback" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("feedback"));

    fireEvent.click(accountButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "Message" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("message"));
  });

  it("shows an available update, downloads it, and exposes restart to install", async () => {
    vi.mocked(window.openbot.update.getStatus).mockResolvedValueOnce({
      phase: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: null,
      checkedAt: "2026-08-12T22:00:00.000Z",
      message: null,
    });
    render(() => <App />);

    expect(await screen.findByText("Update")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Download update/ }));
    await waitFor(() => expect(window.openbot.update.download).toHaveBeenCalledOnce());

    emitUpdateStatus?.({
      phase: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: 100,
      checkedAt: "2026-08-12T22:00:00.000Z",
      message: null,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Restart to update/ }));
    await waitFor(() => expect(window.openbot.update.install).toHaveBeenCalledOnce());
  });

  it("renders loaded history without replaying entrance animations", async () => {
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValueOnce({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "stored-message",
          author: "assistant",
          text: "Already in history",
          createdAt: "2026-08-12T09:00:00.000Z",
          status: "completed",
        },
      ],
    });
    render(() => <App />);
    const stored = await screen.findByText("Already in history");
    expect(stored.closest(".message-entry")).not.toHaveClass("message-entry-animated");
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
    await screen.findByText("Connecting to Codex…");
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

  it("filters and switches backend bots", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("listbox", { name: "What do you want me helping with most?" });
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    await fireEvent.input(search, { target: { value: "Sales" } });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    expect(screen.getByRole("heading", { name: "Sales Outbound" })).toBeInTheDocument();
  });

  it("resizes and persists the left and right side panels", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const leftResizer = screen.getByRole("separator", { name: "Resize left sidebar" });
    await fireEvent.keyDown(leftResizer, { key: "ArrowRight" });
    expect(leftResizer).toHaveAttribute("aria-valuenow", "287");
    expect(leftResizer.closest(".app-frame")).toHaveStyle("--left-panel-width: 287px");
    expect(window.localStorage.getItem("openbot:left-panel-width")).toBe("287");

    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const rightResizer = screen.getByRole("separator", { name: "Resize right panel" });
    await fireEvent.keyDown(rightResizer, { key: "ArrowLeft" });
    expect(rightResizer).toHaveAttribute("aria-valuenow", "308");
    expect(screen.getByRole("main", { name: "Conversation" })).toHaveStyle(
      "--settings-panel-width: 308px",
    );
    expect(window.localStorage.getItem("openbot:settings-panel-width")).toBe("308");

    await fireEvent.dblClick(rightResizer);
    expect(rightResizer).toHaveAttribute("aria-valuenow", "296");
  });

  it("edits the persisted model and thinking level in agent settings", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));

    const model = await screen.findByRole("combobox", { name: "Agent model" });
    const thinking = screen.getByRole("combobox", { name: "Agent thinking level" });
    expect(model).toHaveValue("gpt-5.6-luna");
    expect(thinking).toHaveValue("medium");

    await fireEvent.change(model, { target: { value: "gpt-5.6-sol" } });
    await fireEvent.change(thinking, { target: { value: "xhigh" } });
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenLastCalledWith({
        botId: "chief",
        reasoningEffort: "xhigh",
      }),
    );
  });

  it("does not remount settings or discard an in-progress edit on bot list refresh", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const name = screen.getByRole("textbox", { name: "Agent name" });
    await fireEvent.input(name, { target: { value: "Draft coordinator name" } });

    emitAgentEvent?.({
      type: "bots-changed",
      bots: BOTS.map((bot) =>
        bot.id === "chief" ? { ...bot, preview: "A new backend preview" } : bot,
      ),
    });

    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue(
      "Draft coordinator name",
    );
  });

  it("fully hides and restores the left sidebar without losing its width", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const frame = screen.getByRole("main", { name: "Conversation" }).closest(".app-frame");
    const sidebarToggle = screen.getByRole("button", { name: "Hide sidebar" });
    expect(sidebarToggle).toHaveClass("sidebar-icon-button");
    expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(sidebarToggle);

    expect(screen.queryByRole("complementary", { name: "Bot navigation" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Resize left sidebar" }),
    ).not.toBeInTheDocument();
    expect(frame).toHaveClass("app-frame-sidebar-collapsed");
    expect(frame).toHaveStyle("--left-panel-width: 0px");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("true");
    const restoreSidebar = screen.getByRole("button", { name: "Show sidebar" });
    expect(restoreSidebar).toHaveClass("sidebar-icon-button");
    expect(restoreSidebar).toHaveAttribute("aria-expanded", "false");

    await fireEvent.click(restoreSidebar);

    expect(screen.getByRole("complementary", { name: "Bot navigation" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize left sidebar" })).toHaveAttribute(
      "aria-valuenow",
      "275",
    );
    expect(frame).not.toHaveClass("app-frame-sidebar-collapsed");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("shows a stable indicator while an agent controls the embedded browser", async () => {
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
          ownerBotId: "chief",
        },
        {
          id: "tab-2",
          title: "Second page",
          url: "https://example.com/second",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerBotId: "chief",
        },
        {
          id: "tab-3",
          title: "Third page",
          url: "https://example.com/third",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerBotId: "chief",
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

    const controlledTab = await screen.findByRole("tab", {
      name: "Local smoke page, controlled by Chief",
    });
    expect(controlledTab.closest(".browser-tab-wrap")).toHaveClass("browser-tab-controlled");
    expect(screen.getByRole("complementary", { name: "Browser" })).toHaveClass(
      "browser-panel-controlled",
    );
    const browserTabStrip = document.querySelector(".browser-tab-strip");
    expect(browserTabStrip?.querySelectorAll(".browser-tab-wrap")).toHaveLength(3);
    expect(browserTabStrip?.lastElementChild).toBe(
      screen.getByRole("button", { name: "New browser tab" }),
    );
    expect(screen.queryByRole("button", { name: "Hide browser panel" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(window.openbot.browser.open).toHaveBeenCalledWith({
      url: "https://www.google.com",
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
    });
    expect(screen.queryByText("Typing…")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Chief is controlling the browser" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Chief is controlling the browser" })).toHaveClass(
      "header-panel-toggle",
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
    expect(screen.getByRole("tab", { name: "Local smoke page, controlled by Chief" })).toBe(
      controlledTab,
    );

    emitAgentEvent?.({ type: "browser-control-changed", state: { sessions: [] } });
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Local smoke page, controlled by Chief" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "Local smoke page" })).toBe(controlledTab);
    expect(controlledTab.closest(".browser-tab-wrap")).not.toHaveClass("browser-tab-controlled");
    expect(screen.getByRole("complementary", { name: "Browser" })).not.toHaveClass(
      "browser-panel-controlled",
    );
  });

  it("restores the right panel independently for each agent", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    expect(screen.getByRole("complementary", { name: "Agent settings" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    expect(screen.queryByRole("complementary", { name: "Agent settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open computer" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(screen.getByRole("complementary", { name: "Browser" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(screen.getByRole("complementary", { name: "Agent settings" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    expect(screen.getByRole("complementary", { name: "Browser" })).toBeInTheDocument();
  });

  it("queues from the composer and clears only after success", async () => {
    render(() => <App />);
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Run this Monday";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "Run this Monday",
        attachmentDraftIds: [],
      }),
    );
    await waitFor(() => expect(composer).toHaveTextContent(""));
  });

  it("replies to a message through the composer and keeps the reference in the queued input", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "assistant-1",
            author: "assistant",
            text: "Should I prepare the report?",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    await screen.findByText("Should I prepare the report?");
    await fireEvent.click(screen.getByRole("button", { name: "Reply to Agent message" }));
    expect(screen.getByText("Replying to Agent")).toBeInTheDocument();

    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Yes, today please";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "Yes, today please",
        attachmentDraftIds: [],
        replyToMessageId: "assistant-1",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Replying to Agent")).not.toBeInTheDocument());
  });

  it("reacts and copies from agent hover actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "assistant-actions",
            author: "assistant",
            text: "Ready to ship.",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    await screen.findByText("Ready to ship.");
    await fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    await fireEvent.click(screen.getByRole("menuitemradio", { name: "React with ❤️" }));
    expect(window.openbot.agent.setMessageReaction).toHaveBeenCalledWith({
      botId: "chief",
      messageId: "assistant-actions",
      emoji: "❤️",
    });

    await fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Ready to ship."));
  });

  it("shows agent activity without replaying existing message entrances", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const createdAt = "2026-08-12T10:00:00.000Z";
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "delivery-live",
            author: "user",
            text: "Do the work",
            createdAt,
            status: "completed",
            delivery: { id: "delivery-live", status: "queued", position: 1 },
          },
        ],
      },
    });
    const firstMessage = await screen.findByText("Do the work");
    const firstMessageEntry = firstMessage.closest(".message-entry");
    expect(firstMessageEntry).not.toHaveClass("message-entry-animated");

    emitAgentEvent?.({
      type: "turn-started",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
    });
    const workingIndicator = await screen.findByRole("status", { name: "Chief is working" });

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-live",
        revision: 2,
        messages: [
          {
            id: "delivery-live",
            author: "user",
            text: "Do the work",
            createdAt,
            status: "completed",
            delivery: { id: "delivery-live", status: "running", position: null },
          },
        ],
      },
    });
    expect(screen.getByText("Do the work").closest(".message-entry")).toBe(firstMessageEntry);
    expect(screen.getByText("Do the work").closest(".user-bubble")).not.toHaveTextContent(
      "Working",
    );

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-live",
        revision: 3,
        messages: [
          {
            id: "delivery-live",
            author: "user",
            text: "Do the work",
            createdAt,
            status: "completed",
            delivery: { id: "delivery-live", status: "running", position: null },
          },
          {
            id: "assistant-live",
            author: "assistant",
            text: "I am on it",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "streaming",
          },
        ],
      },
    });
    const streamingAnswer = await screen.findByText("I am on it");
    const streamingBubble = streamingAnswer.closest(".bot-bubble");
    expect(streamingAnswer.closest(".message-entry")).toHaveClass("message-entry-animated");
    expect(streamingBubble).toHaveClass("bot-bubble-streaming");
    expect(screen.queryByText("Typing…")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Chief is working" })).toBe(workingIndicator);

    emitAgentEvent?.({
      type: "conversation-delta",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      messageId: "assistant-live",
      delta: " now",
      createdAt: "2026-08-12T10:00:01.000Z",
      revision: 4,
    });
    const updatedStreamingAnswer = await screen.findByText("I am on it now");
    expect(updatedStreamingAnswer.closest(".bot-bubble")).toBe(streamingBubble);
    expect(screen.getByText("Do the work").closest(".message-entry")).toBe(firstMessageEntry);
    expect(screen.getByRole("status", { name: "Chief is working" })).toBe(workingIndicator);

    for (const [revision, text] of [
      [5, "I am on it now, first buffered delta"],
      [6, "I am on it now, final buffered delta"],
    ] as const) {
      emitAgentEvent?.({
        type: "conversation",
        snapshot: {
          botId: "chief",
          threadId: "thread-chief",
          activeTurnId: "turn-live",
          revision,
          messages: [
            {
              id: "delivery-live",
              author: "user",
              text: "Do the work",
              createdAt,
              status: "completed",
              delivery: { id: "delivery-live", status: "running", position: null },
            },
            {
              id: "assistant-live",
              author: "assistant",
              text,
              createdAt: "2026-08-12T10:00:01.000Z",
              status: "streaming",
            },
          ],
        },
      });
    }
    const bufferedAnswer = await screen.findByText("I am on it now, final buffered delta");
    expect(bufferedAnswer.closest(".bot-bubble")).toBe(streamingBubble);
    expect(screen.queryByText("I am on it now, first buffered delta")).not.toBeInTheDocument();

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      status: "completed",
    });
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Chief is working" })).not.toBeInTheDocument(),
    );
    expect(document.querySelector(".agent-activity-entry")).toBe(workingIndicator);
    expect(workingIndicator).toHaveAttribute("aria-hidden", "true");
  });

  it("groups commentary into a collapsed thinking disclosure", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "user-open",
            turnId: "turn-open",
            author: "user",
            text: "Open x.com",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
          {
            id: "commentary-open",
            turnId: "turn-open",
            author: "assistant",
            text: "I’ll open x.com in the OpenBot browser.",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "completed",
            itemType: "commentary",
          },
          {
            id: "commentary-check",
            turnId: "turn-open",
            author: "assistant",
            text: "Checking that the page loaded.",
            createdAt: "2026-08-12T10:00:02.000Z",
            status: "completed",
            itemType: "commentary",
          },
          {
            id: "answer-open",
            turnId: "turn-open",
            author: "assistant",
            text: "Opened x.com.",
            createdAt: "2026-08-12T10:00:03.000Z",
            status: "completed",
            itemType: "final_answer",
          },
        ],
      },
    });

    const thinkingLabel = await screen.findByText("Thinking");
    const details = thinkingLabel.closest("details");
    expect(screen.getByText("I’ll open x.com in the OpenBot browser.")).not.toBeVisible();
    expect(screen.getByText("Checking that the page loaded.")).not.toBeVisible();
    expect(screen.getByText("Opened x.com.")).toBeVisible();
    expect(screen.getAllByText("Thinking")).toHaveLength(1);

    await fireEvent.click(thinkingLabel);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("I’ll open x.com in the OpenBot browser.")).toBeVisible();

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 2,
        messages: [
          {
            id: "user-open",
            turnId: "turn-open",
            author: "user",
            text: "Open x.com",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
          {
            id: "answer-open",
            turnId: "turn-open",
            author: "assistant",
            text: "Opened x.com.",
            createdAt: "2026-08-12T10:00:03.000Z",
            status: "completed",
            itemType: "final_answer",
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByText("Thinking").closest("details")).toBe(details));
    expect(screen.getByText("I’ll open x.com in the OpenBot browser.")).toBeVisible();
  });

  it("keeps text and attachments when enqueue fails", async () => {
    vi.mocked(window.openbot.agent.sendMessage).mockRejectedValueOnce(
      new Error("Mailbox unavailable"),
    );
    render(() => <App />);
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Retry me";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText("Mailbox unavailable")).toBeInTheDocument();
    expect(composer).toHaveTextContent("Retry me");
  });

  it("supports picker and attachment-only messages", async () => {
    vi.mocked(window.openbot.agent.chooseAttachments).mockResolvedValueOnce([
      attachment("draft-1", "brief.pdf", "pdf"),
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "Attach a file" }));
    await fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "",
        attachmentDraftIds: ["draft-1"],
      }),
    );
  });

  it("adds pathless pasted images reported by preload", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAttachmentImport?.({ type: "started", requestId: "paste-1" });
    emitAttachmentImport?.({
      type: "completed",
      requestId: "paste-1",
      attachments: [attachment("pasted-1", "pasted.png", "image")],
    });
    expect(await screen.findByText("pasted.png")).toBeInTheDocument();
  });

  it("keeps an asynchronous pasted attachment with the bot that received the paste", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAttachmentImport?.({ type: "started", requestId: "paste-switch" });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    emitAttachmentImport?.({
      type: "completed",
      requestId: "paste-switch",
      attachments: [attachment("pasted-switch", "for-chief.png", "image")],
    });

    expect(screen.queryByText("for-chief.png")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(await screen.findByText("for-chief.png")).toBeInTheDocument();
  });

  it("shows and controls queued work", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        paused: true,
        deliveries: [
          {
            id: "delivery-1",
            messageId: "message-1",
            recipientBotId: "chief",
            sender: { kind: "user" },
            text: "Later",
            attachments: [],
            replyToMessageId: null,
            status: "queued",
            position: 1,
            turnId: null,
            error: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Resume queue" }));
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        paused: true,
        deliveries: [
          {
            id: "delivery-1",
            messageId: "message-1",
            recipientBotId: "chief",
            sender: { kind: "user" },
            text: "Later",
            attachments: [],
            replyToMessageId: null,
            status: "queued",
            position: 1,
            turnId: null,
            error: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Cancel queued message 1" }));
    expect(window.openbot.agent.cancelQueuedMessage).toHaveBeenCalled();
    expect(window.openbot.agent.setQueuePaused).toHaveBeenCalledWith({
      botId: "chief",
      paused: false,
    });
  });

  it("persists the onboarding focus before queuing the first user message", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("listbox", { name: "What do you want me helping with most?" });
    await fireEvent.click(screen.getByRole("option", { name: /Work & projects/ }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        role: "Work & projects",
        description:
          "Helps plan, organize, and execute ongoing work and projects while keeping priorities, next steps, and deliverables clear.",
      }),
    );
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "Focus on my work and projects. Help me plan, organize, and execute them proactively.",
        attachmentDraftIds: [],
      }),
    );
    expect(vi.mocked(window.openbot.agent.updateBot).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.openbot.agent.sendMessage).mock.invocationCallOrder[0] ?? Number.MAX_VALUE,
    );
  });

  it("uses a custom onboarding answer as the persistent agent remit", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(await screen.findByRole("option", { name: /Something else/ }));
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();

    const customAnswer = screen.getByRole("textbox", { name: "Custom answer" });
    expect(customAnswer).toHaveFocus();
    await fireEvent.input(customAnswer, { target: { value: "Plan product launches" } });
    await fireEvent.keyDown(customAnswer, { key: "Enter" });

    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        role: "Plan product launches",
        description: "Primary focus: Plan product launches.",
      }),
    );
    expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
      botId: "chief",
      text: "My main focus for you is: Plan product launches. Treat this as your ongoing specialty.",
      attachmentDraftIds: [],
    });
  });

  it("answers model prompts from a separate card while composer remains a queue", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("listbox", { name: "What do you want me helping with most?" });
    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-1",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        {
          id: "account",
          header: "Account",
          question: "Which account?",
          isSecret: false,
          options: null,
        },
      ],
    });
    const answer = await screen.findByRole("textbox", { name: "Account" });
    await fireEvent.input(answer, { target: { value: "Acme" } });
    await fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() =>
      expect(window.openbot.agent.respondToPrompt).toHaveBeenCalledWith({
        requestId: "prompt-1",
        answers: { account: ["Acme"] },
      }),
    );
  });

  it("renders persistent outgoing and incoming agent exchanges", async () => {
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
    expect(
      screen.getByRole("button", { name: "Open exchange with Sales Outbound" }),
    ).toBeInTheDocument();
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
    expect(
      await screen.findByRole("button", { name: "Open exchange with Sales Outbound" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("RAW_COLLABORATOR_RESULT")).not.toBeInTheDocument();
    expect(
      screen.getByText("Sales Outbound reports that the pipeline is ready."),
    ).toBeInTheDocument();
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

  it("persists settings and opens managed attachment actions", async () => {
    render(() => <App />);
    await fireEvent.click(await screen.findByRole("button", { name: "View agent settings" }));
    await screen.findByRole("listbox", { name: "What do you want me helping with most?" });
    const name = screen.getByRole("textbox", { name: "Agent name" });
    await fireEvent.input(name, { target: { value: "Coordinator" } });
    await fireEvent.blur(name);
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        name: "Coordinator",
      }),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Close details" }));

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: null,
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "file-message",
            author: "user",
            text: "",
            createdAt: new Date().toISOString(),
            status: "completed",
            attachments: [attachment("file-1", "brief.pdf", "pdf")],
          },
        ],
      },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Preview brief.pdf" }));
    expect(screen.getByRole("dialog", { name: "brief.pdf" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(window.openbot.agent.openAttachment).toHaveBeenCalledWith({
      attachmentId: "file-1",
      action: "reveal",
    });
  });

  it("opens bot actions on right click and edits the selected agent", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.contextMenu(screen.getByRole("button", { name: /Sales Outbound/ }), {
      clientX: 120,
      clientY: 90,
    });
    await fireEvent.click(screen.getByRole("menuitem", { name: "Edit agent" }));
    expect(await screen.findByRole("heading", { name: "Sales Outbound" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Agent settings" })).toBeInTheDocument();
  });

  it("confirms and persistently deletes a bot from its context menu", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const sales = screen.getByRole("button", { name: /Sales Outbound/ });
    await fireEvent.contextMenu(sales, { clientX: 120, clientY: 90 });
    await fireEvent.click(screen.getByRole("menuitem", { name: "Delete agent" }));
    expect(screen.getByRole("alertdialog", { name: "Delete Sales Outbound?" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(window.openbot.agent.deleteBot).toHaveBeenCalledWith("sales-outbound"),
    );
    await waitFor(() => expect(sales).not.toBeInTheDocument());
  });
});

function attachment(id: string, name: string, kind: "image" | "pdf") {
  return {
    id,
    name,
    size: 2048,
    kind: kind === "image" ? ("image" as const) : ("file" as const),
    mimeType: kind === "image" ? "image/png" : "application/pdf",
    previewKind: kind,
    previewUrl: `openbot-attachment://file/${id}`,
  };
}
