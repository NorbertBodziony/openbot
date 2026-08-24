import type {
  AgentEvent,
  AttachmentImportEvent,
  BotSummary,
  CentralAuthState,
  ConversationSnapshot,
  DirectConversationSnapshot,
  DirectMessageRealtimeEvent,
  DirectTypingRealtimeEvent,
  QueueDelivery,
  ServerSummary,
  TeamPresenceSnapshot,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, AppControllerProvider, createAppController, useAppController } from "./App";
import { desktopAnalytics } from "./analytics";
import { triggerResize } from "./setupTests";

const trackAnalytics = vi.spyOn(desktopAnalytics, "track").mockImplementation(() => undefined);

let emitAgentEvent: ((event: AgentEvent) => void) | undefined;
let emitAttachmentImport: ((event: AttachmentImportEvent) => void) | undefined;
let emitUpdateStatus: ((status: UpdateStatus) => void) | undefined;
let emitAuth: ((state: CentralAuthState) => void) | undefined;
let emitServers: ((servers: ServerSummary[]) => void) | undefined;
let emitPresence: ((snapshot: TeamPresenceSnapshot) => void) | undefined;
let emitDirectMessage: ((event: DirectMessageRealtimeEvent) => void) | undefined;
let emitDirectTyping: ((event: DirectTypingRealtimeEvent) => void) | undefined;
let emitInvite: ((inviteUrl: string) => void) | undefined;

const BOTS: BotSummary[] = [
  {
    id: "chief",
    name: "Chief",
    title: "Chief of staff",
    description: "Coordinates work",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    avatarSeed: "chief",
    avatarHue: null,
    avatarUrl: null,
    threadId: "thread-chief",
    workspacePath: "/tmp/OpenBot/Bots/chief",
    preview: "No messages yet",
    updatedAt: null,
  },
  {
    id: "sales-outbound",
    name: "Sales Outbound",
    title: "Outbound specialist",
    description: "",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    avatarSeed: "sales-outbound",
    avatarHue: 280,
    avatarUrl: null,
    threadId: null,
    workspacePath: "/tmp/OpenBot/Bots/sales-outbound",
    preview: "No messages yet",
    updatedAt: null,
  },
];

async function confirmOnboardingModel(): Promise<void> {
  const trigger = await screen.findByRole("button", { name: "Onboarding model: Luna" });
  await fireEvent.click(trigger);
  const picker = screen.getByRole("dialog", { name: "Choose agent model" });
  await fireEvent.click(within(picker).getByRole("option", { name: "Luna, default" }));
  await screen.findByRole("radiogroup", { name: "What do you want me helping with most?" });
}

function queuedDelivery(
  id: string,
  text: string,
  position: number | null,
  overrides: Partial<QueueDelivery> = {},
): QueueDelivery {
  return {
    id,
    messageId: `${id}-message`,
    recipientBotId: "chief",
    sender: { kind: "user" },
    text,
    attachments: [],
    replyToMessageId: null,
    status: "queued",
    position,
    turnId: null,
    error: null,
    createdAt: `2026-08-20T10:00:0${position ?? 0}.000Z`,
    ...overrides,
  };
}

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
    emitAgentEvent = undefined;
    emitAttachmentImport = undefined;
    emitUpdateStatus = undefined;
    emitAuth = undefined;
    emitServers = undefined;
    emitPresence = undefined;
    emitDirectMessage = undefined;
    emitDirectTyping = undefined;
    emitInvite = undefined;
    trackAnalytics.mockClear();
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")) },
    });
    Object.defineProperty(window, "openbot", {
      configurable: true,
      value: {
        getAppInfo: vi.fn().mockResolvedValue({
          name: "OpenBot",
          version: "0.1.0",
          platform: "darwin",
          variant: "production",
        }),
        getSetupState: vi.fn().mockResolvedValue({ completed: true, preferredProvider: "codex" }),
        saveSetup: vi.fn().mockImplementation(async ({ preferredProvider }) => ({
          completed: true,
          preferredProvider,
        })),
        getMacPermissions: vi.fn().mockResolvedValue({
          screenRecording: "granted",
          accessibility: "granted",
        }),
        requestMacPermission: vi.fn().mockResolvedValue({
          screenRecording: "granted",
          accessibility: "granted",
        }),
        openExternal: vi.fn().mockResolvedValue(undefined),
        openUrl: vi.fn().mockResolvedValue(undefined),
        voice: {
          transcribe: vi.fn().mockResolvedValue({ text: "Voice transcript" }),
        },
        auth: {
          getState: vi.fn().mockResolvedValue({
            status: "signed_in",
            user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
          }),
          retry: vi.fn().mockResolvedValue({ status: "signed_out" }),
          requestEmailCode: vi.fn().mockResolvedValue({
            status: "code_sent",
            challengeId: "challenge-1",
            email: "person@example.com",
            expiresAt: Date.now() + 600_000,
            resendAvailableAt: Date.now() + 60_000,
          }),
          verifyEmailCode: vi.fn().mockResolvedValue({
            status: "signed_in",
            user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
          }),
          updateAvatar: vi.fn().mockResolvedValue({
            status: "signed_in",
            user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
          }),
          logout: vi.fn().mockResolvedValue({ status: "signed_out" }),
          onEvent: vi.fn((listener) => {
            emitAuth = listener;
            return () => undefined;
          }),
        },
        agent: {
          getStatus: vi.fn().mockResolvedValue({
            phase: "ready",
            cliVersion: "0.144.1",
            auth: { kind: "chatgpt", email: "norbert@example.com" },
            providers: [
              {
                id: "codex",
                state: "available",
                version: "0.144.1",
                message: null,
                email: "norbert@example.com",
              },
              {
                id: "claude",
                state: "available",
                version: "2.1.231",
                message: null,
                email: "claude@example.com",
              },
            ],
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
            {
              id: "claude-opus-5",
              name: "Claude Opus 5",
              description: "Most capable Claude model for complex work.",
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: ["low", "medium", "high"],
            },
            {
              id: "claude-sonnet-5",
              name: "Claude Sonnet 5",
              description: "Balanced Claude model for general agent work.",
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: ["low", "medium", "high"],
            },
          ]),
          listBots: vi.fn().mockResolvedValue(BOTS),
          createBot: vi.fn().mockResolvedValue({
            ...BOTS[0],
            id: "bot-new",
            name: "New agent",
            title: "",
            avatarSeed: "bot-new",
            avatarHue: null,
          }),
          updateBot: vi.fn().mockImplementation(async (input) => ({
            ...BOTS.find((bot) => bot.id === input.botId),
            ...input,
          })),
          setAvatar: vi.fn().mockImplementation(async (input) => ({
            ...BOTS.find((bot) => bot.id === input.botId),
            avatarUrl: input.image ? "openbot-avatar://agent/chief?v=test" : null,
          })),
          deleteBot: vi.fn().mockResolvedValue(undefined),
          readConversation: vi.fn().mockImplementation(async (botId) => ({
            botId,
            threadId: null,
            activeTurnId: null,
            revision: 0,
            messages: [],
            readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
          })),
          readConversationPage: vi.fn().mockImplementation(async (input) => {
            const snapshot = await window.openbot.agent.readConversation(input.botId);
            const messages = snapshot.messages.slice(-Math.min(input.limit ?? 50, 100));
            return {
              ...snapshot,
              messages,
              references: {},
              pageInfo: { hasOlder: snapshot.messages.length > messages.length, olderCursor: null },
            };
          }),
          searchConversationMessages: vi.fn().mockResolvedValue({ results: [], total: 0, nextCursor: null }),
          listConversationReads: vi.fn().mockResolvedValue({}),
          markConversationRead: vi.fn().mockImplementation(async (input) => ({
            unreadCount: 0,
            firstUnreadMessageId: null,
            throughMessageId: input.throughMessageId,
          })),
          chooseAttachments: vi.fn().mockResolvedValue([]),
          onAttachmentImport: vi.fn((listener) => {
            emitAttachmentImport = listener;
            return () => undefined;
          }),
          discardDraftAttachment: vi.fn().mockResolvedValue(undefined),
          openAttachment: vi.fn().mockResolvedValue(undefined),
          openSharedFile: vi.fn().mockResolvedValue(undefined),
          openWorkspaceFile: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue({
            messageId: "message-1",
            deliveries: [{ id: "delivery-1", recipientBotId: "chief", status: "queued", position: 1 }],
          }),
          setMessageReaction: vi.fn().mockResolvedValue(undefined),
          listQueue: vi.fn().mockImplementation(async (botId) => ({ botId, deliveries: [] })),
          cancelQueuedMessage: vi.fn().mockResolvedValue(undefined),
          steerQueuedMessage: vi.fn().mockResolvedValue(undefined),
          updateQueuedMessage: vi.fn().mockResolvedValue(undefined),
          reorderQueue: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined),
          respondToPrompt: vi.fn().mockResolvedValue(undefined),
          respondToApproval: vi.fn().mockResolvedValue(undefined),
          onEvent: vi.fn((listener) => {
            emitAgentEvent = listener;
            return () => undefined;
          }),
        },
        browser: {
          open: vi.fn().mockResolvedValue(undefined),
          activate: vi.fn().mockResolvedValue(undefined),
          reload: vi.fn().mockResolvedValue(undefined),
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
        servers: {
          list: vi.fn().mockResolvedValue([
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
          ]),
          select: vi.fn().mockResolvedValue([
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
          ]),
          join: vi.fn().mockResolvedValue(undefined),
          previewInvite: vi.fn().mockResolvedValue({
            serverId: "00000000-0000-4000-8000-000000000000",
            serverName: "Studio Mac",
            apiHostname: "studio-host.openbot.run",
            role: "member",
            expiresAt: "2026-08-21T10:00:00.000Z",
            emailBound: false,
          }),
          takePendingInvite: vi.fn().mockResolvedValue(null),
          login: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
          getPresence: vi.fn().mockResolvedValue({ serverId: null, members: [], updatedAt: "" }),
          getPresenceFor: vi.fn().mockResolvedValue({ serverId: null, members: [], updatedAt: "" }),
          refreshIdentity: vi.fn().mockImplementation(async (serverId) => {
            const server = (await window.openbot.servers.list()).find((item) => item.id === serverId);
            if (!server) throw new Error("Server not found");
            return server;
          }),
          listMembers: vi.fn().mockResolvedValue([]),
          updateMember: vi.fn().mockResolvedValue(undefined),
          removeMember: vi.fn().mockResolvedValue(undefined),
          listInvites: vi.fn().mockResolvedValue([]),
          revokeInvite: vi.fn().mockResolvedValue(undefined),
          createInvite: vi.fn().mockResolvedValue({
            inviteUrl: "https://team.example.com/invite/test",
            expiresAt: "2026-08-21T10:00:00.000Z",
            role: "member",
            email: null,
          }),
          setTyping: vi.fn().mockResolvedValue(undefined),
          onPresence: vi.fn((listener) => {
            emitPresence = listener;
            return () => undefined;
          }),
          listDirectThreads: vi.fn().mockResolvedValue([]),
          readDirectConversation: vi.fn().mockImplementation(async (memberId) => ({
            threadId: `thread-${memberId}`,
            otherMemberId: memberId,
            messages: [],
            revision: 0,
            readState: { unreadCount: 0, firstUnreadMessageId: null, throughSequence: 0 },
          })),
          readDirectConversationPage: vi.fn().mockImplementation(async (input) => {
            const snapshot = await window.openbot.servers.readDirectConversation(input.memberId);
            const messages = snapshot.messages.slice(-Math.min(input.limit ?? 50, 100));
            return {
              ...snapshot,
              messages,
              pageInfo: { hasOlder: snapshot.messages.length > messages.length, olderCursor: null },
            };
          }),
          sendDirectMessage: vi.fn().mockImplementation(async (input) => ({
            id: input.clientMessageId,
            threadId: `thread-${input.memberId}`,
            senderMemberId: "member-self",
            recipientMemberId: input.memberId,
            text: input.text,
            createdAt: "2026-08-19T10:00:00.000Z",
            sequence: 1,
          })),
          markDirectRead: vi.fn().mockImplementation(async (input) => ({
            unreadCount: 0,
            firstUnreadMessageId: null,
            throughSequence: input.throughSequence,
          })),
          setDirectTyping: vi.fn().mockResolvedValue(undefined),
          onDirectMessage: vi.fn((listener) => {
            emitDirectMessage = listener;
            return () => undefined;
          }),
          onDirectTyping: vi.fn((listener) => {
            emitDirectTyping = listener;
            return () => undefined;
          }),
          onEvent: vi.fn((listener) => {
            emitServers = listener;
            return () => undefined;
          }),
          onInvite: vi.fn((listener) => {
            emitInvite = listener;
            return () => undefined;
          }),
        },
        host: {
          getStatus: vi.fn().mockResolvedValue({
            phase: "unconfigured",
            configured: false,
            enabledOnLaunch: false,
            serverId: null,
            serverName: null,
            logoUrl: null,
            apiUrl: null,
            apiOnline: false,
            remoteDesktopReady: false,
            remoteDesktopUnattended: false,
            remoteDesktopActiveSessions: 0,
            remoteDesktopMaxSessions: 4,
            message: null,
          }),
          configure: vi.fn().mockResolvedValue(undefined),
          updateIdentity: vi.fn().mockResolvedValue(undefined),
          getPresence: vi.fn().mockResolvedValue({ serverId: null, members: [], updatedAt: "" }),
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          listMembers: vi.fn().mockResolvedValue([]),
          updateMember: vi.fn().mockResolvedValue(undefined),
          removeMember: vi.fn().mockResolvedValue(undefined),
          listSessions: vi.fn().mockResolvedValue([]),
          revokeSession: vi.fn().mockResolvedValue(undefined),
          listInvites: vi.fn().mockResolvedValue([]),
          revokeInvite: vi.fn().mockResolvedValue(undefined),
          createInvite: vi.fn().mockResolvedValue(undefined),
          onEvent: vi.fn(() => () => undefined),
        },
        remoteDesktop: {
          list: vi.fn().mockResolvedValue([]),
          connect: vi.fn().mockResolvedValue(undefined),
          selectDisplay: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          onEvent: vi.fn(() => () => undefined),
        },
      },
    });
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

  it("shows the first-run onboarding before starting agents", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Meet OpenBot" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Where will OpenBot run?" })).not.toBeInTheDocument();
    expect(screen.queryByText("Verified. Opening OpenBot…")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chief" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    const providers = screen.getByRole("radiogroup", { name: "Default provider" });
    const codex = within(providers).getByRole("radio", { name: /Codex.*Available/ });
    expect(codex).toHaveFocus();
    await fireEvent.click(within(providers).getByRole("radio", { name: /Claude.*Available/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open OpenBot" }));
    expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "claude" });
    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
  });

  it("connects to a remote host after account sign-in", async () => {
    const inviteUrl = "https://openbot.run/join?invite=test";
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.servers.takePendingInvite).mockResolvedValueOnce(inviteUrl);
    render(() => <App />);

    expect(await screen.findByRole("dialog", { name: "Connect to a host" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();

    expect(screen.getAllByText(/person@example.com/).length).toBeGreaterThan(0);
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Connect to host" }));

    await waitFor(() =>
      expect(window.openbot.servers.join).toHaveBeenCalledWith({
        inviteUrl,
      }),
    );
    await waitFor(() => expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "codex" }));
  });

  it("loads a cold-start invitation into first-run remote setup", async () => {
    const inviteUrl = "https://openbot.run/join?invite=cold-start";
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.servers.takePendingInvite).mockResolvedValueOnce(inviteUrl);

    render(() => <App />);

    expect(await screen.findByRole("dialog", { name: "Connect to a host" })).toBeInTheDocument();
    await waitFor(() => expect(window.openbot.servers.previewInvite).toHaveBeenCalledWith({ inviteUrl }));
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    expect(window.openbot.servers.join).not.toHaveBeenCalled();
  });

  it("opens a verified invitation received while the configured app is running", async () => {
    const inviteUrl = "https://openbot.run/join?invite=second-instance";
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitInvite?.(inviteUrl);

    expect(await screen.findByRole("dialog", { name: "Studio Mac" })).toBeInTheDocument();
    await waitFor(() => expect(window.openbot.servers.previewInvite).toHaveBeenCalledWith({ inviteUrl }));
    expect(window.openbot.servers.join).not.toHaveBeenCalled();
  });

  it("keeps the landing preview account static and omits browser and remote control", async () => {
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

    expect(screen.queryByRole("button", { name: "Open account menu" })).not.toBeInTheDocument();
    expect(screen.getByText("Norbert")).toBeInTheDocument();
    expect(screen.getByText("norbertbodziony@gmail.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open computer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remote control/iu })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Add remote server" }));
    expect(screen.queryByRole("dialog", { name: "Join a server" })).not.toBeInTheDocument();
    expect(window.openbot.browser.listTabs).not.toHaveBeenCalled();
    expect(window.openbot.browser.getControlState).not.toHaveBeenCalled();
    expect(window.openbot.browser.setVisible).not.toHaveBeenCalled();
    expect(window.openbot.remoteDesktop.list).not.toHaveBeenCalled();
    expect(window.openbot.remoteDesktop.onEvent).not.toHaveBeenCalled();
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
    expect(remoteDesktop).toHaveClass("remote-desktop-workspace-visible");
    expect(appFrame.inert).toBe(true);
    expect(appFrame).toHaveAttribute("aria-hidden", "true");
    expect(within(remoteDesktop).queryByText("Studio Mac")).not.toBeInTheDocument();
    expect(within(remoteDesktop).queryByText("Shared control")).not.toBeInTheDocument();
    expect(within(remoteDesktop).getByRole("button", { name: "Back to OpenBot" })).toBeInTheDocument();
    expect(within(remoteDesktop).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(within(remoteDesktop).queryByRole("button", { name: /Remote display/ })).not.toBeInTheDocument();
    expect(within(remoteDesktop).queryByLabelText(/password/iu)).not.toBeInTheDocument();
    expect(within(remoteDesktop).queryByText(/view.only/iu)).not.toBeInTheDocument();
    await waitFor(() => expect(window.openbot.remoteDesktop.connect).toHaveBeenCalledWith({ serverId: "remote-1" }));

    const viewer = await screen.findByTitle("Sunshine remote desktop");
    await fireEvent.click(within(remoteDesktop).getByRole("button", { name: "Back to OpenBot" }));
    await waitFor(() => expect(appFrame.inert).toBe(false));
    expect(window.openbot.remoteDesktop.disconnect).not.toHaveBeenCalled();
    expect(screen.getByTitle("Sunshine remote desktop")).toBe(viewer);
    const resumeButton = screen.getByRole("button", { name: "Resume remote control" });
    await waitFor(() => expect(resumeButton).toHaveFocus());

    await fireEvent.click(resumeButton);
    expect(await screen.findByTitle("Sunshine remote desktop")).toBe(viewer);
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

  it("lets a user request an email code from the initial screen", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({ status: "signed_out" });
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Default provider" })).not.toBeInTheDocument();

    await fireEvent.input(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "person@example.com" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
    expect(window.openbot.auth.requestEmailCode).toHaveBeenCalledWith("person@example.com");
    await fireEvent.input(await screen.findByRole("textbox", { name: "One-time code" }), {
      target: { value: "ABCD-EFGH" },
    });
    expect(window.openbot.auth.verifyEmailCode).toHaveBeenCalledWith("challenge-1", "ABCD-EFGH");
    expect(trackAnalytics).toHaveBeenCalledWith("account_sign_in_started", { result: "code_sent" });
    expect(trackAnalytics).toHaveBeenCalledWith("account_sign_in_completed", { result: "succeeded" });
    expect(await screen.findByText("Verified. Opening OpenBot…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Where will OpenBot run?" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Meet OpenBot" })).toBeInTheDocument();
  });

  it("shows a soft loader until the account API becomes available", async () => {
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({ status: "loading" });
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Connecting to OpenBot" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Connecting securely…");
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();

    emitAuth?.({ status: "signed_out" });
    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email" })).toBeInTheDocument();
  });

  it("lets the user retry after the account API startup timeout", async () => {
    let finishRetry: ((state: CentralAuthState) => void) | undefined;
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({
      status: "error",
      issue: {
        code: "auth_api_unavailable",
        message: "OpenBot could not reach the account service.",
      },
    });
    vi.mocked(window.openbot.auth.retry).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRetry = resolve;
      }),
    );
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Service unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(window.openbot.auth.retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Connecting to OpenBot" })).toBeInTheDocument();
    finishRetry?.({ status: "signed_out" });
    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
  });

  it("requires account sign-in before opening a completed workspace", async () => {
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({ status: "signed_out" });
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chief" })).not.toBeInTheDocument();
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
  });

  it("keeps a cold-start invitation until a signed-out user signs in", async () => {
    const inviteUrl = "https://openbot.run/join?invite=after-sign-in";
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({ status: "signed_out" });
    vi.mocked(window.openbot.servers.takePendingInvite).mockResolvedValueOnce(inviteUrl);
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Join a server" })).not.toBeInTheDocument();

    emitAuth?.({
      status: "signed_in",
      user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
    });

    expect(await screen.findByRole("dialog", { name: "Studio Mac" })).toBeInTheDocument();
    await waitFor(() => expect(window.openbot.servers.previewInvite).toHaveBeenCalledWith({ inviteUrl }));
  });

  it("lets the user choose a provider while provider checks are running", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "starting",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        {
          id: "codex",
          state: "checking",
          version: null,
          message: null,
          email: null,
        },
        {
          id: "claude",
          state: "checking",
          version: null,
          message: null,
          email: null,
        },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: null,
      fullAccess: true,
    });
    render(() => <App />);

    const providers = await screen.findByRole("radiogroup", { name: "Default provider" });
    const codex = within(providers).getByRole("radio", { name: /Codex.*Checking/ });
    const claude = within(providers).getByRole("radio", { name: /Claude.*Checking/ });

    expect(codex).toBeEnabled();
    expect(claude).toBeEnabled();
    expect(codex).toHaveFocus();

    await fireEvent.click(claude);
    expect(claude).toBeChecked();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();

    emitAgentEvent?.({
      type: "status",
      status: {
        phase: "blocked",
        cliVersion: null,
        auth: { kind: "unknown" },
        providers: [
          {
            id: "codex",
            state: "not-installed",
            version: null,
            message: "Codex CLI is not installed.",
            email: null,
          },
          {
            id: "claude",
            state: "sign-in-required",
            version: "2.1.231",
            message: "Sign in to Claude.",
            email: null,
          },
        ],
        capabilities: {
          chat: "setup-required",
          browser: "ready",
          computerUse: "setup-required",
        },
        message: "Choose and configure a provider.",
        fullAccess: true,
      },
    });

    expect(claude).toBeChecked();
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open OpenBot" }));
    expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "claude" });
  });

  it("lets the user review providers and permissions from the account menu", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    await fireEvent.click(screen.getByRole("button", { name: "Providers & permissions" }));

    expect(screen.getByRole("dialog", { name: "Providers & permissions" })).toBeInTheDocument();
    const providers = screen.getByRole("radiogroup", { name: "Default provider" });
    expect(within(providers).getByRole("radio", { name: /Codex.*Available/ })).toBeChecked();
    expect(within(providers).getByText("norbert@example.com")).toBeInTheDocument();
    expect(within(providers).getByText("claude@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await fireEvent.click(within(providers).getByRole("radio", { name: /Claude.*Available/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(window.openbot.saveSetup).toHaveBeenLastCalledWith({ preferredProvider: "claude" });
    expect(screen.queryByRole("dialog", { name: "Providers & permissions" })).not.toBeInTheDocument();
  });

  it("opens the create-agent picker for a new user with no agents", async () => {
    vi.mocked(window.openbot.agent.listBots).mockResolvedValueOnce([]);
    render(() => <App />);

    expect(await screen.findByRole("option", { name: "Create new agent" })).toBeInTheDocument();
    expect(screen.getByText("No agents yet")).toBeInTheDocument();
  });

  it("keeps agents disabled when setup persistence fails", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.saveSetup).mockRejectedValueOnce(new Error("Could not save setup."));
    render(() => <App />);

    expect(
      within(await screen.findByRole("radiogroup", { name: "Default provider" })).getByRole("radio", {
        name: /Codex.*Available/,
      }),
    ).toBeChecked();
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open OpenBot" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save setup.");
    expect(screen.queryByRole("heading", { name: "Chief" })).not.toBeInTheDocument();
  });

  it("requests optional macOS permissions and shows the new state", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.getMacPermissions).mockResolvedValueOnce({
      screenRecording: "not-determined",
      accessibility: "not-determined",
    });
    vi.mocked(window.openbot.requestMacPermission).mockResolvedValueOnce({
      screenRecording: "granted",
      accessibility: "not-determined",
    });
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    const row = (await screen.findByText("Screen Recording")).closest(".onboarding-permission-row");
    const action = row?.querySelector("button");
    expect(action).not.toBeNull();
    if (!(action instanceof HTMLButtonElement)) throw new Error("Permission action is missing.");
    await fireEvent.click(action);
    expect(window.openbot.requestMacPermission).toHaveBeenCalledWith("screen-recording");
    await waitFor(() => expect(action).toHaveTextContent("Allowed"));

    vi.mocked(window.openbot.requestMacPermission).mockResolvedValueOnce({
      screenRecording: "granted",
      accessibility: "granted",
    });
    const accessibilityRow = screen.getByText("Accessibility").closest(".onboarding-permission-row");
    const accessibilityAction = accessibilityRow?.querySelector("button");
    expect(accessibilityAction).not.toBeNull();
    if (!(accessibilityAction instanceof HTMLButtonElement)) throw new Error("Accessibility action is missing.");
    await fireEvent.click(accessibilityAction);
    await waitFor(() => expect(accessibilityAction).toHaveTextContent("Allowed"));
  });

  it("hides macOS permissions on other platforms", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.getAppInfo).mockResolvedValueOnce({
      name: "OpenBot",
      version: "0.1.0",
      platform: "win32",
      variant: "production",
    });
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Meet OpenBot" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.queryByText("Optional computer control")).not.toBeInTheDocument());
    expect(window.openbot.getMacPermissions).not.toHaveBeenCalled();
  });

  it("uses the backend bot list and shows local onboarding for a real empty snapshot", async () => {
    render(() => <App />);
    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
    expect(await screen.findByText("Choose a model to get started.")).toBeInTheDocument();
    expect(
      screen.queryByRole("radiogroup", { name: "What do you want me helping with most?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "false");
    expect(screen.getByRole("button", { name: "Add to prompt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    await confirmOnboardingModel();
    expect(screen.getByRole("radiogroup", { name: "What do you want me helping with most?" })).toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "true");
    expect(screen.getByRole("button", { name: "Add to prompt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
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

    expect(await screen.findByText("Agent CLI setup required")).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: /helping with most/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "false");
    fireEvent.click(screen.getByRole("button", { name: "Setup guide" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("agent-setup"));
  });

  it("shows a compact account menu with weekly usage and contact actions", async () => {
    render(() => <App />);
    const accountButton = await screen.findByRole("button", { name: "Open account menu" });
    expect(accountButton).toHaveTextContent("person@example.com");
    expect(accountButton.closest(".account-dock")).toHaveClass("account-dock-with-server-rail");
    expect(screen.getByRole("complementary", { name: "Bot navigation" })).not.toContainElement(accountButton);

    fireEvent.click(accountButton);
    await waitFor(() => expect(window.openbot.agent.getUsage).toHaveBeenCalledTimes(1));
    const accountDialog = screen.getByRole("dialog", { name: "Account" });
    expect(within(accountDialog).getAllByText("person@example.com")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Upload photo" })).toBeInTheDocument();
    expect(await screen.findByText("Weekly usage")).toBeInTheDocument();
    expect(screen.getByText("59%")).toBeInTheDocument();
    expect(screen.queryByText(/ChatGPT Pro/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Developer preview/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Lifetime/i)).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Export data" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export diagnostics" })).not.toBeInTheDocument();

    await screen.findByRole("button", { name: "Send feedback" });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("feedback"));

    fireEvent.click(accountButton);
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("message"));
  });

  it("removes a custom account avatar from the account menu", async () => {
    vi.mocked(window.openbot.auth.getState).mockResolvedValueOnce({
      status: "signed_in",
      user: {
        id: "user-1",
        email: "person@example.com",
        name: null,
        avatarUrl: "https://api.openbot.run/v1/avatars/user-1?v=image-1",
      },
    });
    render(() => <App />);
    const accountButton = await screen.findByRole("button", { name: "Open account menu" });
    await fireEvent.click(accountButton);
    await fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    await waitFor(() => expect(window.openbot.auth.updateAvatar).toHaveBeenCalledWith(null));
  });

  it("signs out from the account menu without removing local data", async () => {
    render(() => <App />);
    const accountButton = await screen.findByRole("button", { name: "Open account menu" });
    await fireEvent.click(accountButton);
    await fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(window.openbot.auth.logout).toHaveBeenCalledOnce());
    expect(trackAnalytics).toHaveBeenCalledWith("account_signed_out", {});
    expect(await screen.findByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(window.openbot.agent.deleteBot).not.toHaveBeenCalled();
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
    fireEvent.click(await screen.findByRole("button", { name: /Download update/ }));
    await waitFor(() => expect(window.openbot.update.download).toHaveBeenCalledOnce());

    emitUpdateStatus?.({
      phase: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: 100,
      checkedAt: "2026-08-12T22:00:00.000Z",
      message: null,
    });
    fireEvent.click(await screen.findByRole("button", { name: /Restart to update/ }));
    await waitFor(() => expect(window.openbot.update.install).toHaveBeenCalledOnce());
  });

  it("offers local voice prompting and explains blocked microphone access", async () => {
    render(() => <App />);

    const voiceButton = await screen.findByRole("button", { name: "Create prompt with voice" });
    await fireEvent.click(voiceButton);

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(
      await screen.findByText("Microphone access is blocked. Allow OpenBot to use the microphone in system settings."),
    ).toBeInTheDocument();
  });

  it("shows the recording timer and stop control while capturing voice", async () => {
    class RecordingMediaRecorder extends EventTarget {
      readonly mimeType = "audio/webm";
      state: RecordingState = "inactive";

      start(): void {
        this.state = "recording";
      }

      stop(): void {
        this.state = "inactive";
        this.dispatchEvent(new Event("stop"));
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: RecordingMediaRecorder });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
      },
    });
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));

    const status = await screen.findByRole("group", { name: "Voice recording" });
    expect(within(status).getByText("0:00")).toBeVisible();
    expect(within(status).getByRole("button", { name: "Stop voice recording" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create prompt with voice" })).not.toBeInTheDocument();
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
    expect(metaLink.querySelector("img")).toHaveAttribute("src", "https://about.fb.com/favicon.ico");
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

  it("filters and switches backend bots", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("button", { name: "Onboarding model: Luna" });
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    await fireEvent.input(search, { target: { value: "Sales" } });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    expect(screen.getByRole("heading", { name: "Sales Outbound" })).toBeInTheDocument();
  });

  it("shows agent title badges without a redundant standalone heading", async () => {
    vi.mocked(window.openbot.agent.listBots).mockResolvedValueOnce([BOTS[0], { ...BOTS[1], title: "   " }]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    expect(screen.getByText("Chief of staff")).toHaveClass("bot-role-badge");
    expect(screen.getByText("Chief of staff")).toHaveAttribute("title", "Chief of staff");
    expect(screen.queryByText("Outbound specialist")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Agents" })).not.toBeInTheDocument();

    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        presenceMember("member-self", "person@example.com", "Person"),
        presenceMember("member-alice", "alice@example.com", "Alice"),
      ],
    });

    expect(await screen.findByRole("heading", { name: "People" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agents" })).toBeInTheDocument();
  });

  it("shows the specialty question immediately after creating a new agent", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    await fireEvent.click(screen.getByRole("option", { name: "Create new agent" }));

    expect(await screen.findByRole("heading", { name: "New agent" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New agent. No messages yet" }).querySelector(".bot-role-badge"),
    ).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Agent settings" })).not.toBeInTheDocument();
    expect(
      await screen.findByRole("radiogroup", { name: "What do you want me helping with most?" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Message New agent")).toHaveAttribute("contenteditable", "true");
  });

  it("opens agent creation from a private conversation", async () => {
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
    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    expect(await screen.findByRole("main", { name: "Direct conversation with Alice" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    await fireEvent.click(await screen.findByRole("option", { name: "Create new agent" }));

    expect(await screen.findByRole("heading", { name: "New agent" })).toBeInTheDocument();
    expect(window.openbot.agent.createBot).toHaveBeenCalledOnce();
    expect(window.openbot.servers.setDirectTyping).toHaveBeenCalledWith({
      memberId: "member-alice",
      typing: false,
    });
  });

  it("resizes and persists the left and right side panels", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const leftResizer = screen.getByRole("separator", { name: "Resize left sidebar" });
    await fireEvent.keyDown(leftResizer, { key: "ArrowRight" });
    expect(leftResizer).toHaveAttribute("aria-valuenow", "292");
    expect(leftResizer.closest(".app-frame")).toHaveStyle("--left-panel-width: 292px");
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
    expect(screen.getByRole("main", { name: "Conversation" })).toHaveStyle("--settings-panel-width: 308px");
    expect(window.localStorage.getItem("openbot:settings-panel-width")).toBe("308");

    await fireEvent.dblClick(rightResizer);
    expect(rightResizer).toHaveAttribute("aria-valuenow", "296");

    await fireEvent.keyDown(rightResizer, { key: "Home" });
    expect(rightResizer).toHaveAttribute("aria-valuenow", "180");
    await fireEvent.keyDown(rightResizer, { key: "End" });
    expect(rightResizer).toHaveAttribute("aria-valuenow", String(Math.min(1600, window.innerWidth - 96)));
  });

  it("selects a provider and model from the conversation header", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });
    expect(trigger.querySelector(".provider-model-mark-codex")).toBeInTheDocument();
    await fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    expect(within(picker).getByText("0.144.1 (Codex CLI)")).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "Luna, default" })).toHaveAttribute("aria-selected", "true");

    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    expect(window.openbot.agent.updateBot).not.toHaveBeenCalled();
    expect(within(picker).getByText("2.1.231 (Claude Code)")).toBeInTheDocument();
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));

    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        model: "claude-opus-5",
        reasoningEffort: "medium",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Choose agent model" })).not.toBeInTheDocument();
    const claudeTrigger = await screen.findByRole("button", {
      name: "Agent model: Claude Opus 5",
    });
    expect(claudeTrigger).toBeEnabled();
    expect(claudeTrigger.querySelector(".provider-model-mark-claude")).toBeInTheDocument();
    expect(claudeTrigger.querySelector(".provider-model-mark-codex")).not.toBeInTheDocument();
  });

  it("shows unavailable providers without allowing their models", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "ready",
      cliVersion: "0.144.1",
      auth: { kind: "chatgpt", email: "norbert@example.com" },
      providers: [
        { id: "codex", state: "available", version: "0.144.1", message: null },
        {
          id: "claude",
          state: "not-installed",
          version: null,
          message: "Claude CLI was not found.",
        },
      ],
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
      message: null,
      fullAccess: true,
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /Claude: Claude CLI was not found/ }));
    expect(within(picker).getByText("Claude CLI was not found.")).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "Claude Opus 5, default" })).toBeDisabled();
    expect(window.openbot.agent.updateBot).not.toHaveBeenCalled();
  });

  it("rolls back a failed header model change and reports the error", async () => {
    vi.mocked(window.openbot.agent.updateBot).mockRejectedValueOnce(new Error("Provider failed"));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("button", { name: "Onboarding model: Luna" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    await fireEvent.click(screen.getByRole("option", { name: "Sol" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not change model. Try again.");
    expect(screen.getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();
    expect(
      screen.queryByRole("radiogroup", { name: "What do you want me helping with most?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "false");
  });

  it("locks the header model picker during active work", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });

    emitAgentEvent?.({
      type: "turn-started",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-1",
    });
    await waitFor(() => expect(trigger).toBeDisabled());
    expect(trigger).toHaveAttribute("title", "Wait for the current work to finish before changing models.");

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-1",
      status: "completed",
    });
    await waitFor(() => expect(trigger).toBeEnabled());
    expect(trackAnalytics).toHaveBeenCalledWith(
      "turn_started",
      expect.objectContaining({ provider: "codex", model: "gpt-5.6-luna" }),
    );
    expect(trackAnalytics).toHaveBeenCalledWith(
      "turn_completed",
      expect.objectContaining({ provider: "codex", status: "completed", duration_ms: expect.any(Number) }),
    );
  });

  it("supports picker keyboard navigation and outside dismissal", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });

    await fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    const codex = within(picker).getByRole("tab", { name: /^Codex:/ });
    await fireEvent.keyDown(codex, { key: "ArrowUp" });
    const claude = within(picker).getByRole("tab", { name: /^Claude:/ });
    expect(claude).toHaveFocus();
    expect(claude).toHaveAttribute("aria-selected", "true");

    await fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose agent model" })).not.toBeInTheDocument();
    await fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Choose agent model" })).toBeInTheDocument();
    await fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Choose agent model" })).not.toBeInTheDocument();
  });

  it("edits the persisted model and thinking level in agent settings", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));

    const settings = await screen.findByRole("complementary", { name: "Agent settings" });
    const thinking = within(settings).getByRole("button", { name: /Agent reasoning level/ });
    expect(within(settings).getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();
    expect(thinking).toHaveTextContent("Medium");

    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Luna" }));
    let picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        model: "claude-opus-5",
        reasoningEffort: "medium",
      }),
    );
    expect(within(settings).getByRole("button", { name: "Agent model: Claude Opus 5" })).toBeEnabled();

    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Claude Opus 5" }));
    picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Codex:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Sol" }));
    await fireEvent.pointerDown(thinking, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "Extra high" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenLastCalledWith({
        botId: "chief",
        reasoningEffort: "xhigh",
      }),
    );
  });

  it("selects a stable generated avatar and color without tying it to the agent name", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const settings = await screen.findByRole("complementary", { name: "Agent settings" });
    const avatarButton = within(settings).getByRole("button", { name: "Edit agent avatar" });
    await fireEvent.click(avatarButton);

    const editor = within(settings).getByRole("dialog", { name: "Avatar editor" });
    expect(within(editor).getByRole("button", { name: /Upload image/ })).toBeInTheDocument();
    expect(within(editor).getAllByRole("button", { name: /Avatar option/ })).toHaveLength(11);
    const faceButtons = within(editor).getAllByRole("button", {
      name: /Selected avatar|Avatar option/,
    });
    expect(faceButtons).toHaveLength(12);
    for (const faceButton of faceButtons) {
      expect(faceButton.querySelector(".bot-avatar-motion-hover")).not.toBeNull();
      expect(faceButton.querySelector(".bot-avatar-bloub > svg")).not.toBeNull();
      expect(faceButton.querySelector(".agent-mark")).toBeNull();
    }
    const optionTwo = within(editor).getByRole("button", { name: "Avatar option 2" });
    const faceMarkup = faceButtons.map((button) => button.innerHTML);
    await fireEvent.click(optionTwo);
    expect(optionTwo).toHaveAttribute("aria-pressed", "true");
    expect(within(editor).getAllByRole("button", { name: /Selected avatar|Avatar option/ })[1]).toBe(optionTwo);
    expect(
      within(editor)
        .getAllByRole("button", { name: /Selected avatar|Avatar option/ })
        .map((button) => button.innerHTML),
    ).toEqual(faceMarkup);
    const callsBeforeNewSet = vi.mocked(window.openbot.agent.updateBot).mock.calls.length;
    await fireEvent.click(within(editor).getByRole("button", { name: "New set" }));
    const nextFaceButtons = within(editor).getAllByRole("button", {
      name: /Selected avatar|Avatar option/,
    });
    expect(nextFaceButtons[0]).toHaveAttribute("aria-pressed", "true");
    expect(nextFaceButtons.map((button) => button.innerHTML)).not.toEqual(faceMarkup);
    expect(window.openbot.agent.updateBot).toHaveBeenCalledTimes(callsBeforeNewSet);
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        avatarSeed: "chief:avatar:0:1",
      }),
    );
    await fireEvent.click(within(editor).getByRole("button", { name: "Reset to ID" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        avatarSeed: "chief",
      }),
    );
    await fireEvent.click(within(editor).getByRole("button", { name: "Avatar option 2" }));

    await fireEvent.click(within(editor).getByRole("button", { name: "Blue avatar color" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        avatarHue: 215,
      }),
    );

    const name = within(settings).getByRole("textbox", { name: "Agent name" });
    await fireEvent.pointerDown(name);
    expect(within(settings).queryByRole("dialog", { name: "Avatar editor" })).toBeNull();
    await fireEvent.input(name, { target: { value: "Coordinator" } });
    await fireEvent.blur(name);
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        name: "Coordinator",
      }),
    );
  });

  it("removes a custom agent avatar and keeps its generated avatar settings", async () => {
    vi.mocked(window.openbot.agent.listBots).mockResolvedValueOnce([
      { ...BOTS[0], avatarUrl: "openbot-avatar://agent/chief?v=image-1" },
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const settings = await screen.findByRole("complementary", { name: "Agent settings" });
    await fireEvent.click(within(settings).getByRole("button", { name: "Edit agent avatar" }));
    const editor = within(settings).getByRole("dialog", { name: "Avatar editor" });
    await fireEvent.click(within(editor).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(window.openbot.agent.setAvatar).toHaveBeenCalledWith({ botId: "chief", image: null }));
    expect(window.openbot.agent.updateBot).not.toHaveBeenCalledWith(
      expect.objectContaining({ avatarSeed: expect.any(String) }),
    );
  });

  it("keeps provider choices separate for each agent profile", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    let settings = await screen.findByRole("complementary", { name: "Agent settings" });
    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Luna" }));
    let picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    settings = await screen.findByRole("complementary", { name: "Agent settings" });
    expect(within(settings).getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();

    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Luna" }));
    picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "sales-outbound",
        model: "claude-opus-5",
        reasoningEffort: "medium",
      }),
    );
  });

  it("shows provider availability during onboarding", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "ready",
      cliVersion: "0.144.1",
      auth: { kind: "chatgpt", email: "norbert@example.com" },
      providers: [
        { id: "codex", state: "available", version: "0.144.1", message: null },
        {
          id: "claude",
          state: "not-installed",
          version: null,
          message: "Claude CLI was not found.",
        },
      ],
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
      message: null,
      fullAccess: true,
    });
    render(() => <App />);

    const trigger = await screen.findByRole("button", { name: "Onboarding model: Luna" });
    await fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    expect(within(picker).getByRole("tab", { name: /^Codex: 0.144.1/ })).toBeEnabled();
    const claude = within(picker).getByRole("tab", {
      name: "Claude: Claude CLI was not found.",
    });
    expect(claude).toBeEnabled();

    await fireEvent.click(claude);
    expect(within(picker).getByText("Claude CLI was not found.")).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "Claude Opus 5, default" })).toBeDisabled();
  });

  it("does not remount agent text fields or discard in-progress edits on bot list refresh", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const name = await screen.findByRole("textbox", { name: "Agent name" });
    name.focus();
    let draft = "";
    let refresh = 0;
    for (const character of "Draft coordinator name") {
      draft += character;
      await fireEvent.input(name, { target: { value: draft } });
      refresh += 1;
      emitAgentEvent?.({
        type: "bots-changed",
        bots: BOTS.map((bot) =>
          bot.id === "chief"
            ? { ...bot, preview: `Backend refresh ${refresh}`, notifications: refresh % 2 === 0 }
            : bot,
        ),
      });
      expect(name).toHaveValue(draft);
      expect(name).toHaveFocus();
    }

    expect(screen.getByRole("textbox", { name: "Agent name" })).toBe(name);
    expect(name).toHaveValue("Draft coordinator name");

    const title = screen.getByRole("textbox", { name: "Agent title" });
    title.focus();
    draft = "";
    for (const character of "Research lead") {
      draft += character;
      await fireEvent.input(title, { target: { value: draft } });
      refresh += 1;
      emitAgentEvent?.({
        type: "bots-changed",
        bots: BOTS.map((bot) =>
          bot.id === "chief"
            ? { ...bot, preview: `Backend refresh ${refresh}`, notifications: refresh % 2 === 0 }
            : bot,
        ),
      });
      expect(title).toHaveValue(draft);
      expect(title).toHaveFocus();
    }
    expect(screen.getByRole("textbox", { name: "Agent title" })).toBe(title);

    const description = screen.getByRole("textbox", { name: "Agent description" });
    description.focus();
    draft = "";
    for (const character of "Tracks every research request.") {
      draft += character;
      await fireEvent.input(description, { target: { value: draft } });
      refresh += 1;
      emitAgentEvent?.({
        type: "bots-changed",
        bots: BOTS.map((bot) =>
          bot.id === "chief"
            ? { ...bot, preview: `Backend refresh ${refresh}`, notifications: refresh % 2 === 0 }
            : bot,
        ),
      });
      expect(description).toHaveValue(draft);
      expect(description).toHaveFocus();
    }
    expect(screen.getByRole("textbox", { name: "Agent description" })).toBe(description);
  });

  it("opens conversation search with the primary Find shortcut and restores focus on Escape", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const searchReturnTarget = screen.getByRole("button", { name: "View agent settings" });
    searchReturnTarget.focus();

    await fireEvent.keyDown(searchReturnTarget, { key: "f", metaKey: true });

    const search = screen.getByRole("search", { name: "Search conversation" });
    const input = screen.getByRole("searchbox", { name: "Search messages" });
    expect(search).toBeVisible();
    await waitFor(() => expect(input).toHaveFocus());

    await fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "Search conversation" })).not.toBeInTheDocument();
    await waitFor(() => expect(searchReturnTarget).toHaveFocus());
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
            text: "Quarterly launch notes are ready for review.",
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
                text: "Quarterly launch notes are ready for review.",
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
    await waitFor(() => expect(input).toHaveFocus());

    await fireEvent.click(screen.getByRole("tab", { name: "Messages" }));
    await fireEvent.input(input, { target: { value: "quarterly" } });
    const messageResult = await screen.findByRole("option", { name: /Quarterly launch notes/ });
    await fireEvent.click(messageResult);
    await screen.findByRole("heading", { name: "Sales Outbound" });
    expect(window.openbot.agent.searchConversationMessages).toHaveBeenCalledWith({
      query: "quarterly",
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

    const frame = screen.getByRole("main", { name: "Conversation" }).closest(".app-frame");
    const sidebarToggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(sidebarToggle).toHaveClass("sidebar-icon-button");
    expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(sidebarToggle);

    expect(screen.getByRole("complementary", { name: "Bot navigation" })).toHaveClass("sidebar-compact");
    expect(screen.getByRole("separator", { name: "Resize left sidebar" })).toHaveAttribute("aria-valuenow", "88");
    expect(frame).toHaveClass("app-frame-sidebar-compact");
    expect(frame).toHaveStyle("--left-panel-width: 88px");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Show sidebar" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");

    await fireEvent.click(screen.getByRole("button", { name: "Expand sidebar and search chats" }));

    expect(screen.getByRole("complementary", { name: "Bot navigation" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize left sidebar" })).toHaveAttribute("aria-valuenow", "280");
    expect(frame).not.toHaveClass("app-frame-sidebar-compact");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search chats" })).toHaveFocus());
  });

  it("snaps drag resizing between compact and expanded widths with hysteresis", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const resizer = screen.getByRole("separator", { name: "Resize left sidebar" });

    await fireEvent.pointerDown(resizer, { button: 0, pointerId: 1, clientX: 280 });
    await fireEvent.pointerMove(window, { pointerId: 1, clientX: 209 });
    await fireEvent.pointerUp(window, { pointerId: 1, clientX: 209 });
    expect(resizer).toHaveAttribute("aria-valuenow", "88");

    await fireEvent.pointerDown(resizer, { button: 0, pointerId: 2, clientX: 100 });
    await fireEvent.pointerMove(window, { pointerId: 2, clientX: 231 });
    expect(resizer).toHaveAttribute("aria-valuenow", "88");
    await fireEvent.pointerMove(window, { pointerId: 2, clientX: 232 });
    await fireEvent.pointerUp(window, { pointerId: 2, clientX: 232 });
    expect(resizer).toHaveAttribute("aria-valuenow", "240");
  });

  it("auto-compacts for conversation space and restores without changing user preference", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 759 });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const frame = screen.getByRole("main", { name: "Conversation" }).closest(".app-frame");

    await waitFor(() => expect(frame).toHaveClass("app-frame-sidebar-compact"));
    expect(frame).toHaveStyle("--left-panel-width: 88px");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBeNull();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(frame).not.toHaveClass("app-frame-sidebar-compact"));
    expect(frame).toHaveStyle("--left-panel-width: 280px");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBeNull();
  });

  it("migrates old narrow sidebar widths to the expanded minimum", async () => {
    window.localStorage.setItem("openbot:left-panel-width", "220");
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    expect(screen.getByRole("separator", { name: "Resize left sidebar" })).toHaveAttribute("aria-valuenow", "240");
  });

  it("defaults the embedded browser to half of the conversation container", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-browser-split",
          title: "Browser split",
          url: "https://example.com",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerBotId: "chief",
        },
      ],
      activeTabId: "tab-browser-split",
    });
    const conversation = screen.getByRole("main", { name: "Conversation" });
    Object.defineProperty(conversation, "clientWidth", { configurable: true, value: 800 });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));

    expect(await screen.findByRole("separator", { name: "Resize right panel" })).toHaveAttribute(
      "aria-valuenow",
      "400",
    );
    expect(conversation).toHaveStyle("--browser-panel-width: 400px");
    const resizer = screen.getByRole("separator", { name: "Resize right panel" });
    await waitFor(() => expect(resizer).toHaveAttribute("aria-valuenow", "400"));

    Object.defineProperty(conversation, "clientWidth", { configurable: true, value: 1000 });
    await waitFor(() => {
      triggerResize(conversation);
      expect(resizer).toHaveAttribute("aria-valuenow", "500");
    });
    expect(conversation).toHaveStyle("--browser-panel-width: 500px");

    await fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(resizer).toHaveAttribute("aria-valuenow", "512");
    expect(window.localStorage.getItem("openbot:browser-panel-width")).toBe("512");

    Object.defineProperty(conversation, "clientWidth", { configurable: true, value: 400 });
    await waitFor(() => {
      triggerResize(conversation);
      expect(resizer).toHaveAttribute("aria-valuenow", "304");
    });
    expect(window.localStorage.getItem("openbot:browser-panel-width")).toBe("512");

    Object.defineProperty(conversation, "clientWidth", { configurable: true, value: 1200 });
    await waitFor(() => {
      triggerResize(conversation);
      expect(resizer).toHaveAttribute("aria-valuenow", "512");
    });
    expect(conversation).toHaveStyle("--browser-panel-width: 512px");

    await fireEvent.dblClick(resizer);
    expect(window.localStorage.getItem("openbot:browser-panel-width")).toBeNull();
    expect(resizer).toHaveAttribute("aria-valuenow", "600");

    Object.defineProperty(conversation, "clientWidth", { configurable: true, value: 800 });
    await fireEvent(window, new Event("resize"));
    expect(resizer).toHaveAttribute("aria-valuenow", "400");
  });

  it("moves the live embedded browser between the sidebar and Picture in Picture", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
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
          ownerBotId: "chief",
        },
      ],
      activeTabId: "tab-pip",
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    const conversation = screen.getByRole("main", { name: "Conversation" });
    expect(await screen.findByRole("complementary", { name: "Browser" })).not.toHaveClass("browser-panel-pip");
    expect(conversation).toHaveClass("browser-panel-active");

    await fireEvent.click(screen.getByRole("button", { name: "Open browser Picture in Picture" }));

    const pip = await screen.findByRole("complementary", { name: "Browser" });
    expect(pip).toHaveClass("browser-panel-pip");
    expect(pip).toHaveStyle({ left: "588px", top: "400px", width: "420px", height: "300px" });
    expect(pip).toHaveTextContent("Picture in Picture test");
    expect(conversation).not.toHaveClass("browser-panel-active");
    const address = screen.getByRole("textbox", { name: "Browser address" });
    expect(address).toHaveValue("https://example.com/pip");
    await fireEvent.focus(address);
    await fireEvent.input(address, { target: { value: "example.com/typed" } });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-pip",
          title: "Updated while typing",
          url: "https://example.com/updated",
          loading: true,
          ownerThreadId: "thread-chief",
          ownerBotId: "chief",
        },
      ],
      activeTabId: "tab-pip",
    });
    expect(address).toHaveValue("example.com/typed");
    await fireEvent.blur(address);
    expect(address).toHaveValue("https://example.com/updated");

    vi.mocked(window.openbot.browser.open).mockResolvedValueOnce({
      id: "tab-next",
      title: "Next page",
      url: "https://example.com/next",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
    });
    await fireEvent.focus(address);
    await fireEvent.input(address, { target: { value: "example.com/next" } });
    const addressForm = address.closest("form");
    if (!(addressForm instanceof HTMLFormElement)) throw new Error("Browser address form was not rendered.");
    await fireEvent.submit(addressForm);
    await waitFor(() => expect(window.openbot.browser.open).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("complementary", { name: "Browser" })).toHaveClass("browser-panel-pip");

    vi.mocked(window.openbot.browser.setVisible).mockClear();
    await fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Search OpenBot" })).toBeInTheDocument();
    await waitFor(() => expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith({ visible: false }));
    await fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search OpenBot" })).not.toBeInTheDocument());
    await waitFor(() =>
      expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true })),
    );

    const header = pip.querySelector(".browser-pip-header");
    if (!(header instanceof HTMLElement)) throw new Error("Picture in Picture header was not rendered.");
    const surface = pip.querySelector(".browser-surface");
    if (!(surface instanceof HTMLElement)) throw new Error("Picture in Picture browser surface was not rendered.");
    vi.spyOn(surface, "getBoundingClientRect").mockImplementation(() => {
      const left = Number.parseFloat(pip.style.left);
      const top = Number.parseFloat(pip.style.top);
      const width = Number.parseFloat(pip.style.width);
      const height = Number.parseFloat(pip.style.height);
      return {
        x: left + 7,
        y: top + 73,
        width: width - 14,
        height: height - 80,
        top: top + 73,
        right: left + width - 7,
        bottom: top + height - 7,
        left: left + 7,
        toJSON: () => ({}),
      };
    });
    vi.mocked(window.openbot.browser.setVisible).mockClear();
    await fireEvent.pointerDown(header, { button: 0, pointerId: 7, clientX: 600, clientY: 460 });
    await fireEvent.pointerMove(window, { pointerId: 7, clientX: 560, clientY: 420 });
    await fireEvent.pointerUp(window, { pointerId: 7, clientX: 560, clientY: 420 });
    expect(window.localStorage.getItem("openbot:browser-pip-bounds")).toBe("548,360,420,300");
    await waitFor(() =>
      expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith({
        visible: true,
        bounds: { x: 555, y: 433, width: 406, height: 220 },
      }),
    );

    const resizeHandle = pip.querySelector(".browser-pip-resize-bottom-right");
    if (!(resizeHandle instanceof HTMLElement)) throw new Error("Picture in Picture resize handle was not rendered.");
    await fireEvent.pointerDown(resizeHandle, { button: 0, pointerId: 8, clientX: 968, clientY: 712 });
    await fireEvent.pointerMove(window, { pointerId: 8, clientX: 928, clientY: 682 });
    await fireEvent.pointerUp(window, { pointerId: 8, clientX: 928, clientY: 682 });
    expect(window.localStorage.getItem("openbot:browser-pip-bounds")).toBe("548,360,380,270");

    await fireEvent.click(screen.getByRole("button", { name: "Dock browser to right sidebar" }));
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Browser" })).not.toHaveClass("browser-panel-pip"),
    );
    expect(conversation).toHaveClass("browser-panel-active");
    await fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(window.openbot.browser.reload).toHaveBeenCalledWith("tab-pip");
    expect(window.openbot.browser.open).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "Open browser Picture in Picture" }));
    const reopenedPip = await screen.findByRole("complementary", { name: "Browser" });
    expect(reopenedPip).toHaveStyle({ left: "628px", top: "430px", width: "380px", height: "270px" });
    await fireEvent.click(screen.getByRole("button", { name: "Hide browser" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument());
    expect(window.openbot.browser.close).not.toHaveBeenCalled();
    expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith({ visible: false });
  });

  it("clamps and restores Picture in Picture per conversation without overriding it during agent control", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    window.localStorage.setItem("openbot:browser-pip-bounds", "-50,-50,2000,2000");
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
          ownerBotId: "chief",
        },
      ],
      activeTabId: "tab-pip-restore",
    });
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open browser Picture in Picture" }));

    const pip = await screen.findByRole("complementary", { name: "Browser" });
    expect(pip).toHaveClass("browser-panel-pip");
    expect(pip).toHaveStyle({ left: "12px", top: "12px", width: "1000px", height: "744px" });

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
    expect(screen.getByRole("complementary", { name: "Browser" })).toHaveClass("browser-panel-pip");

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument());
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(await screen.findByRole("complementary", { name: "Browser" })).toHaveClass("browser-panel-pip");
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
    expect(controlledTab).toHaveAttribute("aria-description", "Press Delete or Control/Command W to close");
    expect(await screen.findByRole("complementary", { name: "Browser" })).toHaveClass("browser-panel-controlled");
    const browserTabStrip = document.querySelector(".browser-tab-strip");
    expect(browserTabStrip?.querySelectorAll(".browser-tab-wrap")).toHaveLength(3);
    expect(browserTabStrip).not.toContainElement(screen.getByRole("button", { name: "New browser tab" }));
    await fireEvent.keyDown(screen.getByRole("tab", { name: "Third page" }), { key: "Delete" });
    expect(window.openbot.browser.close).toHaveBeenCalledWith("tab-3");
    expect(screen.queryByRole("button", { name: "Hide browser panel" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(window.openbot.browser.open).toHaveBeenCalledWith({
      url: "https://www.google.com",
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
    });
    expect(screen.queryByText("Typing…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chief is controlling the browser" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Chief is controlling the browser" })).toHaveClass("header-panel-toggle");

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
    expect(screen.getByRole("tab", { name: "Local smoke page, controlled by Chief" })).toBe(controlledTab);

    emitAgentEvent?.({ type: "browser-control-changed", state: { sessions: [] } });
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Local smoke page, controlled by Chief" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "Local smoke page" })).toBe(controlledTab);
    expect(controlledTab.closest(".browser-tab-wrap")).not.toHaveClass("browser-tab-controlled");
    expect(await screen.findByRole("complementary", { name: "Browser" })).not.toHaveClass("browser-panel-controlled");
  });

  it("closes browser tabs with the middle mouse button and Control W, then closes the panel", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const firstTab = {
      id: "tab-shortcut-1",
      title: "First page",
      url: "https://example.com/first",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
    };
    const secondTab = {
      id: "tab-shortcut-2",
      title: "Second page",
      url: "https://example.com/second",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
    };
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [firstTab, secondTab],
      activeTabId: firstTab.id,
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    await fireEvent.pointerDown(screen.getByRole("tab", { name: "Second page" }), { button: 1 });
    expect(window.openbot.browser.close).toHaveBeenCalledWith(secondTab.id);

    emitAgentEvent?.({ type: "browser-changed", tabs: [firstTab], activeTabId: firstTab.id });
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Second page" })).not.toBeInTheDocument());
    await fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(window.openbot.browser.close).toHaveBeenLastCalledWith(firstTab.id);
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument());
    expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith({ visible: false });
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
          ownerBotId: "chief",
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

  it("updates embedded browser bounds when the window moves browser surface", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-resize",
          title: "Resize test",
          url: "https://example.com",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerBotId: "chief",
        },
      ],
      activeTabId: "tab-resize",
    });
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    const surface = document.querySelector(".browser-surface");
    if (!(surface instanceof HTMLElement)) throw new Error("Browser surface was not rendered.");
    await waitFor(() =>
      expect(window.openbot.browser.setVisible).toHaveBeenCalledWith(expect.objectContaining({ visible: true })),
    );
    vi.mocked(window.openbot.browser.setVisible).mockClear();
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 640,
      y: 73,
      width: 380,
      height: 600,
      top: 73,
      right: 1020,
      bottom: 673,
      left: 640,
      toJSON: () => ({}),
    });

    window.dispatchEvent(new Event("resize"));

    await waitFor(() =>
      expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith({
        visible: true,
        bounds: { x: 640, y: 73, width: 380, height: 600 },
      }),
    );
  });

  it("closes settings on agent switch but restores browser panels", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    expect(await screen.findByRole("complementary", { name: "Agent settings" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    expect(screen.queryByRole("complementary", { name: "Agent settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open computer" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(await screen.findByRole("complementary", { name: "Browser" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(screen.queryByRole("complementary", { name: "Agent settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    expect(await screen.findByRole("complementary", { name: "Browser" })).toBeInTheDocument();
  });

  it("queues from the composer and clears only after success", async () => {
    render(() => <App />);
    await confirmOnboardingModel();
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
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith({
        botId: "chief",
        throughMessageId: "delivery-1",
      }),
    );
    await waitFor(() => expect(composer).toHaveTextContent(""));
    expect(trackAnalytics).toHaveBeenCalledWith("message_sent", {
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoning_effort: "medium",
      server_kind: "local",
      channel: "agent",
      attachment_count: 0,
      is_reply: false,
      delivery_count: 1,
    });
  });

  it("keeps the composer compact until the draft becomes multiline", async () => {
    render(() => <App />);
    await confirmOnboardingModel();
    const editor = screen.getByRole("textbox", { name: "Message Chief" });
    const composer = editor.closest(".composer");

    expect(composer).toHaveAttribute("data-compact");

    editor.textContent = "Start a message";
    await fireEvent.input(editor);
    expect(composer).toHaveAttribute("data-compact");

    editor.textContent = "Start a message\nContinue here";
    await fireEvent.input(editor);
    expect(composer).not.toHaveAttribute("data-compact");

    editor.textContent = "Start a message";
    await fireEvent.input(editor);
    expect(composer).toHaveAttribute("data-compact");
  });

  it("publishes typing state", async () => {
    render(() => <App />);
    await confirmOnboardingModel();
    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Review this";
    await fireEvent.input(composer);
    await waitFor(() =>
      expect(window.openbot.servers.setTyping).toHaveBeenCalledWith({
        botId: "chief",
        typing: true,
      }),
    );
  });

  it("opens a private person thread and receives direct messages in real time", async () => {
    vi.mocked(window.openbot.servers.markDirectRead).mockRejectedValueOnce(new Error("Read state unavailable"));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        {
          id: "member-self",
          username: "person@example.com",
          email: "person@example.com",
          name: "Person",
          role: "owner",
          createdAt: "2026-08-18T10:00:00.000Z",
          disabled: false,
          online: true,
          typingBotId: null,
        },
        {
          id: "member-alice",
          username: "alice@example.com",
          email: "alice@example.com",
          name: "Alice",
          role: "member",
          createdAt: "2026-08-18T11:00:00.000Z",
          disabled: false,
          online: true,
          typingBotId: null,
        },
      ],
    });

    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    expect(await screen.findByRole("main", { name: "Direct conversation with Alice" })).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Message Alice" });
    await fireEvent.input(input, { target: { value: "Hello Alice" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.servers.sendDirectMessage).toHaveBeenCalledWith(
        expect.objectContaining({ memberId: "member-alice", text: "Hello Alice" }),
      ),
    );
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 1,
      }),
    );
    expect(await screen.findByText("Hello Alice")).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(""));
    expect(await screen.findByText("Read state unavailable")).toBeInTheDocument();

    emitDirectTyping?.({
      type: "team-direct-typing",
      senderMemberId: "member-alice",
      recipientMemberId: "member-self",
      typing: true,
    });
    expect(await screen.findByText("Alice is typing")).toBeInTheDocument();

    emitDirectMessage?.({
      type: "team-direct-message",
      memberIds: ["member-alice", "member-self"],
      message: {
        id: "message-alice-1",
        threadId: "thread-member-alice",
        senderMemberId: "member-alice",
        recipientMemberId: "member-self",
        text: "Hi. I am here.",
        createdAt: "2026-08-19T10:01:00.000Z",
        sequence: 2,
      },
    });
    const incomingMessage = await screen.findByText("Hi. I am here.");
    expect(incomingMessage).toBeInTheDocument();
    expect(incomingMessage.closest(".direct-message")?.querySelector(".person-avatar")).toBeNull();
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 2,
      }),
    );
  });

  it("does not expose team conversations when the signed-in account is not a member", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-smoke",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [presenceMember("member-smoke", "codex-smoke@example.invalid", "Codex Smoke")],
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /codex-smoke@example\.invalid/i })).not.toBeInTheDocument();
    });
    expect(window.openbot.servers.readDirectConversation).not.toHaveBeenCalled();
    expect(window.openbot.servers.listDirectThreads).not.toHaveBeenCalled();
  });

  it("does not apply a stale direct-message load after another person is selected", async () => {
    let resolveAlice: ((snapshot: DirectConversationSnapshot) => void) | undefined;
    vi.mocked(window.openbot.servers.readDirectConversation).mockImplementation((memberId) => {
      if (memberId === "member-alice") {
        return new Promise((resolve) => {
          resolveAlice = resolve;
        });
      }
      return Promise.resolve({
        threadId: "thread-member-bob",
        otherMemberId: "member-bob",
        messages: [
          {
            id: "message-bob",
            threadId: "thread-member-bob",
            senderMemberId: "member-bob",
            recipientMemberId: "member-self",
            text: "Bob history",
            createdAt: "2026-08-19T09:00:00.000Z",
            sequence: 1,
          },
        ],
        revision: 1,
      });
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitPresence?.({
      serverId: "server-1",
      updatedAt: "2026-08-19T10:00:00.000Z",
      members: [
        presenceMember("member-self", "person@example.com", "Person"),
        presenceMember("member-alice", "alice@example.com", "Alice"),
        presenceMember("member-bob", "bob@example.com", "Bob"),
      ],
    });

    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    await fireEvent.click(screen.getByRole("button", { name: /Bob/ }));
    expect(await screen.findByText("Bob history")).toBeInTheDocument();
    resolveAlice?.({
      threadId: "thread-member-alice",
      otherMemberId: "member-alice",
      messages: [],
      revision: 0,
    });

    await waitFor(() => expect(screen.getByRole("main", { name: "Direct conversation with Bob" })).toBeInTheDocument());
    expect(screen.getByText("Bob history")).toBeInTheDocument();
  });

  it("keeps a queued message out of chat until work starts", async () => {
    vi.mocked(window.openbot.agent.sendMessage).mockImplementationOnce(async (input) => {
      const delivery = queuedDelivery("delivery-visible", input.text, 1);
      emitAgentEvent?.({
        type: "conversation",
        snapshot: {
          botId: input.botId,
          threadId: "thread-chief",
          activeTurnId: null,
          revision: 1,
          messages: [
            {
              id: delivery.id,
              author: "user",
              text: input.text,
              createdAt: delivery.createdAt,
              status: "completed",
              delivery: { id: delivery.id, status: "queued", position: 1 },
            },
          ],
        },
      });
      emitAgentEvent?.({
        type: "queue-changed",
        snapshot: { botId: input.botId, deliveries: [delivery] },
      });
      return {
        messageId: delivery.messageId,
        deliveries: [{ id: delivery.id, recipientBotId: input.botId, status: "queued", position: 1 }],
      };
    });

    render(() => <App />);
    await confirmOnboardingModel();
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Show this message";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(window.openbot.agent.sendMessage).toHaveBeenCalledOnce());
    expect(screen.queryByText("Show this message", { selector: ".agent-queue-message" })).not.toBeInTheDocument();
    expect(document.querySelector(".agent-queue-panel")).toBeNull();
    expect(screen.queryByText("Show this message", { selector: ".message-copy" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Choose a model to get started.")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("radiogroup", { name: "What do you want me helping with most?" }),
      ).not.toBeInTheDocument();
    });

    const started = queuedDelivery("delivery-visible", "Show this message", null, { status: "starting" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 2,
        messages: [
          {
            id: started.id,
            author: "user",
            text: started.text,
            createdAt: started.createdAt,
            status: "completed",
            delivery: { id: started.id, status: "starting", position: null },
          },
        ],
      },
    });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [started] },
    });

    expect(await screen.findByText("Show this message", { selector: ".message-copy" })).toBeInTheDocument();
    expect(screen.queryByText("Show this message", { selector: ".agent-queue-message" })).not.toBeInTheDocument();
    expect(document.querySelector(".agent-queue-slot")).toHaveAttribute("data-open", "false");
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

  it("sends an action for selected agent text without clearing the composer draft", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const answer = "The launch note needs a friendlier closing sentence.";
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "assistant-selection",
            author: "assistant",
            text: answer,
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    const message = await screen.findByText(answer);
    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Keep this draft";
    await fireEvent.input(composer);

    const text = message.firstChild;
    if (!text) throw new Error("Agent message did not render a text node");
    const quote = "friendlier closing sentence";
    const start = answer.indexOf(quote);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + quote.length);
    Object.defineProperty(range, "getClientRects", {
      configurable: true,
      value: () => [{ top: 100, right: 320, bottom: 120, left: 120, width: 200, height: 20 }],
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    await fireEvent.pointerUp(message);

    await fireEvent.click(await screen.findByRole("button", { name: "Improve" }));
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "Improve this selected text.\n\n> friendlier closing sentence",
        attachmentDraftIds: [],
        replyToMessageId: "assistant-selection",
      }),
    );
    expect(composer).toHaveTextContent("Keep this draft");
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
    await fireEvent.pointerDown(screen.getByRole("button", { name: "Add reaction" }), { button: 0 });
    await fireEvent.pointerUp(screen.getByRole("menuitemradio", { name: "React with ❤️" }), { button: 0 });
    expect(window.openbot.agent.setMessageReaction).toHaveBeenCalledWith({
      botId: "chief",
      messageId: "assistant-actions",
      emoji: "❤️",
    });

    await fireEvent.pointerDown(screen.getByRole("button", { name: "More message actions" }), { button: 0 });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Copy" }), { button: 0 });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Ready to ship."));
  });

  it("keeps agent activity at the conversation bottom without replaying existing message entrances", async () => {
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
            turnId: "turn-live",
            author: "user",
            text: "Do the work",
            createdAt,
            status: "completed",
            delivery: { id: "delivery-live", status: "starting", position: null },
          },
        ],
      },
    });
    const firstMessage = await screen.findByText("Do the work");
    const firstMessageEntry = firstMessage.closest(".message-entry");
    expect(firstMessageEntry).not.toHaveClass("message-entry-animated");
    const sidebarAvatar = document.querySelector(".agent-row .bot-avatar");
    expect(sidebarAvatar).toHaveClass("bot-avatar-motion-idle");

    const liveDelivery = queuedDelivery("delivery-live", "Do the work", null, { status: "starting" });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [liveDelivery] },
    });

    emitAgentEvent?.({
      type: "turn-started",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
    });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        deliveries: [{ ...liveDelivery, status: "running", turnId: "turn-live" }],
      },
    });
    const workingIndicator = await screen.findByRole("status", { name: "Chief is working" });
    const firstAnimation = workingIndicator
      .querySelector(".agent-activity-avatar")
      ?.getAttribute("data-animation-state");
    const firstLabel = workingIndicator.querySelector(".agent-activity-label")?.textContent;
    const virtualChatList = document.querySelector(".virtual-chat-list");
    expect(virtualChatList?.nextElementSibling).toBe(workingIndicator.parentElement);
    expect(firstAnimation).toBeTruthy();
    expect(firstLabel).toBeTruthy();
    expect(sidebarAvatar).toHaveClass("bot-avatar-motion-working");

    const scrollElement = document.querySelector<HTMLElement>(".conversation-scroll");
    const activitySlot = workingIndicator.parentElement;
    if (!scrollElement || !activitySlot) throw new Error("Conversation scroll elements are missing.");
    let scrollHeight = 900;
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scrollElement.scrollTop = 400;
    scrollHeight = 940;
    triggerResize(activitySlot);
    expect(scrollElement.scrollTop).toBe(940);

    scrollElement.scrollTop = 100;
    await fireEvent.scroll(scrollElement);
    scrollHeight = 1_000;
    triggerResize(activitySlot);
    expect(scrollElement.scrollTop).toBe(100);
    scrollElement.scrollTop = 500;
    await fireEvent.scroll(scrollElement);

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
            turnId: "turn-live",
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
    expect(screen.getByText("Do the work").closest(".user-bubble")).not.toHaveTextContent("Working");
    expect(workingIndicator.querySelector(".agent-activity-avatar")).toHaveAttribute(
      "data-animation-state",
      firstAnimation,
    );
    expect(workingIndicator.querySelector(".agent-activity-label")).toHaveTextContent(firstLabel ?? "");

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
            turnId: "turn-live",
            author: "user",
            text: "Do the work",
            createdAt,
            status: "completed",
            delivery: { id: "delivery-live", status: "running", position: null },
          },
          {
            id: "assistant-live",
            turnId: "turn-live",
            author: "assistant",
            text: "I am on it",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "streaming",
          },
        ],
      },
    });
    const streamingAnswer = await screen.findByText("I am on it");
    const streamingMessageEntry = streamingAnswer.closest(".message-entry");
    const streamingBubble = streamingAnswer.closest(".bot-bubble");
    expect(streamingMessageEntry).toHaveClass("message-entry-animated");
    expect(streamingBubble).toHaveClass("bot-bubble-streaming");
    expect(screen.queryByText("Typing…")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Chief is working" })).toBe(workingIndicator);
    expect(virtualChatList?.nextElementSibling).toBe(workingIndicator.parentElement);
    expect(streamingMessageEntry?.compareDocumentPosition(workingIndicator) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

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
    expect(screen.queryByText("I am on it now")).not.toBeInTheDocument();
    const updatedStreamingAnswer = await screen.findByText("I am on it now");
    expect(updatedStreamingAnswer.closest(".bot-bubble")).toBe(streamingBubble);
    expect(screen.getByText("Do the work").closest(".message-entry")).toBe(firstMessageEntry);
    expect(screen.getByRole("status", { name: "Chief is working" })).toBe(workingIndicator);

    for (const [revision, text] of [
      [5, "I am on it now.\n\nFirst buffered line"],
      [6, "I am on it now.\n\nFinal buffered line"],
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
              turnId: "turn-live",
              author: "user",
              text: "Do the work",
              createdAt,
              status: "completed",
              delivery: { id: "delivery-live", status: "running", position: null },
            },
            {
              id: "assistant-live",
              turnId: "turn-live",
              author: "assistant",
              text,
              createdAt: "2026-08-12T10:00:01.000Z",
              status: "streaming",
            },
          ],
        },
      });
    }
    const bufferedAnswer = await screen.findByText("Final buffered line");
    expect(bufferedAnswer.closest(".bot-bubble")).toBe(streamingBubble);
    expect(screen.queryByText("First buffered line")).not.toBeInTheDocument();

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      status: "completed",
    });
    expect(screen.getByRole("status", { name: "Chief is working" })).toHaveAttribute("data-state", "active");
    await new Promise((resolve) => window.setTimeout(resolve, 160));
    expect(screen.getByRole("status", { name: "Chief is working" })).toHaveAttribute("data-state", "active");

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-live",
        revision: 7,
        messages: [
          {
            id: "delivery-live",
            turnId: "turn-live",
            author: "user",
            text: "Do the work",
            createdAt,
            status: "completed",
          },
          {
            id: "assistant-live",
            turnId: "turn-live",
            author: "assistant",
            text: "I am on it now.\n\nFinal buffered line",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "completed",
          },
        ],
      },
    });
    await waitFor(() => expect(streamingBubble).not.toHaveClass("bot-bubble-streaming"));
    expect(screen.getByRole("status", { name: "Chief is working" })).toHaveAttribute("data-state", "active");
    await new Promise((resolve) => window.setTimeout(resolve, 420));
    expect(screen.getByRole("status", { name: "Chief is working" })).toHaveAttribute("data-state", "active");
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Chief is working" })).toHaveAttribute("data-state", "exiting"),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "Chief is working" })).not.toBeInTheDocument());
    expect(sidebarAvatar).toHaveClass("bot-avatar-motion-idle");
    expect(document.querySelector(".agent-activity-entry")).toBeNull();
    expect(activitySlot).toHaveAttribute("data-reserved", "true");

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-next",
        revision: 8,
        messages: [
          {
            id: "delivery-live",
            author: "user",
            text: "Do the work",
            createdAt,
            status: "completed",
          },
          {
            id: "assistant-live",
            author: "assistant",
            text: "I am on it now.\n\nFinal buffered line",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "completed",
          },
          {
            id: "delivery-next",
            turnId: "turn-next",
            author: "user",
            text: "Do the next thing",
            createdAt: "2026-08-12T10:00:02.000Z",
            status: "completed",
          },
        ],
      },
    });
    const nextIndicator = await screen.findByRole("status", { name: "Chief is working" });
    expect(nextIndicator.querySelector(".agent-activity-avatar")).not.toHaveAttribute(
      "data-animation-state",
      firstAnimation,
    );
    expect(nextIndicator.querySelector(".agent-activity-label")).not.toHaveTextContent(firstLabel ?? "");

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-next",
      status: "failed",
    });
    await waitFor(() => expect(screen.queryByRole("status", { name: "Chief is working" })).not.toBeInTheDocument());
  });

  it("does not flash agent activity when a turn completes before the entrance delay", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const delivery = queuedDelivery("delivery-fast", "Quick answer", null, {
      status: "running",
      turnId: "turn-fast",
    });

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-fast",
        revision: 1,
        messages: [
          {
            id: delivery.id,
            turnId: "turn-fast",
            author: "user",
            text: delivery.text,
            createdAt: delivery.createdAt,
            status: "completed",
            delivery: { id: delivery.id, status: "running", position: null },
          },
        ],
      },
    });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [delivery] },
    });
    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-fast",
      status: "completed",
    });

    await new Promise((resolve) => window.setTimeout(resolve, 180));
    expect(screen.queryByRole("status", { name: "Chief is working" })).not.toBeInTheDocument();
  });

  it("replaces a live image-generation placeholder with the completed image", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const turnId = "turn-image-live";
    const imageAttachment = attachment("image-live", "generated-image.png", "image");

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: turnId,
        revision: 1,
        messages: [
          {
            id: "user-image-live",
            turnId,
            author: "user",
            text: "Create a landscape image of a quiet observatory.",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
          {
            id: "image-live",
            turnId,
            author: "assistant",
            text: "",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "streaming",
            itemType: "image_generation",
            imageGeneration: {
              prompt: "A quiet observatory above the clouds at blue hour",
              resolution: "1536 × 1024",
              aspectRatio: "landscape",
            },
          },
        ],
      },
    });

    expect(await screen.findByRole("img", { name: "Generating image" })).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByRole("status", { name: "Chief is working" })).toBeInTheDocument();

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: turnId,
        revision: 2,
        messages: [
          {
            id: "user-image-live",
            turnId,
            author: "user",
            text: "Create a landscape image of a quiet observatory.",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
          {
            id: "image-live",
            turnId,
            author: "assistant",
            text: "",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "completed",
            itemType: "image_generation",
            imageGeneration: {
              prompt: "A quiet observatory above the clouds at blue hour",
              resolution: "1536 × 1024",
              aspectRatio: "landscape",
            },
            attachments: [imageAttachment],
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Preview generated image" })).toBeInTheDocument());
    expect(screen.getByRole("status", { name: "Chief is working" })).toBeInTheDocument();
    expect(screen.queryByText("Generating image")).not.toBeInTheDocument();

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId,
      status: "completed",
    });
    await waitFor(() => expect(screen.queryByRole("status", { name: "Chief is working" })).not.toBeInTheDocument());

    await fireEvent.click(screen.getByRole("button", { name: "Download generated image" }));
    expect(window.openbot.agent.openAttachment).toHaveBeenCalledWith({
      attachmentId: imageAttachment.id,
      action: "download",
    });
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
    vi.mocked(window.openbot.agent.sendMessage).mockRejectedValueOnce(new Error("Mailbox unavailable"));
    render(() => <App />);
    await confirmOnboardingModel();
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Retry me";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText("Mailbox unavailable")).toBeInTheDocument();
    expect(composer).toHaveTextContent("Retry me");
  });

  it("supports picker and attachment-only messages", async () => {
    const filePickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await fireEvent.pointerDown(screen.getByRole("button", { name: "Add to prompt" }), { button: 0 });
    await fireEvent.pointerDown(screen.getByRole("menuitem", { name: /Attach image/ }), { button: 0 });
    expect(filePickerClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLInputElement>('input[type="file"][accept]')?.accept).toBe(
      ".png,.jpg,.jpeg,.gif,.webp,.avif",
    );
    await fireEvent.pointerDown(screen.getByRole("button", { name: "Add to prompt" }), { button: 0 });
    expect(screen.getByRole("menuitem", { name: /Use a skill/ })).toHaveAttribute("data-disabled");
    await fireEvent.pointerDown(screen.getByRole("menuitem", { name: /Add context/ }), { button: 0 });
    expect(filePickerClick).toHaveBeenCalledTimes(2);
    emitAttachmentImport?.({ type: "started", requestId: "picker-1" });
    emitAttachmentImport?.({
      type: "completed",
      requestId: "picker-1",
      attachments: [attachment("draft-1", "brief.pdf", "pdf")],
    });
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
    expect(await screen.findByRole("button", { name: "Remove pasted.png" })).toBeInTheDocument();
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

    expect(screen.queryByRole("button", { name: "Remove for-chief.png" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(await screen.findByRole("button", { name: "Remove for-chief.png" })).toBeInTheDocument();
  });

  it("shows and controls queued work", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        deliveries: [
          {
            id: "delivery-1",
            messageId: "message-1",
            recipientBotId: "chief",
            sender: { kind: "user" },
            text: "Later",
            attachments: [],
            replyToMessageId: null,
            status: "running",
            position: 1,
            turnId: "turn-1",
            error: null,
            createdAt: new Date().toISOString(),
          },
          {
            id: "delivery-2",
            messageId: "message-2",
            recipientBotId: "chief",
            sender: { kind: "user" },
            text: "Later, too",
            attachments: [],
            replyToMessageId: null,
            status: "queued",
            position: 2,
            turnId: null,
            error: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Delete queued message 2" }));
    await waitFor(() => expect(window.openbot.agent.cancelQueuedMessage).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Resume queue" })).not.toBeInTheDocument();
  });

  it("keeps the first delivery out of Queue until work starts", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const first = queuedDelivery("delivery-foreground", "Start this work", 1);
    const second = queuedDelivery("delivery-waiting-1", "Run this second", 2);
    const third = queuedDelivery("delivery-waiting-2", "Run this third", 3);
    const fourth = queuedDelivery("delivery-waiting-3", "Run this fourth", 4);

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: first.id,
            author: "user",
            text: first.text,
            createdAt: first.createdAt,
            status: "completed",
            delivery: { id: first.id, status: "queued", position: 1 },
          },
        ],
      },
    });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [first] },
    });

    expect(screen.queryByText("Start this work", { selector: ".agent-queue-message" })).not.toBeInTheDocument();
    expect(document.querySelector(".agent-queue-panel")).toBeNull();
    expect(screen.queryByText("Start this work", { selector: ".message-copy" })).not.toBeInTheDocument();

    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [first, second, third, fourth] },
    });
    expect(document.querySelector(".agent-queue-panel")).toBeNull();

    const firstStarting = { ...first, status: "starting" as const, position: null, turnId: "turn-queue" };
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [firstStarting, second, third, fourth] },
    });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-queue",
        revision: 2,
        messages: [
          {
            id: first.id,
            turnId: "turn-queue",
            author: "user",
            text: first.text,
            createdAt: first.createdAt,
            status: "completed",
            delivery: { id: first.id, status: "starting", position: null },
          },
        ],
      },
    });

    const activeMessage = await screen.findByText("Start this work", { selector: ".message-copy" });
    const activity = await screen.findByRole("status", { name: "Chief is working" });
    const activitySlot = activeMessage.closest(".virtual-chat-list")?.nextElementSibling;
    expect(activitySlot).toHaveClass("agent-activity-slot");
    expect(activitySlot).toContainElement(activity);
    expect(screen.getByText("Run this second", { selector: ".agent-queue-message" })).toBeInTheDocument();
    expect(screen.getByText("Run this third", { selector: ".agent-queue-message" })).toBeInTheDocument();
    expect(screen.getByText("Run this fourth", { selector: ".agent-queue-message" })).toBeInTheDocument();
    expect(screen.queryByText("Start this work", { selector: ".agent-queue-message" })).not.toBeInTheDocument();

    const firstWaitingRow = document.querySelector<HTMLFieldSetElement>(".agent-queue-item");
    if (!firstWaitingRow) throw new Error("The first waiting queue row is missing.");
    await fireEvent.keyDown(firstWaitingRow, { key: "ArrowDown", altKey: true });
    await waitFor(() =>
      expect(window.openbot.agent.reorderQueue).toHaveBeenCalledWith({
        botId: "chief",
        deliveryIds: [third.id, second.id, fourth.id],
      }),
    );

    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [firstStarting] },
    });
    const queueSlot = document.querySelector<HTMLElement>(".agent-queue-slot");
    await waitFor(() => expect(document.querySelectorAll(".agent-queue-item-removing")).toHaveLength(3));
    expect(queueSlot).toHaveAttribute("data-open", "true");
    expect(queueSlot).toContainElement(document.querySelector(".agent-queue-panel"));
    await waitFor(() => expect(document.querySelector(".agent-queue-panel")).not.toBeInTheDocument());
    expect(queueSlot).toHaveAttribute("data-open", "false");
    expect(queueSlot).toHaveAttribute("aria-hidden", "true");
  });

  it("smokes two composer submissions through the live Queue projection", async () => {
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 0,
      messages: [
        {
          id: "existing-message",
          author: "assistant",
          text: "Ready for the queue smoke test.",
          createdAt: "2026-08-20T09:59:59.000Z",
          status: "completed",
        },
      ],
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    });
    const deliveries: QueueDelivery[] = [];
    vi.mocked(window.openbot.agent.sendMessage).mockImplementation(async (input) => {
      const delivery = queuedDelivery(`delivery-smoke-${deliveries.length + 1}`, input.text, deliveries.length + 1);
      deliveries.push(delivery);
      emitAgentEvent?.({
        type: "queue-changed",
        snapshot: { botId: input.botId, deliveries: [...deliveries] },
      });
      return {
        messageId: delivery.messageId,
        deliveries: [
          {
            id: delivery.id,
            recipientBotId: delivery.recipientBotId,
            status: delivery.status,
            position: delivery.position,
          },
        ],
      };
    });

    render(() => <App />);
    await screen.findByText("Ready for the queue smoke test.");
    const composer = screen.getByRole("textbox", { name: "Message Chief" });

    composer.textContent = "First live smoke message";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(window.openbot.agent.sendMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(composer).toHaveTextContent(""));
    expect(
      screen.queryByText("First live smoke message", { selector: ".agent-queue-message" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("First live smoke message", { selector: ".message-copy" })).not.toBeInTheDocument();

    const firstDelivery = deliveries[0];
    if (!firstDelivery) throw new Error("The first smoke delivery is missing.");
    deliveries[0] = { ...firstDelivery, status: "running", position: null, turnId: "turn-smoke" };
    emitAgentEvent?.({ type: "turn-started", botId: "chief", threadId: "thread-chief", turnId: "turn-smoke" });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [...deliveries] },
    });

    composer.textContent = "Second live smoke message";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(window.openbot.agent.sendMessage).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText("Second live smoke message", { selector: ".agent-queue-message" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("First live smoke message", { selector: ".agent-queue-message" }),
    ).not.toBeInTheDocument();
  });

  it("keeps foreground starts out of Queue and hides waiting work between turns", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const firstStarting = queuedDelivery("delivery-starting", "Current work", null, { status: "starting" });
    const second = queuedDelivery("delivery-next", "Next work", 1);
    const third = queuedDelivery("delivery-later", "Later work", 2);

    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [firstStarting] },
    });
    expect(document.querySelector(".agent-queue-panel")).toBeNull();

    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [firstStarting, second] },
    });
    expect(await screen.findByText("Next work", { selector: ".agent-queue-message" })).toBeInTheDocument();
    expect(screen.queryByText("Current work", { selector: ".agent-queue-message" })).not.toBeInTheDocument();

    emitAgentEvent?.({ type: "turn-started", botId: "chief", threadId: "thread-chief", turnId: "turn-live" });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        deliveries: [
          { ...firstStarting, status: "running", turnId: "turn-live" },
          { ...second, status: "starting", position: null, turnId: "turn-live" },
          third,
        ],
      },
    });
    await waitFor(() =>
      expect(Array.from(document.querySelectorAll(".agent-queue-message"), (element) => element.textContent)).toEqual([
        "Later work",
        "Next work",
      ]),
    );

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      status: "completed",
    });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        deliveries: [
          { ...second, position: 1, turnId: null },
          { ...third, position: 2 },
        ],
      },
    });
    await waitFor(() => expect(document.querySelector(".agent-queue-panel")).not.toBeInTheDocument());

    const secondStarting = { ...second, status: "starting" as const, position: null, turnId: "turn-next" };
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: { botId: "chief", deliveries: [secondStarting, third] },
    });
    expect(await screen.findByText("Later work", { selector: ".agent-queue-message" })).toBeInTheDocument();
    expect(screen.queryByText("Next work", { selector: ".agent-queue-message" })).not.toBeInTheDocument();
  });

  it("persists the onboarding focus before queuing the first user message", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await fireEvent.click(screen.getByRole("radio", { name: /Work & projects/ }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        title: "Work & projects",
        description:
          "Helps plan, organize, and execute ongoing work and projects while keeping priorities, next steps, and deliverables clear.",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
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
    await confirmOnboardingModel();
    await fireEvent.click(await screen.findByRole("radio", { name: /Something else/ }));
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();

    const customAnswer = screen.getByRole("textbox", { name: "Custom answer" });
    expect(customAnswer).toHaveFocus();
    await fireEvent.input(customAnswer, { target: { value: "Plan product launches" } });
    await fireEvent.keyDown(customAnswer, { key: "Enter" });

    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        title: "Plan product launches",
        description: "Primary focus: Plan product launches.",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
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
    await confirmOnboardingModel();
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
    await fireEvent.click(await screen.findByRole("button", { name: /Something else/ }));
    const answer = await screen.findByRole("textbox", {
      name: "Custom answer for: Which account?",
    });
    await fireEvent.input(answer, { target: { value: "Acme" } });
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(window.openbot.agent.respondToPrompt).toHaveBeenCalledWith({
        requestId: "prompt-1",
        answers: { account: ["Acme"] },
      }),
    );
  });

  it("walks through questions one at a time and can skip them", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-steps",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        {
          id: "environment",
          header: "Environment",
          question: "Where should I work?",
          isSecret: false,
          options: [
            { label: "Repository", description: "Use the current project." },
            { label: "Sandbox", description: "Keep changes isolated." },
          ],
        },
        {
          id: "goal",
          header: "Goal",
          question: "What is the desired outcome?",
          isSecret: false,
          options: null,
        },
      ],
    });

    expect(
      await screen.findByText("Where should I work?", { selector: ".approval-question-prompt" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Repository/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(
      await screen.findByText("What is the desired outcome?", {
        selector: ".approval-question-prompt",
      }),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    expect(
      await screen.findByText("Where should I work?", { selector: ".approval-question-prompt" }),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    await waitFor(() =>
      expect(window.openbot.agent.respondToPrompt).toHaveBeenCalledWith({
        requestId: "prompt-steps",
        answers: {},
      }),
    );
  });

  it("renders command approvals and keeps the action pending while submitting", async () => {
    let resolveApproval: (() => void) | undefined;
    vi.mocked(window.openbot.agent.respondToApproval).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "approval",
      approval: {
        requestId: "approval-1",
        botId: "chief",
        threadId: "thread-1",
        turnId: "turn-1",
        kind: "command",
        command: "npm test -- --runInBand",
        cwd: "/Users/norbertbodziony/projects/openbot",
        reason: "Run the verification suite.",
        grantRoot: null,
        permissions: null,
      },
    });

    expect(await screen.findByText("Run this command?")).toBeInTheDocument();
    expect(screen.getByText("npm test -- --runInBand")).toBeInTheDocument();
    expect(screen.getByText("Run the verification suite.")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(window.openbot.agent.respondToApproval).toHaveBeenCalledWith({
      requestId: "approval-1",
      decision: "accept",
    });

    resolveApproval?.();
    await waitFor(() => expect(screen.queryByText("Run this command?")).not.toBeInTheDocument());
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

  it("persists settings and opens managed attachment actions", async () => {
    render(() => <App />);
    await fireEvent.click(await screen.findByRole("button", { name: "View agent settings" }));
    await screen.findByRole("button", { name: "Onboarding model: Luna" });
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

  it("opens bot actions on right click and edits the selected agent", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.contextMenu(screen.getByRole("button", { name: /Sales Outbound/ }), {
      clientX: 120,
      clientY: 90,
    });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Edit agent" }), { button: 0 });
    expect(await screen.findByRole("heading", { name: "Sales Outbound" })).toBeInTheDocument();
    expect(await screen.findByRole("complementary", { name: "Agent settings" })).toBeInTheDocument();
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
    await waitFor(() => expect(sales).not.toBeInTheDocument());
  });

  it("shows the server rail and opens the join flow", async () => {
    render(() => <App />);
    expect(await screen.findByRole("complementary", { name: "Servers" })).toBeInTheDocument();
    expect(screen.getByText("Local", { selector: ".sidebar-server-name" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Add remote server" }));
    expect(screen.getByRole("dialog", { name: "Join a server" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Invite link" })).toBeInTheDocument();
  });

  it("updates the sidebar header when a remote server is selected", async () => {
    const serverList = [
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
        id: "studio",
        name: "Design studio",
        logoUrl: null,
        kind: "remote",
        state: "online",
        apiUrl: "https://studio.example.com",
        remoteDesktopAvailable: true,
        role: "owner",
        active: false,
      },
    ] as const;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([...serverList]);
    vi.mocked(window.openbot.servers.select).mockResolvedValueOnce(
      serverList.map((server) => ({ ...server, active: server.id === "studio" })),
    );

    render(() => <App />);

    expect(await screen.findByText("Local", { selector: ".sidebar-server-name" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Design studio server" }));
    expect(await screen.findByText("Design studio", { selector: ".sidebar-server-name" })).toBeInTheDocument();
  });

  it("opens settings for the clicked server without selecting it and restores focus", async () => {
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
    expect(screen.getByText("Design studio", { selector: ".server-settings-readonly-value" })).toBeInTheDocument();
    expect(window.openbot.servers.select).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Close server settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(remoteButton).toHaveFocus());
  });

  it("opens settings from the local server context menu", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    expect(screen.queryByRole("button", { name: "Open publishing controls" })).not.toBeInTheDocument();
    await fireEvent.contextMenu(screen.getByRole("button", { name: "Local server" }), {
      clientX: 32,
      clientY: 80,
    });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Server settings" }), { button: 0 });
    expect(screen.getByRole("dialog", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Server name" })).toBeInTheDocument();
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
      expect(name).toHaveFocus();
    }

    expect(screen.getByRole("textbox", { name: "Server name" })).toBe(name);
    expect(name).toHaveValue("Design");
  });

  it("configures the local identity before publication", async () => {
    const configured = {
      phase: "idle" as const,
      configured: true,
      enabledOnLaunch: false,
      serverId: "server-1",
      serverName: "Design studio",
      logoUrl: null,
      apiUrl: "https://design-studio-k7m4q2pz-host.openbot.run",
      apiOnline: false,
      remoteDesktopReady: false,
      remoteDesktopUnattended: false,
      remoteDesktopActiveSessions: 0,
      remoteDesktopMaxSessions: 4,
      message: "Address reserved.",
    };
    vi.mocked(window.openbot.host.configure).mockResolvedValueOnce(configured);
    vi.mocked(window.openbot.servers.list)
      .mockResolvedValueOnce([
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
      ])
      .mockResolvedValue([
        {
          id: "local",
          name: "Design studio",
          logoUrl: null,
          kind: "local",
          state: "offline",
          apiUrl: configured.apiUrl,
          remoteDesktopAvailable: false,
          role: "owner",
          active: true,
        },
      ]);
    render(() => <App />);

    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.contextMenu(screen.getByRole("button", { name: "Local server" }), {
      clientX: 32,
      clientY: 80,
    });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Server settings" }), { button: 0 });
    await fireEvent.input(screen.getByRole("textbox", { name: "Server name" }), {
      target: { value: "Design studio" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(window.openbot.host.configure).toHaveBeenCalledWith({ serverName: "Design studio" }));
    expect(window.openbot.host.start).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Publish this server" })).toBeEnabled());
  });

  it("shows publishing controls in the local server context menu on Windows", async () => {
    vi.mocked(window.openbot.getAppInfo).mockResolvedValueOnce({
      name: "OpenBot",
      version: "0.1.0",
      platform: "win32",
      variant: "production",
    });
    render(() => <App />);

    expect(await screen.findByRole("complementary", { name: "Servers" })).toBeInTheDocument();
    await fireEvent.contextMenu(screen.getByRole("button", { name: "Local server" }), {
      clientX: 32,
      clientY: 80,
    });
    expect(screen.getByRole("menuitem", { name: "Server settings" })).toBeInTheDocument();
  });

  it("shows and clears the unread boundary in an agent conversation", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    const readState = {
      unreadCount: 2,
      firstUnreadMessageId: "agent-new-1",
      throughMessageId: "agent-old",
    };
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      chief: readState,
    });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 3,
      readState,
      messages: [
        {
          id: "agent-old",
          author: "user",
          text: "Old message",
          createdAt: "2026-08-19T09:00:00.000Z",
          status: "completed",
        },
        {
          id: "agent-new-1",
          author: "assistant",
          text: "First unseen answer",
          createdAt: "2026-08-19T09:01:00.000Z",
          status: "completed",
        },
        {
          id: "agent-new-2",
          author: "assistant",
          text: "Second unseen answer",
          createdAt: "2026-08-19T09:02:00.000Z",
          status: "completed",
        },
      ],
    });
    vi.mocked(window.openbot.agent.markConversationRead).mockResolvedValueOnce({
      unreadCount: 0,
      firstUnreadMessageId: null,
      throughMessageId: "agent-new-2",
    });

    render(() => <App />);
    expect(await screen.findByRole("status", { name: "2 new messages" })).toBeInTheDocument();
    await screen.findByText("First unseen answer");
    expect(screen.getByRole("separator", { name: "New messages" })).toBeInTheDocument();
    const scrollElement = document.querySelector<HTMLElement>(".conversation-scroll");
    const divider = document.querySelector<HTMLElement>(".unread-messages-divider");
    expect(scrollElement).not.toBeNull();
    expect(divider).not.toBeNull();
    if (!scrollElement || !divider) throw new Error("Unread conversation elements are missing.");
    const firstUnreadMessage = divider.nextElementSibling;
    expect(firstUnreadMessage).toBeInstanceOf(HTMLElement);
    if (!(firstUnreadMessage instanceof HTMLElement)) {
      throw new Error("The first unread conversation message is missing.");
    }
    scrollElement.scrollTop = 720;
    Object.defineProperty(scrollElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 100, bottom: 700 }),
    });
    Object.defineProperty(divider, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 200, bottom: 212 }),
    });
    await fireEvent.scroll(scrollElement);
    await waitFor(() => expect(screen.queryByRole("status", { name: "2 new messages" })).not.toBeInTheDocument());
    Object.defineProperty(divider, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 80, bottom: 92 }),
    });
    await fireEvent.scroll(scrollElement);
    expect(await screen.findByRole("status", { name: "2 new messages" })).toBeInTheDocument();
    Object.defineProperty(firstUnreadMessage, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 100 + 1080 - scrollElement.scrollTop }),
    });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scrollElement.scrollTop = options.top ?? scrollElement.scrollTop;
    });
    Object.defineProperty(scrollElement, "scrollTo", { configurable: true, value: scrollTo });
    await fireEvent.click(screen.getByRole("button", { name: "Jump to 2 new messages" }));
    expect(scrollElement.scrollTop).toBe(1080);
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: 1080 });

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith({
        botId: "chief",
        throughMessageId: "agent-new-2",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "2 new messages" })).not.toBeInTheDocument());
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "smooth", top: 1080 }));
    expect(scrollElement.scrollTop).toBe(1080);
  });

  it("keeps a message read when it arrives in the open agent chat", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(window.openbot.agent.readConversation).toHaveBeenCalledWith("chief"));

    emitAgentEvent?.({
      type: "conversation-delta",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      messageId: "agent-visible-answer",
      delta: "Visible as it arrives",
      createdAt: "2026-08-19T09:03:00.000Z",
      revision: 1,
    });

    expect(await screen.findByText("Visible as it arrives")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith({
        botId: "chief",
        throughMessageId: "agent-visible-answer",
      }),
    );
  });

  it("clears unread messages when entering an agent chat", async () => {
    const unreadState = {
      unreadCount: 1,
      firstUnreadMessageId: "sales-new",
      throughMessageId: null,
    };
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      "sales-outbound": unreadState,
    });
    vi.mocked(window.openbot.agent.readConversation).mockImplementation(async (botId) =>
      botId === "sales-outbound"
        ? {
            botId,
            threadId: "thread-sales",
            activeTurnId: null,
            revision: 1,
            readState: unreadState,
            messages: [
              {
                id: "sales-new",
                author: "assistant",
                text: "A new sales reply",
                createdAt: "2026-08-19T09:03:00.000Z",
                status: "completed",
              },
            ],
          }
        : {
            botId,
            threadId: null,
            activeTurnId: null,
            revision: 0,
            readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
            messages: [],
          },
    );

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));

    expect(await screen.findByText("A new sales reply")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith({
        botId: "sales-outbound",
        throughMessageId: "sales-new",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
  });

  it("keeps the agent unread state when marking it fails", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    const readState = {
      unreadCount: 1,
      firstUnreadMessageId: "agent-new",
      throughMessageId: null,
    };
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      chief: readState,
    });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 2,
      readState,
      messages: [
        {
          id: "agent-old-user",
          author: "user",
          text: "Previous request",
          createdAt: "2026-08-19T09:00:00.000Z",
          status: "completed",
        },
        {
          id: "agent-new",
          author: "assistant",
          text: "Unseen answer",
          createdAt: "2026-08-19T09:01:00.000Z",
          status: "completed",
        },
      ],
    });
    vi.mocked(window.openbot.agent.markConversationRead).mockRejectedValueOnce(new Error("Read state unavailable"));

    render(() => <App />);
    const banner = await screen.findByRole("status", { name: "1 new message" });
    await screen.findByText("Unseen answer");
    const scrollElement = document.querySelector<HTMLElement>(".conversation-scroll");
    const divider = document.querySelector<HTMLElement>(".unread-messages-divider");
    expect(scrollElement).not.toBeNull();
    expect(divider).not.toBeNull();
    if (!scrollElement || !divider) throw new Error("Unread conversation elements are missing.");
    const firstUnreadMessage = divider.nextElementSibling;
    expect(firstUnreadMessage).toBeInstanceOf(HTMLElement);
    if (!(firstUnreadMessage instanceof HTMLElement)) {
      throw new Error("The first unread conversation message is missing.");
    }
    scrollElement.scrollTop = 600;
    Object.defineProperty(scrollElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 100 }),
    });
    Object.defineProperty(firstUnreadMessage, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 100 + 900 - scrollElement.scrollTop }),
    });
    Object.defineProperty(divider, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 100 + 840 - scrollElement.scrollTop }),
    });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scrollElement.scrollTop = options.top ?? scrollElement.scrollTop;
    });
    Object.defineProperty(scrollElement, "scrollTo", { configurable: true, value: scrollTo });
    await fireEvent.click(within(banner).getByRole("button", { name: "Jump to 1 new message" }));

    expect(await screen.findByText("Read state unavailable")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "New messages" })).toBeInTheDocument();
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith({
      botId: "chief",
      throughMessageId: "agent-new",
    });
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "smooth", top: 840 }));
    expect(scrollElement.scrollTop).toBe(840);
  });

  it("shows and clears the unread boundary in a private conversation", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    vi.mocked(window.openbot.servers.readDirectConversation).mockResolvedValueOnce({
      threadId: "thread-member-alice",
      otherMemberId: "member-alice",
      revision: 1,
      readState: {
        unreadCount: 1,
        firstUnreadMessageId: "direct-new",
        throughSequence: 0,
      },
      messages: [
        {
          id: "direct-new",
          threadId: "thread-member-alice",
          senderMemberId: "member-alice",
          recipientMemberId: "member-self",
          text: "Private unseen message",
          createdAt: "2026-08-19T09:00:00.000Z",
          sequence: 1,
        },
      ],
    });
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
    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));

    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "New messages" })).toBeInTheDocument();
    const scrollElement = document.querySelector<HTMLElement>(".direct-message-list");
    const divider = document.querySelector<HTMLElement>(".unread-messages-divider");
    expect(scrollElement).not.toBeNull();
    expect(divider).not.toBeNull();
    if (!scrollElement || !divider) throw new Error("Unread direct message elements are missing.");
    const firstUnreadMessage = divider.nextElementSibling;
    expect(firstUnreadMessage).toBeInstanceOf(HTMLElement);
    if (!(firstUnreadMessage instanceof HTMLElement)) {
      throw new Error("The first unread direct message is missing.");
    }
    scrollElement.scrollTop = 240;
    Object.defineProperty(scrollElement, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 80 }),
    });
    Object.defineProperty(firstUnreadMessage, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 80 + 660 - scrollElement.scrollTop }),
    });
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      scrollElement.scrollTop = options.top ?? scrollElement.scrollTop;
    });
    Object.defineProperty(scrollElement, "scrollTo", { configurable: true, value: scrollTo });
    await fireEvent.click(screen.getByRole("button", { name: "Jump to 1 new message" }));
    expect(scrollElement.scrollTop).toBe(660);
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: 660 });
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 1,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "auto", top: 660 }));
    expect(scrollElement.scrollTop).toBe(660);
  });
});

function presenceMember(id: string, email: string, name: string): TeamPresenceSnapshot["members"][number] {
  return {
    id,
    username: email,
    email,
    name,
    role: id === "member-self" ? "owner" : "member",
    createdAt: "2026-08-18T10:00:00.000Z",
    disabled: false,
    online: true,
    typingBotId: null,
  };
}

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
