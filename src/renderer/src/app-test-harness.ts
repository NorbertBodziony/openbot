import type {
  AgentEvent,
  AttachmentImportEvent,
  BotSummary,
  BrowserPictureInPictureEvent,
  CentralAuthState,
  ConversationPage,
  DirectMessageRealtimeEvent,
  DirectTypingRealtimeEvent,
  DynamicIslandAction,
  QueueDelivery,
  ScopedAgentEvent,
  ServerSummary,
  TeamPresenceSnapshot,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { screen } from "@solidjs/testing-library";
import { vi } from "vitest";
import { type AnalyticsEventName, type DesktopAnalyticsEvents, desktopAnalytics } from "./analytics";

/** Shared by every harness helper, so `expect(trackAnalytics)` works without re-importing the spy. */
export const trackAnalytics =
  vi.fn<<Name extends AnalyticsEventName>(name: Name, properties: DesktopAnalyticsEvents[Name]) => void>();
function trackScopedAnalytics<Name extends AnalyticsEventName>(name: Name, properties: DesktopAnalyticsEvents[Name]) {
  trackAnalytics(name, properties);
}

function installAnalyticsSpies(): void {
  vi.spyOn(desktopAnalytics, "track").mockImplementation(trackScopedAnalytics);
  vi.spyOn(desktopAnalytics, "scope").mockImplementation(() => ({ track: trackScopedAnalytics }));
  vi.spyOn(desktopAnalytics, "anonymousScope").mockImplementation(() => ({ track: trackScopedAnalytics }));
}
const defaultMatchMedia = window.matchMedia;

export let emitAgentEvent: ((event: AgentEvent) => void) | undefined;
export let emitScopedAgentEvent: ((event: ScopedAgentEvent) => void) | undefined;
export let emitAttachmentImport: ((event: AttachmentImportEvent) => void) | undefined;
export let emitBrowserPictureInPicture: ((event: BrowserPictureInPictureEvent) => void) | undefined;
export let emitUpdateStatus: ((status: UpdateStatus) => void) | undefined;
export let emitAuth: ((state: CentralAuthState) => void) | undefined;
export let emitServers: ((servers: ServerSummary[]) => void) | undefined;
export let emitPresence: ((snapshot: TeamPresenceSnapshot) => void) | undefined;
export let emitDirectMessage: ((event: DirectMessageRealtimeEvent) => void) | undefined;
export let emitDirectTyping: ((event: DirectTypingRealtimeEvent) => void) | undefined;
export let emitInvite: ((inviteUrl: string) => void) | undefined;
export let emitDynamicIslandAction: ((action: DynamicIslandAction) => void) | undefined;

export const BOTS: BotSummary[] = [
  {
    id: "chief",
    provider: "codex",
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
    provider: "codex",
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

export function testServer(id: string, active: boolean): ServerSummary {
  const local = id === "local";
  return {
    id,
    name: local ? "Local" : "Studio Mac",
    logoUrl: null,
    kind: local ? "local" : "remote",
    state: "online",
    apiUrl: local ? null : "https://studio.example.com",
    remoteDesktopAvailable: false,
    role: local ? null : "member",
    active,
  };
}

export function testConversationPage(
  botId: string,
  messages: ConversationPage["messages"] = [],
  overrides: Partial<ConversationPage> = {},
): ConversationPage {
  return {
    botId,
    threadId: "thread-1",
    activeTurnId: null,
    revision: 1,
    messages,
    references: {},
    readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    pageInfo: { hasOlder: false, olderCursor: null },
    ...overrides,
  };
}

export async function confirmOnboardingModel(): Promise<void> {
  await screen.findByRole("button", { name: "Agent model: Luna" });
}

export function queuedDelivery(
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

export function installVoiceRecordingMocks(): void {
  class RecordingMediaRecorder extends EventTarget {
    readonly mimeType = "audio/webm";
    state: RecordingState = "inactive";

    start(): void {
      this.state = "recording";
    }

    stop(): void {
      this.state = "inactive";
      const recording = new Blob([new Uint8Array([1])], { type: this.mimeType });
      const dataAvailable = new Event("dataavailable");
      Object.defineProperty(dataAvailable, "data", { value: recording });
      this.dispatchEvent(dataAvailable);
      this.dispatchEvent(new Event("stop"));
    }
  }
  class TestAudioContext {
    async decodeAudioData(): Promise<AudioBuffer> {
      const decodedAudio: AudioBuffer = {
        copyFromChannel: () => undefined,
        copyToChannel: () => undefined,
        duration: 1 / 16_000,
        length: 1,
        numberOfChannels: 1,
        sampleRate: 16_000,
        getChannelData: () => new Float32Array([0]),
      };
      return decodedAudio;
    }

    async close(): Promise<void> {}
  }
  Object.defineProperty(window, "MediaRecorder", { configurable: true, writable: true, value: RecordingMediaRecorder });
  Object.defineProperty(window, "AudioContext", { configurable: true, writable: true, value: TestAudioContext });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
    },
  });
}

export function installOpenbotStub(): void {
  emitAgentEvent = undefined;
  emitScopedAgentEvent = undefined;
  emitAttachmentImport = undefined;
  emitBrowserPictureInPicture = undefined;
  emitUpdateStatus = undefined;
  emitAuth = undefined;
  emitServers = undefined;
  emitPresence = undefined;
  emitDirectMessage = undefined;
  emitDirectTyping = undefined;
  emitInvite = undefined;
  emitDynamicIslandAction = undefined;
  trackAnalytics.mockClear();
  installAnalyticsSpies();
  window.localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: defaultMatchMedia,
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    writable: true,
    value: vi.fn(() => true),
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: { getUserMedia: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")) },
  });
  Object.defineProperty(window, "openbot", {
    configurable: true,
    writable: true,
    value: {
      getAppInfo: vi.fn().mockResolvedValue({
        name: "OpenBot",
        version: "0.1.0",
        platform: "darwin",
        variant: "production",
      }),
      getSetupState: vi.fn().mockResolvedValue({ completed: true, preferredProvider: "codex" }),
      getAnalyticsPreference: vi.fn().mockResolvedValue({ enabled: true }),
      setAnalyticsPreference: vi.fn(async ({ enabled }) => ({ enabled })),
      dynamicIsland: {
        getPreference: vi.fn().mockResolvedValue({
          enabled: true,
          hapticsEnabled: true,
          idleVisible: true,
          additionalDisplaysEnabled: true,
        }),
        setPreference: vi.fn(async (preference) => ({ ...preference })),
        publishPresentation: vi.fn().mockResolvedValue(undefined),
        getPresentation: vi.fn().mockResolvedValue(null),
        onPreference: vi.fn().mockReturnValue(() => undefined),
        onPresentation: vi.fn().mockReturnValue(() => undefined),
        onGeometry: vi.fn().mockReturnValue(() => undefined),
        performAction: vi.fn().mockResolvedValue(undefined),
        performHaptic: vi.fn().mockResolvedValue(undefined),
        onAction: vi.fn((listener) => {
          emitDynamicIslandAction = listener;
          return () => undefined;
        }),
        setInteractive: vi.fn().mockResolvedValue(undefined),
      },
      saveSetup: vi.fn().mockImplementation(async ({ preferredProvider }) => ({
        completed: true,
        preferredProvider,
      })),
      getComputerUseMacSetupState: vi.fn().mockResolvedValue({
        status: "available",
        helperName: "Codex Computer Use",
        helperIconDataUrl: null,
        message: null,
      }),
      openComputerUsePermissionSetup: vi.fn().mockResolvedValue({
        status: "available",
        helperName: "Codex Computer Use",
        helperIconDataUrl: null,
        message: null,
      }),
      startComputerUseHelperDrag: vi.fn().mockResolvedValue(undefined),
      revealComputerUseHelper: vi.fn().mockResolvedValue(undefined),
      closeComputerUsePermissionSetup: vi.fn().mockResolvedValue(undefined),
      openExternal: vi.fn().mockResolvedValue(undefined),
      connectChatGPT: vi.fn().mockResolvedValue({
        phase: "blocked",
        cliVersion: "0.149.1",
        auth: { kind: "unknown" },
        providers: [
          {
            id: "codex",
            state: "sign-in-required",
            connectionState: "connecting",
            version: "0.149.1",
            message: null,
          },
          { id: "claude", state: "sign-in-required", version: "2.1.246", message: null },
        ],
        capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
        message: null,
        fullAccess: true,
      }),
      connectClaude: vi.fn().mockResolvedValue({
        phase: "blocked",
        cliVersion: "2.1.246",
        auth: { kind: "unknown" },
        providers: [
          { id: "codex", state: "sign-in-required", version: "0.149.1", message: null },
          {
            id: "claude",
            state: "sign-in-required",
            connectionState: "connecting",
            version: "2.1.246",
            message: null,
          },
        ],
        capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
        message: null,
        fullAccess: true,
      }),
      connectGrok: vi.fn().mockResolvedValue({
        phase: "blocked",
        cliVersion: "1.0.5",
        auth: { kind: "unknown" },
        providers: [
          { id: "codex", state: "sign-in-required", version: "0.149.1", message: null },
          { id: "claude", state: "sign-in-required", version: "2.1.246", message: null },
          {
            id: "grok",
            state: "sign-in-required",
            connectionState: "connecting",
            version: "1.0.5",
            message: null,
          },
        ],
        capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
        message: null,
        fullAccess: true,
      }),
      refreshAgentProviders: vi.fn().mockResolvedValue({
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
      openUrl: vi.fn().mockResolvedValue(undefined),
      voice: {
        getModelStatus: vi.fn().mockResolvedValue({ phase: "ready", progress: 100, message: null }),
        prepareModel: vi.fn().mockResolvedValue({ phase: "ready", progress: 100, message: null }),
        transcribe: vi.fn().mockResolvedValue({ text: "Voice transcript" }),
        onModelStatus: vi.fn().mockReturnValue(() => undefined),
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
        updateName: vi.fn().mockResolvedValue({
          status: "signed_in",
          user: { id: "user-1", email: "person@example.com", name: "Norbert", avatarUrl: null },
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
            provider: "codex",
            id: "gpt-5.6-luna",
            name: "Luna",
            description: "Fast and efficient for everyday agent work.",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
          {
            provider: "codex",
            id: "gpt-5.6-terra",
            name: "Terra",
            description: "Balanced speed and capability for involved tasks.",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["medium", "high"],
          },
          {
            provider: "codex",
            id: "gpt-5.6-sol",
            name: "Sol",
            description: "Most capable for complex, long-running work.",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["medium", "high", "xhigh"],
          },
          {
            provider: "claude",
            id: "claude-opus-5",
            name: "Claude Opus 5",
            description: "Most capable Claude model for complex work.",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
          {
            provider: "claude",
            id: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            description: "Balanced Claude model for general agent work.",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["low", "medium", "high"],
          },
        ]),
        listBots: vi.fn().mockResolvedValue(BOTS),
        listInstalledSkills: vi.fn().mockResolvedValue([]),
        listMemories: vi.fn().mockResolvedValue([]),
        listRoutines: vi.fn().mockResolvedValue([]),
        listRoutineRuns: vi.fn().mockResolvedValue([]),
        createMemory: vi.fn().mockImplementation(async (input) => ({
          id: "memory-new",
          botId: input.botId,
          text: input.text,
          origin: "manual",
          sourceTurnId: null,
          createdAt: "2026-08-25T12:00:00.000Z",
          updatedAt: "2026-08-25T12:00:00.000Z",
        })),
        updateMemory: vi.fn().mockImplementation(async (input) => ({
          id: input.memoryId,
          botId: input.botId,
          text: input.text,
          origin: "manual",
          sourceTurnId: null,
          createdAt: "2026-08-25T12:00:00.000Z",
          updatedAt: "2026-08-25T12:01:00.000Z",
        })),
        deleteMemory: vi.fn().mockResolvedValue(undefined),
        clearMemories: vi.fn().mockResolvedValue(undefined),
        getSidebarLayout: vi.fn().mockResolvedValue({
          revision: 0,
          sections: [],
          order: ["people", "unassigned"],
          agentAssignments: {},
          agentOrder: [],
        }),
        mutateSidebarLayout: vi.fn().mockResolvedValue({
          revision: 1,
          sections: [],
          order: ["people", "unassigned"],
          agentAssignments: {},
          agentOrder: [],
        }),
        createBot: vi.fn().mockImplementation(async (input) => ({
          ...BOTS[0],
          id: "bot-new",
          name: input.name,
          title: "",
          description: input.description,
          avatarSeed: input.avatarSeed,
          avatarHue: input.avatarHue,
        })),
        duplicateBot: vi.fn().mockImplementation(async (botId) => {
          const source = BOTS.find((bot) => bot.id === botId) ?? BOTS[0];
          const bot = {
            ...source,
            id: `${botId}-copy`,
            name: `${source.name} copy`,
            threadId: null,
            workspacePath: `/tmp/OpenBot/Bots/${botId}-copy`,
            preview: "No messages yet",
            updatedAt: null,
          };
          return {
            bot,
            layout: {
              revision: 1,
              sections: [],
              order: ["people", "unassigned"],
              agentAssignments: {},
              agentOrder: ["chief", "sales-outbound", bot.id],
            },
          };
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
        previewSharedFile: vi.fn().mockResolvedValue({
          name: "preview.md",
          size: 9,
          mimeType: "text/plain",
          previewKind: "markdown",
          bytes: new TextEncoder().encode("# Preview"),
        }),
        previewWorkspaceFile: vi.fn().mockResolvedValue({
          name: "preview.md",
          size: 9,
          mimeType: "text/plain",
          previewKind: "markdown",
          bytes: new TextEncoder().encode("# Preview"),
        }),
        sendMessage: vi.fn().mockResolvedValue({
          messageId: "message-1",
          deliveries: [{ id: "delivery-1", recipientBotId: "chief", status: "queued", position: 1 }],
        }),
        setMessageReaction: vi.fn().mockResolvedValue(undefined),
        listQueue: vi.fn().mockImplementation(async (botId) => ({ botId, deliveries: [] })),
        acknowledgeFailedTurn: vi.fn().mockResolvedValue(undefined),
        cancelQueuedMessage: vi.fn().mockResolvedValue(undefined),
        steerQueuedMessage: vi.fn().mockResolvedValue(undefined),
        updateQueuedMessage: vi.fn().mockResolvedValue(undefined),
        reorderQueue: vi.fn().mockResolvedValue(undefined),
        interrupt: vi.fn().mockResolvedValue(undefined),
        respondToPrompt: vi.fn().mockResolvedValue(undefined),
        respondToApproval: vi.fn().mockResolvedValue(undefined),
        respondToBrowserTakeover: vi.fn().mockResolvedValue(undefined),
        onEvent: vi.fn((listener) => {
          emitAgentEvent = listener;
          return () => undefined;
        }),
        onScopedEvent: vi.fn((listener) => {
          emitScopedAgentEvent = listener;
          return () => undefined;
        }),
      },
      browser: {
        open: vi.fn().mockResolvedValue(undefined),
        activate: vi.fn().mockResolvedValue(undefined),
        navigate: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listTabs: vi.fn().mockResolvedValue([]),
        getDisplayState: vi.fn().mockResolvedValue({ tabs: [], activeTabId: null }),
        getControlState: vi.fn().mockResolvedValue({ sessions: [] }),
        capturePreview: vi.fn().mockResolvedValue({
          dataUrl: "data:image/jpeg;base64,YWJj",
          width: 960,
          height: 600,
        }),
        setVisible: vi.fn().mockResolvedValue(undefined),
        onDisplayState: vi.fn().mockReturnValue(() => undefined),
        openPictureInPicture: vi
          .fn()
          .mockImplementation(async (bounds) => bounds ?? { x: 900, y: 500, width: 420, height: 300 }),
        closePictureInPicture: vi.fn().mockResolvedValue(undefined),
        dockPictureInPicture: vi.fn().mockResolvedValue(undefined),
        hidePictureInPicture: vi.fn().mockResolvedValue(undefined),
        onPictureInPictureEvent: vi.fn((listener) => {
          emitBrowserPictureInPicture = listener;
          return () => undefined;
        }),
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
        getPreference: vi.fn().mockResolvedValue({ autoDownload: true }),
        setPreference: vi.fn(async (input) => input),
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
        retryConnection: vi.fn().mockRejectedValue(new Error("The host is still incompatible.")),
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
}

export function presenceMember(id: string, email: string, name: string): TeamPresenceSnapshot["members"][number] {
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

export function attachment(id: string, name: string, kind: "image" | "pdf") {
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
