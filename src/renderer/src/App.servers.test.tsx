import type { AgentEvent, ConversationMessage, ServerSummary } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import {
  attachment,
  BOTS,
  confirmOnboardingModel,
  emitAgentEvent,
  emitDynamicIslandAction,
  emitScopedAgentEvent,
  emitServers,
  installOpenbotStub,
  queuedDelivery,
  subscriberCounts,
  testServer,
} from "./app-test-harness";
import { TestResizeObserver } from "./setupTests";
import { SIDEBAR_PINS_STORAGE_KEY } from "./sidebar-pins";

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
    installOpenbotStub();
  });

  it("restores the active server before loading its workspace data", async () => {
    let resolveServers: ((servers: ServerSummary[]) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockReturnValueOnce(
      new Promise<ServerSummary[]>((resolve) => {
        resolveServers = resolve;
      }),
    );
    vi.mocked(window.openbot.agent.listBots).mockResolvedValueOnce([{ ...BOTS[0], name: "Remote Chief" }]);

    render(() => <App />);
    await waitFor(() => expect(window.openbot.servers.list).toHaveBeenCalledOnce());
    expect(window.openbot.agent.listBots).not.toHaveBeenCalled();

    resolveServers?.([
      {
        id: "local",
        name: "Local",
        logoUrl: null,
        kind: "local",
        state: "online",
        apiUrl: null,
        remoteDesktopAvailable: false,
        role: null,
        active: false,
      },
      {
        id: "remote-1",
        name: "Studio Mac",
        logoUrl: null,
        kind: "remote",
        state: "online",
        apiUrl: "https://studio.example.com",
        remoteDesktopAvailable: false,
        role: "member",
        active: true,
      },
    ]);

    expect(await screen.findByRole("heading", { name: "Remote Chief" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true");
  });

  it("blocks an incompatible remote workspace and offers a manual retry", async () => {
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([
      { ...testServer("local", false) },
      {
        ...testServer("remote-1", true),
        state: "incompatible",
        compatibility: {
          localAppVersion: "0.4.0",
          hostAppVersion: "0.2.0",
          localProtocol: { minimum: 2, maximum: 2 },
          hostProtocol: { minimum: 1, maximum: 1 },
          negotiatedProtocol: null,
          capabilities: [],
        },
        issue: {
          code: "host_update_required",
          message: "Update OpenBot on the host.",
          retryable: true,
        },
      },
    ]);

    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Update OpenBot on Studio Mac" })).toBeInTheDocument();
    expect(window.openbot.agent.listBots).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(window.openbot.servers.retryConnection).toHaveBeenCalledWith("remote-1"));
  });

  it("keeps a newer online event when retry returns an older summary", async () => {
    const local = testServer("local", false);
    const incompatible: ServerSummary = {
      ...testServer("remote-1", true),
      state: "incompatible",
      compatibility: {
        localAppVersion: "0.4.0",
        hostAppVersion: "0.4.0",
        localProtocol: { minimum: 2, maximum: 2 },
        hostProtocol: { minimum: 1, maximum: 1 },
        negotiatedProtocol: null,
        capabilities: [],
      },
      issue: { code: "host_update_required", message: "Update OpenBot on the host.", retryable: true },
    };
    const online: ServerSummary = {
      ...incompatible,
      state: "online",
      issue: null,
      compatibility: {
        localAppVersion: "0.4.0",
        hostAppVersion: "0.4.0",
        localProtocol: { minimum: 1, maximum: 1 },
        hostProtocol: { minimum: 1, maximum: 1 },
        negotiatedProtocol: 1,
        capabilities: [],
      },
      connectionSequence: 1,
    };
    let resolveRetry: ((server: ServerSummary) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, incompatible]);
    vi.mocked(window.openbot.servers.retryConnection).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRetry = resolve;
      }),
    );
    vi.mocked(window.openbot.servers.select).mockRejectedValueOnce(new Error("Workspace refresh failed"));

    render(() => <App />);
    await screen.findByRole("heading", { name: "Update OpenBot on Studio Mac" });
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    emitServers?.([local, online]);
    resolveRetry?.({ ...online, state: "connecting" });

    await waitFor(() => expect(screen.getByRole("button", { name: "Studio Mac server" })).toBeInTheDocument());
  });

  it("shows a version warning after every compatible remote connection", async () => {
    const local = testServer("local", true);
    const remote: ServerSummary = {
      ...testServer("remote-1", false),
      compatibility: {
        localAppVersion: "0.4.0",
        hostAppVersion: "0.3.0",
        localProtocol: { minimum: 1, maximum: 1 },
        hostProtocol: { minimum: 1, maximum: 1 },
        negotiatedProtocol: 1,
        capabilities: [],
      },
      connectionSequence: 0,
    };
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitServers?.([local, { ...remote, connectionSequence: 1 }]);
    expect(await screen.findByText("Different OpenBot versions on Studio Mac")).toBeInTheDocument();
    emitServers?.([local, { ...remote, connectionSequence: 2 }]);
    await waitFor(() => expect(screen.getAllByText("Different OpenBot versions on Studio Mac")).toHaveLength(2));
  });

  it("loads capability-gated state when a provisional handshake becomes ready", async () => {
    const local = testServer("local", false);
    const provisional: ServerSummary = {
      ...testServer("remote-1", true),
      state: "connecting",
      compatibility: {
        localAppVersion: "0.4.0",
        hostAppVersion: null,
        localProtocol: { minimum: 1, maximum: 1 },
        hostProtocol: null,
        negotiatedProtocol: null,
        capabilities: [],
      },
      connectionSequence: 0,
    };
    const negotiated: ServerSummary = {
      ...provisional,
      state: "online",
      compatibility: {
        localAppVersion: "0.4.0",
        hostAppVersion: "0.4.0",
        localProtocol: { minimum: 1, maximum: 1 },
        hostProtocol: { minimum: 1, maximum: 1 },
        negotiatedProtocol: 1,
        capabilities: ["browser-control", "sidebar-layout"],
      },
      connectionSequence: 1,
    };
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, provisional]);

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    expect(window.openbot.agent.getSidebarLayout).not.toHaveBeenCalled();
    expect(window.openbot.browser.listTabs).not.toHaveBeenCalled();

    emitServers?.([local, negotiated]);
    await waitFor(() => expect(window.openbot.agent.getSidebarLayout).toHaveBeenCalled());
    expect(window.openbot.browser.listTabs).toHaveBeenCalled();
    // The server was already active, so the workspace reloads by remounting on
    // the completed handshake. Nothing asks main to select it a second time.
    expect(window.openbot.servers.select).not.toHaveBeenCalled();
  });

  it("keeps a remote approval when Review in OpenBot switches to its host", async () => {
    const servers: ServerSummary[] = [
      {
        id: "local",
        name: "Local",
        logoUrl: null,
        kind: "local",
        state: "online",
        apiUrl: null,
        remoteDesktopAvailable: false,
        role: null,
        active: true,
      },
      {
        id: "remote-1",
        name: "Studio Mac",
        logoUrl: null,
        kind: "remote",
        state: "online",
        apiUrl: "https://studio.example.com",
        remoteDesktopAvailable: false,
        role: "member",
        active: false,
      },
    ];
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce(servers);
    vi.mocked(window.openbot.servers.select).mockResolvedValueOnce(
      servers.map((server) => ({ ...server, active: server.id === "remote-1" })),
    );

    render(() => <App />);
    await waitFor(() => expect(emitScopedAgentEvent).toBeTypeOf("function"));
    emitScopedAgentEvent?.({ serverId: "remote-1", event: { type: "bots-changed", bots: BOTS } });
    emitScopedAgentEvent?.({
      serverId: "remote-1",
      event: {
        type: "approval",
        approval: {
          requestId: "approval-remote",
          botId: "chief",
          threadId: "thread-chief",
          turnId: "turn-remote",
          kind: "permissions",
          command: null,
          cwd: null,
          reason: "Review remote access.",
          grantRoot: null,
          permissions: { fileSystem: { read: ["/workspace"], write: [] }, network: false },
        },
      },
    });
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        serverId: "remote-1",
        mode: "approval",
        item: { requestId: "approval-remote" },
      }),
    );

    const presentationCountBeforeReview = vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.length;
    emitDynamicIslandAction?.({
      type: "review-attention",
      serverId: "remote-1",
      botId: "chief",
      requestId: "approval-remote",
    });
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-1"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(window.openbot.dynamicIsland.publishPresentation)
          .mock.calls.slice(presentationCountBeforeReview)
          .some(
            ([presentation]) =>
              presentation.serverId === "remote-1" &&
              presentation.mode === "approval" &&
              presentation.item.requestId === "approval-remote",
          ),
      ).toBe(true),
    );

    emitDynamicIslandAction?.({
      type: "respond-approval",
      serverId: "remote-1",
      botId: "chief",
      requestId: "approval-remote",
      decision: "accept",
    });
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        serverId: "remote-1",
        mode: "idle",
      }),
    );
  });

  it("removes stale Dynamic Island attention when a remote host goes offline", async () => {
    const local: ServerSummary = {
      id: "local",
      name: "Local",
      logoUrl: null,
      kind: "local",
      state: "online",
      apiUrl: null,
      remoteDesktopAvailable: false,
      role: null,
      active: true,
    };
    const remote: ServerSummary = {
      id: "remote-1",
      name: "Studio Mac",
      logoUrl: null,
      kind: "remote",
      state: "online",
      apiUrl: "https://studio.example.com",
      remoteDesktopAvailable: false,
      role: "member",
      active: false,
    };
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);

    render(() => <App />);
    await waitFor(() => expect(emitScopedAgentEvent).toBeTypeOf("function"));
    emitScopedAgentEvent?.({ serverId: remote.id, event: { type: "bots-changed", bots: BOTS } });
    emitScopedAgentEvent?.({
      serverId: remote.id,
      event: {
        type: "approval",
        approval: {
          requestId: "stale-approval",
          botId: "chief",
          threadId: "thread-chief",
          turnId: "turn-remote",
          kind: "permissions",
          command: null,
          cwd: null,
          reason: "Review remote access.",
          grantRoot: null,
          permissions: { fileSystem: { read: ["/workspace"], write: [] }, network: false },
        },
      },
    });
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        serverId: remote.id,
        mode: "approval",
      }),
    );

    emitServers?.([local, { ...remote, state: "offline" }]);
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        serverId: "local",
        mode: "idle",
      }),
    );
  });

  it("reports a remote reply that arrives while its host is offline", async () => {
    const local: ServerSummary = {
      id: "local",
      name: "Local",
      logoUrl: null,
      kind: "local",
      state: "online",
      apiUrl: null,
      remoteDesktopAvailable: false,
      role: null,
      active: true,
    };
    const remote: ServerSummary = {
      id: "remote-1",
      name: "Studio Mac",
      logoUrl: null,
      kind: "remote",
      state: "online",
      apiUrl: "https://studio.example.com",
      remoteDesktopAvailable: false,
      role: "member",
      active: false,
    };
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    const snapshot = (messageId: string, text: string) => ({
      type: "runtime-snapshot" as const,
      snapshot: {
        bots: [
          {
            id: "chief",
            name: "Chief",
            notifications: true,
            preview: "",
            updatedAt: null,
            avatarSeed: "chief",
            avatarHue: null,
            avatarUrl: null,
          },
        ],
        activeTurns: [],
        work: [],
        latestMessages: [{ botId: "chief", id: messageId, text, createdAt: "2026-08-29T10:00:00.000Z" }],
        attentionComplete: true,
        pendingPrompts: [],
        pendingApprovals: [],
        pendingBrowserTakeovers: [],
        failedTurns: [],
      },
    });

    render(() => <App />);
    await waitFor(() => expect(emitScopedAgentEvent).toBeTypeOf("function"));
    emitScopedAgentEvent?.({ serverId: remote.id, event: snapshot("reply-old", "Earlier reply") });
    emitServers?.([local, { ...remote, state: "offline" }]);
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        serverId: "local",
        mode: "idle",
      }),
    );

    emitServers?.([local, remote]);
    emitScopedAgentEvent?.({ serverId: remote.id, event: snapshot("reply-new", "Reply from offline work") });

    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        serverId: remote.id,
        mode: "message",
        unreadCount: 1,
        message: { messageId: "reply-new", text: "Reply from offline work" },
      }),
    );
  });

  it("preserves omitted attention only when a compact runtime snapshot is incomplete", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await waitFor(() => expect(window.openbot.agent.listQueue).toHaveBeenCalledWith("chief"));

    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        deliveries: [
          queuedDelivery("delivery-running", "Keep the full queue", null, {
            status: "running",
            turnId: "turn-running",
          }),
        ],
      },
    });
    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-authoritative",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-running",
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which scope?",
          isSecret: false,
          options: null,
        },
      ],
    });

    expect(await screen.findByRole("status", { name: "Chief is working" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Custom answer for: Which scope?" })).toBeInTheDocument();

    const runtimeSnapshot: AgentEvent = {
      type: "runtime-snapshot",
      snapshot: {
        bots: [],
        activeTurns: [{ botId: "chief", threadId: "thread-chief", turnId: "turn-running" }],
        work: [],
        latestMessages: [],
        attentionComplete: false,
        pendingPrompts: [],
        pendingApprovals: [],
        pendingBrowserTakeovers: [],
        failedTurns: [],
      },
    };
    emitAgentEvent?.(runtimeSnapshot);

    expect(screen.getByRole("status", { name: "Chief is working" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Custom answer for: Which scope?" })).toBeInTheDocument();

    emitAgentEvent?.({
      ...runtimeSnapshot,
      snapshot: { ...runtimeSnapshot.snapshot, activeTurns: [], attentionComplete: true },
    });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Custom answer for: Which scope?" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "Chief is working" })).not.toBeInTheDocument());
  });

  it("shows live provider-neutral progress and streamed commentary while an agent works", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();

    const conversation = (revision: number, activeTurnId: string | null, messages: ConversationMessage[]) => ({
      type: "conversation" as const,
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId,
        revision,
        messages,
      },
    });
    const userMessage = {
      id: "user-live-status",
      turnId: "turn-live-status",
      author: "user",
      text: "Check the release status",
      createdAt: "2026-09-02T10:00:00.000Z",
      status: "completed",
    } satisfies ConversationMessage;

    emitAgentEvent?.(conversation(1, "turn-live-status", [userMessage]));
    expect(await screen.findByRole("status", { name: "Chief is working" })).toBeInTheDocument();

    emitAgentEvent?.({
      type: "turn-progress",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live-status",
      detail: "Searching for current information…",
    });
    expect(
      await within(screen.getByRole("region", { name: "Current activity" })).findByText(
        "Searching for current information…",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show thinking details" })).not.toBeInTheDocument();

    const firstCommentary = {
      id: "commentary-live-status-1",
      turnId: "turn-live-status",
      author: "assistant",
      text: "Inspecting the release",
      createdAt: "2026-09-02T10:00:01.000Z",
      status: "streaming",
      itemType: "commentary",
    } satisfies ConversationMessage;
    emitAgentEvent?.(conversation(2, "turn-live-status", [userMessage, firstCommentary]));
    emitAgentEvent?.({
      type: "conversation-delta",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live-status",
      messageId: firstCommentary.id,
      delta: " checks",
      createdAt: firstCommentary.createdAt,
      revision: 3,
    });
    expect(
      await within(screen.getByRole("region", { name: "Current activity" })).findByText(
        "Inspecting the release checks",
      ),
    ).toBeInTheDocument();

    const latestCommentary = {
      ...firstCommentary,
      id: "commentary-live-status-2",
      text: "Verifying the final build artifacts",
      createdAt: "2026-09-02T10:00:02.000Z",
    } satisfies ConversationMessage;
    emitAgentEvent?.(
      conversation(4, "turn-live-status", [
        userMessage,
        { ...firstCommentary, text: "Inspecting the release checks", status: "completed" },
        latestCommentary,
      ]),
    );
    expect(
      await within(screen.getByRole("region", { name: "Current activity" })).findByText(
        "Verifying the final build artifacts",
      ),
    ).toBeInTheDocument();

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live-status",
      status: "completed",
    });
    emitAgentEvent?.(conversation(5, null, [userMessage, { ...firstCommentary, status: "completed" }]));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Chief is working" })).not.toBeInTheDocument());
  });

  it("merges compact runtime attention into the active server", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();

    emitAgentEvent?.({
      type: "runtime-snapshot",
      snapshot: {
        bots: [],
        activeTurns: [],
        work: [],
        latestMessages: [],
        attentionComplete: true,
        pendingPrompts: [],
        pendingApprovals: [
          {
            requestId: "approval-runtime",
            botId: "chief",
            threadId: "thread-chief",
            turnId: "turn-runtime",
            kind: "command",
            command: "bun test",
            truncated: false,
            cwd: null,
            reason: null,
            grantRoot: null,
            permissions: null,
          },
        ],
        pendingBrowserTakeovers: [],
        failedTurns: [],
      },
    });

    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "approval",
        item: { requestId: "approval-runtime" },
      }),
    );

    emitAgentEvent?.({
      type: "agent-input-resolved",
      kind: "approval",
      requestId: "approval-runtime",
      botId: "chief",
    });
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "idle",
      }),
    );
  });

  it("opens, hides, resumes, and disconnects Remote Control from the header", async () => {
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([
      {
        id: "remote-1",
        name: "Studio Mac",
        logoUrl: null,
        kind: "remote",
        state: "online",
        apiUrl: "https://studio-mac-k7m4q2pz-host.openbot.run",
        remoteDesktopAvailable: true,
        role: "owner",
        active: true,
      },
    ]);
    vi.mocked(window.openbot.remoteDesktop.connect).mockResolvedValueOnce({
      id: "desktop-1",
      serverId: "remote-1",
      viewerUrl: "https://studio-mac-k7m4q2pz-host.openbot.run/v1/remote-screen/sessions/desktop-1/viewer",
      viewerGrant: "viewer-grant",
      displays: [],
      selectedDisplayId: null,
      phase: "connecting",
      transport: "unknown",
      errorCode: null,
      message: "Connecting…",
      createdAt: "2026-08-18T12:00:00.000Z",
      grantExpiresAt: "2026-08-18T12:01:00.000Z",
    });

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    expect(window.openbot.remoteDesktop.connect).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Sunshine remote desktop")).not.toBeInTheDocument();
    const openButton = screen.getByRole("button", { name: "Open remote control" });
    await fireEvent.click(openButton);

    const remoteDesktop = await screen.findByRole("main", { name: "Remote control" });
    const appFrame = document.querySelector<HTMLElement>(".app-frame");
    if (!appFrame) throw new Error("App frame is missing.");
    expect(appFrame.inert).toBe(true);
    expect(appFrame).toHaveAttribute("aria-hidden", "true");
    await waitFor(() => expect(window.openbot.remoteDesktop.connect).toHaveBeenCalledWith({ serverId: "remote-1" }));

    await screen.findByTitle("Sunshine remote desktop");
    await fireEvent.click(within(remoteDesktop).getByRole("button", { name: "Back to OpenBot" }));
    await waitFor(() => expect(appFrame.inert).toBe(false));
    // Hiding keeps the session alive, so resuming must not open a second one.
    expect(window.openbot.remoteDesktop.disconnect).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Resume remote control" }));
    expect(await screen.findByTitle("Sunshine remote desktop")).toBeInTheDocument();
    expect(window.openbot.remoteDesktop.connect).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(window.openbot.remoteDesktop.disconnect).toHaveBeenCalledWith("desktop-1"));
    await waitFor(() => expect(screen.queryByTitle("Sunshine remote desktop")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Open remote control" })).toBeInTheDocument();
  });

  it("disconnects a hidden Remote Control session when the server changes", async () => {
    const servers = [
      {
        id: "remote-1",
        name: "Studio Mac",
        logoUrl: null,
        kind: "remote" as const,
        state: "online" as const,
        apiUrl: "https://studio.example.com",
        remoteDesktopAvailable: true,
        role: "owner" as const,
        active: true,
      },
      {
        id: "remote-2",
        name: "Office PC",
        logoUrl: null,
        kind: "remote" as const,
        state: "online" as const,
        apiUrl: "https://office.example.com",
        remoteDesktopAvailable: true,
        role: "member" as const,
        active: false,
      },
    ];
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce(servers);
    vi.mocked(window.openbot.servers.select).mockResolvedValueOnce(
      servers.map((server) => ({ ...server, active: server.id === "remote-2" })),
    );
    vi.mocked(window.openbot.remoteDesktop.connect).mockResolvedValueOnce({
      id: "desktop-1",
      serverId: "remote-1",
      viewerUrl: "https://studio.example.com/v1/remote-screen/sessions/desktop-1/viewer",
      viewerGrant: "viewer-grant",
      displays: [],
      selectedDisplayId: null,
      phase: "connected",
      transport: "p2p",
      errorCode: null,
      message: "Connected",
      createdAt: "2026-08-18T12:00:00.000Z",
      grantExpiresAt: "2026-08-18T12:01:00.000Z",
    });

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "Open remote control" }));
    const workspace = await screen.findByRole("main", { name: "Remote control" });
    await fireEvent.click(within(workspace).getByRole("button", { name: "Back to OpenBot" }));
    await fireEvent.click(screen.getByRole("button", { name: "Office PC server" }));

    await waitFor(() => expect(window.openbot.remoteDesktop.disconnect).toHaveBeenCalledWith("desktop-1"));
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-2"));
    expect(screen.queryByTitle("Sunshine remote desktop")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Open remote control" })).toBeInTheDocument();
    expect(window.openbot.remoteDesktop.connect).toHaveBeenCalledTimes(1);
  });

  it("tells the server the user is leaving that composing has stopped", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    const calls: string[] = [];
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.setTyping).mockImplementation(async (input) => {
      calls.push(input.typing ? "typing on" : "typing off");
    });
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => {
      calls.push("select");
      return [
        { ...local, active: serverId === "local" },
        { ...remote, active: serverId === "remote-1" },
      ];
    });

    render(() => <App />);
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Half a thought";
    await fireEvent.input(composer);
    await waitFor(() => expect(calls).toEqual(["typing on"]));

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));

    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-1"));
    expect(calls).toEqual(["typing on", "typing off", "select"]);
  });

  it("does not leave the next server's composer disabled by a send in flight", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.agent.sendMessage).mockImplementationOnce(() => new Promise(() => undefined));

    render(() => <App />);
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Still on its way";
    await fireEvent.input(composer);
    await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(window.openbot.agent.sendMessage).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    expect(await screen.findByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("does not offer an answered prompt again after leaving its server and coming back", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();

    const pendingPrompt = {
      requestId: "prompt-across-servers",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-across-servers",
      questions: [{ id: "account", header: "Account", question: "Which account?", isSecret: false, options: null }],
    };
    emitAgentEvent?.({ type: "prompt", ...pendingPrompt });
    const answer = await screen.findByRole("textbox", { name: "Custom answer for: Which account?" });
    await fireEvent.input(answer, { target: { value: "Acme" } });
    await fireEvent.keyDown(answer, { key: "Enter" });
    await waitFor(() => expect(window.openbot.agent.respondToPrompt).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Local server" })).toHaveAttribute("aria-pressed", "true"),
    );
    await screen.findByRole("heading", { name: "Chief" });

    // Nothing has arrived from main yet: this workspace was seeded from what the
    // Dynamic Island coordinator remembered, which is the renderer's own
    // projection and still lists the prompt as pending. The composer is hidden
    // for as long as something is being asked, so its return is what says the
    // scope settled without asking again.
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Custom answer for: Which account?" })).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Message Chief" })).toBeVisible();
    });

    // Main has not seen the answer yet, so its snapshot still reports the prompt
    // as waiting. The answer is what makes it stale, and the answer was given on
    // this server before the switch.
    emitAgentEvent?.({
      type: "runtime-snapshot",
      snapshot: {
        bots: [],
        activeTurns: [],
        work: [],
        latestMessages: [],
        attentionComplete: true,
        pendingPrompts: [pendingPrompt],
        pendingApprovals: [],
        pendingBrowserTakeovers: [],
        failedTurns: [],
      },
    });
    // Delivered to the same listener, after the snapshot: once this message is
    // on screen, the snapshot before it has been applied.
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 30,
        messages: [
          {
            id: "message-after-return",
            author: "assistant",
            text: "Back on Local",
            createdAt: "2026-08-29T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    expect(await screen.findByText("Back on Local")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Custom answer for: Which account?" })).not.toBeInTheDocument();
  });

  it("persists settings and opens managed attachment actions", async () => {
    render(() => <App />);
    await fireEvent.click(await screen.findByRole("button", { name: "View agent settings" }));
    const name = await screen.findByRole("textbox", { name: "Agent name" });
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

  it("duplicates an agent from its context menu and opens its empty conversation", async () => {
    localStorage.setItem(
      SIDEBAR_PINS_STORAGE_KEY,
      JSON.stringify({ local: [{ kind: "agent", id: "sales-outbound" }] }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.contextMenu(screen.getByRole("button", { name: "Sales Outbound, pinned agent" }), {
      clientX: 120,
      clientY: 90,
    });

    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Duplicate agent" }), { button: 0 });

    await waitFor(() => expect(window.openbot.agent.duplicateBot).toHaveBeenCalledWith("sales-outbound"));
    expect(await screen.findByRole("heading", { name: "Sales Outbound copy" })).toBeInTheDocument();
    await waitFor(() => expect(window.openbot.agent.readConversation).toHaveBeenCalledWith("sales-outbound-copy"));
    expect(
      within(screen.getByRole("region", { name: "Pinned chats" })).queryByRole("button", {
        name: /Sales Outbound copy/,
      }),
    ).not.toBeInTheDocument();
  });

  it("keeps the current selection and shows an error when duplication fails", async () => {
    vi.mocked(window.openbot.agent.duplicateBot).mockRejectedValueOnce(new Error("The agent is busy."));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.contextMenu(screen.getByRole("button", { name: /Sales Outbound/ }), {
      clientX: 120,
      clientY: 90,
    });

    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Duplicate agent" }), { button: 0 });

    expect(await screen.findByText("Could not duplicate agent")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Chief" })).toBeInTheDocument();
  });

  it("confirms and persistently deletes a bot from its context menu", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const sales = screen.getByRole("button", { name: /Sales Outbound/ });
    await fireEvent.contextMenu(sales, { clientX: 120, clientY: 90 });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Delete agent" }), { button: 0 });
    expect(screen.getByRole("alertdialog", { name: "Delete Sales Outbound?" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(window.openbot.agent.deleteBot).toHaveBeenCalledWith("sales-outbound"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Sales Outbound/ })).not.toBeInTheDocument());
  });

  it("shows the server rail and opens the join flow", async () => {
    render(() => <App />);
    expect(await screen.findByRole("complementary", { name: "Servers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings for Local" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Add remote server" }));
    expect(await screen.findByRole("dialog", { name: "Join a server" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Invite link" })).toBeInTheDocument();
  });

  it("opens settings for the clicked server without selecting it", async () => {
    const remote = {
      id: "studio",
      name: "Design studio",
      logoUrl: null,
      kind: "remote" as const,
      state: "online" as const,
      apiUrl: "https://studio.example.com",
      remoteDesktopAvailable: true,
      role: "admin" as const,
      active: false,
    };
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([
      {
        id: "local",
        name: "Local",
        logoUrl: null,
        kind: "local",
        state: "online",
        apiUrl: null,
        remoteDesktopAvailable: false,
        role: null,
        active: true,
      },
      remote,
    ]);
    vi.mocked(window.openbot.servers.refreshIdentity).mockResolvedValueOnce(remote);
    vi.mocked(window.openbot.servers.getPresenceFor).mockResolvedValueOnce({
      serverId: remote.id,
      members: [],
      updatedAt: "2026-08-20T10:00:00.000Z",
    });

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const remoteButton = screen.getByRole("button", { name: "Design studio server" });
    await fireEvent.contextMenu(remoteButton, { clientX: 32, clientY: 120 });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Server settings" }), { button: 0 });

    expect(await screen.findByRole("dialog", { name: "General" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Server name" })).not.toBeInTheDocument();
    expect(window.openbot.servers.select).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Close server settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
  });

  it("keeps the local server name draft during server list updates", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.contextMenu(screen.getByRole("button", { name: "Local server" }), {
      clientX: 32,
      clientY: 80,
    });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Server settings" }), { button: 0 });

    const name = screen.getByRole("textbox", { name: "Server name" });
    name.focus();
    let draft = "";
    for (const character of "Design") {
      draft += character;
      await fireEvent.input(name, { target: { value: draft } });
      emitServers?.([
        {
          id: "local",
          name: "Local",
          logoUrl: null,
          kind: "local",
          state: "online",
          apiUrl: null,
          remoteDesktopAvailable: false,
          role: null,
          active: true,
        },
      ]);
      expect(name).toHaveValue(draft);
    }

    expect(screen.getByRole("textbox", { name: "Server name" })).toBe(name);
    expect(name).toHaveValue("Design");
  });

  it("retries failed installed skill loading after a remote reconnect", async () => {
    const local = testServer("local", false);
    const remote: ServerSummary = {
      ...testServer("remote-1", true),
      compatibility: {
        localAppVersion: "0.4.0",
        hostAppVersion: "0.4.0",
        localProtocol: { minimum: 2, maximum: 2 },
        hostProtocol: { minimum: 2, maximum: 2 },
        negotiatedProtocol: 2,
        capabilities: ["installed-skills"],
      },
      connectionSequence: 1,
    };
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.agent.listInstalledSkills)
      .mockRejectedValueOnce(new Error("Remote request failed"))
      .mockResolvedValueOnce([
        {
          skillId: "release-notes",
          slug: "release-notes",
          name: "Release Notes",
          installedVersion: 1,
          availableVersion: 1,
          state: "installed",
        },
      ]);

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(window.openbot.agent.listInstalledSkills).toHaveBeenCalledOnce());

    emitServers?.([local, { ...remote, connectionSequence: 2 }]);
    await waitFor(() => expect(window.openbot.agent.listInstalledSkills).toHaveBeenCalledTimes(2));

    emitServers?.([local, { ...remote, connectionSequence: 3 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.openbot.agent.listInstalledSkills).toHaveBeenCalledTimes(2);
  });

  // Switching servers tears the workspace down and builds it again. Every
  // subscription taken during that rebuild has to be given back, or a session
  // that visits a few servers handles each event several times over. Nothing
  // else asserts this: the counts only became observable once the stub bridges
  // started holding a set of listeners instead of only the newest one.
  it("does not accumulate event subscriptions across server switches", async () => {
    const servers = [testServer("local", true), testServer("remote-1", false)];
    const activate = (activeId: string) => servers.map((server) => ({ ...server, active: server.id === activeId }));
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce(activate("local"));
    vi.mocked(window.openbot.servers.select)
      .mockResolvedValueOnce(activate("remote-1"))
      .mockResolvedValueOnce(activate("local"));

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const afterMount = subscriberCounts();
    const observersAfterMount = TestResizeObserver.instances.size;
    // Without a live subscription to compare against, the equality below would hold trivially.
    expect(afterMount.agentEvent).toBeGreaterThan(0);

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-1"));
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("local"));
    await screen.findByRole("heading", { name: "Chief" });

    expect(subscriberCounts()).toEqual(afterMount);
    expect(TestResizeObserver.instances.size).toBe(observersAfterMount);
  });
});
