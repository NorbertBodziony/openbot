import type {
  AgentEvent,
  AgentStatus,
  AttachmentImportEvent,
  BotSummary,
  BrowserPictureInPictureEvent,
  BrowserTab,
  CentralAuthState,
  ConversationPage,
  ConversationSnapshot,
  DirectConversationSnapshot,
  DirectMessageRealtimeEvent,
  DirectTypingRealtimeEvent,
  DynamicIslandAction,
  QueueDelivery,
  ScopedAgentEvent,
  ServerSummary,
  TeamPresenceSnapshot,
  UpdateStatus,
  VoiceModelStatus,
} from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, AppControllerProvider, createAppController, createBotInitialMessage, useAppController } from "./App";
import { type AnalyticsEventName, type DesktopAnalyticsEvents, desktopAnalytics } from "./analytics";
import { SIDEBAR_PINS_STORAGE_KEY } from "./sidebar-pins";
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "./sidebar-sections";

const trackAnalytics = vi.spyOn(desktopAnalytics, "track").mockImplementation(() => undefined);
function trackScopedAnalytics<Name extends AnalyticsEventName>(name: Name, properties: DesktopAnalyticsEvents[Name]) {
  trackAnalytics(name, properties);
}
vi.spyOn(desktopAnalytics, "scope").mockImplementation(() => ({
  track: trackScopedAnalytics,
}));
vi.spyOn(desktopAnalytics, "anonymousScope").mockImplementation(() => ({
  track: trackScopedAnalytics,
}));
const defaultMatchMedia = window.matchMedia;

let emitAgentEvent: ((event: AgentEvent) => void) | undefined;
let emitScopedAgentEvent: ((event: ScopedAgentEvent) => void) | undefined;
let emitAttachmentImport: ((event: AttachmentImportEvent) => void) | undefined;
let emitBrowserPictureInPicture: ((event: BrowserPictureInPictureEvent) => void) | undefined;
let emitUpdateStatus: ((status: UpdateStatus) => void) | undefined;
let emitAuth: ((state: CentralAuthState) => void) | undefined;
let emitServers: ((servers: ServerSummary[]) => void) | undefined;
let emitPresence: ((snapshot: TeamPresenceSnapshot) => void) | undefined;
let emitDirectMessage: ((event: DirectMessageRealtimeEvent) => void) | undefined;
let emitDirectTyping: ((event: DirectTypingRealtimeEvent) => void) | undefined;
let emitInvite: ((inviteUrl: string) => void) | undefined;
let emitDynamicIslandAction: ((action: DynamicIslandAction) => void) | undefined;

const BOTS: BotSummary[] = [
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

function testServer(id: string, active: boolean): ServerSummary {
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

function testConversationPage(
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

async function confirmOnboardingModel(): Promise<void> {
  await screen.findByRole("button", { name: "Agent model: Luna" });
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

function installVoiceRecordingMocks(): void {
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
  Object.defineProperty(window, "MediaRecorder", { configurable: true, value: RecordingMediaRecorder });
  Object.defineProperty(window, "AudioContext", { configurable: true, value: TestAudioContext });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
    },
  });
}

describe("OpenBot connected desktop shell", () => {
  beforeEach(() => {
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
    window.localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: defaultMatchMedia,
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: vi.fn(() => true),
    });
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
        getMacPermissions: vi.fn().mockResolvedValue({
          screenRecording: "granted",
          accessibility: "granted",
        }),
        requestMacPermission: vi.fn().mockResolvedValue({
          screenRecording: "granted",
          accessibility: "granted",
        }),
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
          listMemories: vi.fn().mockResolvedValue([]),
          listRoutines: vi.fn().mockResolvedValue([]),
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
          stop: vi.fn().mockResolvedValue(undefined),
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
    vi.mocked(window.openbot.servers.select).mockResolvedValueOnce([local, negotiated]);

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    expect(window.openbot.agent.getSidebarLayout).not.toHaveBeenCalled();
    expect(window.openbot.browser.listTabs).not.toHaveBeenCalled();

    emitServers?.([local, negotiated]);
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-1"));
    await waitFor(() => expect(window.openbot.agent.getSidebarLayout).toHaveBeenCalled());
    expect(window.openbot.browser.listTabs).toHaveBeenCalled();
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

    emitDynamicIslandAction?.({
      type: "review-attention",
      serverId: "remote-1",
      botId: "chief",
      requestId: "approval-remote",
    });
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-1"));
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        serverId: "remote-1",
        mode: "approval",
        item: { requestId: "approval-remote" },
      }),
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
    const codex = within(providers).getByRole("radio", { name: /ChatGPT.*Connected/ });
    expect(codex).toHaveFocus();
    expect(codex).toBeChecked();
    await fireEvent.click(within(providers).getByRole("radio", { name: /Claude.*Connected/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open OpenBot" }));
    expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "claude" });
    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
  });

  it("connects bundled Claude and Grok providers", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: "Connect ChatGPT." },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Sign in to Claude." },
        { id: "grok", state: "sign-in-required", version: "1.0.5", message: "Sign in to Grok." },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Install a provider.",
      fullAccess: true,
    });
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Connect Claude" }));

    expect(window.openbot.connectClaude).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Restart Claude" })).toBeEnabled();
    await fireEvent.click(screen.getByRole("button", { name: "Connect Grok" }));
    expect(window.openbot.connectGrok).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Restart Grok" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("restarts provider connections independently and Refresh resets both", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    const disconnectedStatus: AgentStatus = {
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: null },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: null },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: null,
      fullAccess: true,
    };
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce(disconnectedStatus);
    const bothConnecting: AgentStatus = {
      ...disconnectedStatus,
      providers: disconnectedStatus.providers?.map((provider) => ({
        ...provider,
        connectionState: "connecting" as const,
      })),
    };
    vi.mocked(window.openbot.connectChatGPT).mockResolvedValue(bothConnecting);
    vi.mocked(window.openbot.connectClaude).mockResolvedValue(bothConnecting);
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Connect ChatGPT" }));
    await fireEvent.click(screen.getByRole("button", { name: "Restart Claude" }));
    expect(screen.getByRole("button", { name: "Restart ChatGPT" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart Claude" })).toBeEnabled();
    expect(window.openbot.connectChatGPT).toHaveBeenCalledTimes(1);
    expect(window.openbot.connectClaude).toHaveBeenCalledTimes(1);
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", {
      provider: "codex",
      action: "connect_started",
      result: "succeeded",
    });
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", {
      provider: "claude",
      action: "connect_started",
      result: "succeeded",
    });

    await fireEvent.click(screen.getByRole("button", { name: "Restart ChatGPT" }));
    expect(window.openbot.connectChatGPT).toHaveBeenCalledTimes(2);
    emitAgentEvent?.({
      type: "status",
      status: {
        ...disconnectedStatus,
        phase: "ready",
        providers: [
          {
            id: "codex",
            state: "sign-in-required",
            version: "0.149.1",
            message: "ChatGPT connection was not completed. Try again.",
          },
          {
            id: "claude",
            state: "available",
            version: "2.1.246",
            message: null,
            email: "claude@example.com",
          },
        ],
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("ChatGPT connection was not completed. Try again.");
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", {
      provider: "claude",
      action: "connect_completed",
      result: "succeeded",
    });
    await fireEvent.click(screen.getByRole("button", { name: "Refresh providers" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Reconnect ChatGPT" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Reconnect Claude" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refreshes provider detection and opens the matching sign-in guide", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: "Connect ChatGPT." },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Sign in to Claude." },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Install a provider.",
      fullAccess: true,
    });
    let finishRefresh: ((status: AgentStatus) => void) | undefined;
    vi.mocked(window.openbot.refreshAgentProviders).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Refresh providers" }));
    expect(screen.getByRole("button", { name: "Checking providers" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Install / })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    expect(finishRefresh).toBeTypeOf("function");
    finishRefresh?.({
      phase: "ready",
      cliVersion: "2.1.231",
      auth: { kind: "claude", email: "claude@example.com" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.144.1", message: "Sign in to ChatGPT." },
        {
          id: "claude",
          state: "available",
          version: "2.1.231",
          message: null,
          email: "claude@example.com",
        },
      ],
      capabilities: { chat: "ready", browser: "ready", computerUse: "unavailable" },
      message: null,
      fullAccess: true,
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Connect ChatGPT" })).toBeEnabled());
    expect(
      within(screen.getByRole("radiogroup", { name: "Default provider" })).getByRole("radio", { name: /Claude/ }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    const connectChatGPT = screen.getByRole("button", { name: "Connect ChatGPT" });
    await fireEvent.click(connectChatGPT);
    expect(window.openbot.connectChatGPT).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Restart ChatGPT" })).toBeEnabled();
  });

  it("refreshes providers after returning from a Connect browser flow", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: "Connect ChatGPT." },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Connect Claude." },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: null,
      fullAccess: true,
    });
    render(() => <App />);
    window.dispatchEvent(new Event("focus"));
    expect(window.openbot.refreshAgentProviders).not.toHaveBeenCalled();

    await fireEvent.click(await screen.findByRole("button", { name: "Connect ChatGPT" }));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(window.openbot.refreshAgentProviders).toHaveBeenCalledTimes(1));
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", { action: "refresh", result: "succeeded" });
  });

  it("shows a provider-specific warning when Refresh cannot verify an existing connection", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({ completed: false, preferredProvider: null });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "ready",
      cliVersion: "0.149.1",
      auth: { kind: "chatgpt", email: "norbert@example.com" },
      providers: [
        {
          id: "codex",
          state: "available",
          version: "0.149.1",
          message: null,
          email: "norbert@example.com",
          checkError: "Could not verify ChatGPT. Keeping the existing connection.",
        },
      ],
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
      message: null,
      fullAccess: true,
    });

    render(() => <App />);

    expect(await screen.findByText("Could not verify ChatGPT. Keeping the existing connection.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reconnect ChatGPT" })).toBeEnabled();
  });

  it("shows a friendly inline error when a provider guide cannot open", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: "Connect ChatGPT." },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Sign in to Claude." },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Install a provider.",
      fullAccess: true,
    });
    vi.mocked(window.openbot.connectChatGPT).mockRejectedValueOnce(new Error("Raw IPC failure"));
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Connect ChatGPT" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("OpenBot could not connect ChatGPT. Try again.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Raw IPC failure");
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", {
      provider: "codex",
      action: "connect_started",
      result: "succeeded",
    });
    expect(trackAnalytics).toHaveBeenCalledWith("provider_action", {
      provider: "codex",
      action: "connect_completed",
      result: "failed",
      failure_code: "connect_failed",
    });
  });

  it("shows a native ChatGPT login failure reported after the browser opens", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: null,
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "sign-in-required", version: "0.149.1", message: "Connect ChatGPT." },
        { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Sign in to Claude." },
      ],
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Connect ChatGPT.",
      fullAccess: true,
    });
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Connect ChatGPT" }));
    expect(screen.getByRole("button", { name: "Restart ChatGPT" })).toBeEnabled();

    emitAgentEvent?.({
      type: "status",
      status: {
        phase: "blocked",
        cliVersion: null,
        auth: { kind: "unknown" },
        providers: [
          {
            id: "codex",
            state: "sign-in-required",
            version: "0.149.1",
            message: "ChatGPT connection timed out. Try again.",
          },
          { id: "claude", state: "sign-in-required", version: "2.1.246", message: "Sign in to Claude." },
        ],
        capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
        message: "ChatGPT connection timed out. Try again.",
        fullAccess: true,
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("ChatGPT connection timed out. Try again.");
    expect(screen.getByRole("button", { name: "Connect ChatGPT" })).toBeEnabled();
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
    expect(trackAnalytics).toHaveBeenCalledWith("team_action", {
      action: "server_joined",
      result: "succeeded",
      entry_point: "invite_deep_link",
    });
    expect(trackAnalytics).not.toHaveBeenCalledWith(
      "team_action",
      expect.objectContaining({ action: "server_selected" }),
    );
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
    const codex = within(providers).getByRole("radio", { name: /ChatGPT.*Checking/ });
    const claude = within(providers).getByRole("radio", { name: /Claude.*Checking/ });

    expect(codex).toBeEnabled();
    expect(claude).toBeEnabled();
    expect(codex).toHaveFocus();

    await fireEvent.click(claude);
    expect(claude).toBeChecked();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

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
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    emitAgentEvent?.({
      type: "status",
      status: {
        phase: "ready",
        cliVersion: "2.1.231",
        auth: { kind: "claude", email: "claude@example.com" },
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
            state: "available",
            version: "2.1.231",
            message: null,
            email: "claude@example.com",
          },
        ],
        capabilities: { chat: "ready", browser: "ready", computerUse: "setup-required" },
        message: null,
        fullAccess: true,
      },
    });

    expect(claude).toBeChecked();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open OpenBot" }));
    expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "claude" });
  });

  it("lets the user review providers and permissions from the account menu", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(await screen.findByRole("button", { name: "Open account actions" }));
    await fireEvent.click(screen.getByRole("button", { name: "Providers & permissions" }));

    expect(await screen.findByRole("dialog", { name: "Providers & permissions" })).toBeInTheDocument();
    const providers = screen.getByRole("radiogroup", { name: "Default provider" });
    expect(within(providers).getByRole("radio", { name: /Codex.*Connected/ })).toBeChecked();
    expect(within(providers).getByText("norbert@example.com")).toBeInTheDocument();
    expect(within(providers).getByText("claude@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await fireEvent.click(within(providers).getByRole("radio", { name: /Claude.*Connected/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(window.openbot.saveSetup).toHaveBeenLastCalledWith({ preferredProvider: "claude" });
    expect(screen.queryByRole("dialog", { name: "Providers & permissions" })).not.toBeInTheDocument();
  });

  it("opens the required first-Bot setup for a new user", async () => {
    vi.mocked(window.openbot.agent.listBots).mockResolvedValueOnce([]);
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Create your first Bot" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Bot" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(window.openbot.agent.createBot).not.toHaveBeenCalled();
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
        name: /ChatGPT.*Connected/,
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

  it("shows focused weekly usage and compact account actions", async () => {
    render(() => <App />);
    await waitFor(() => expect(window.openbot.agent.getUsage).toHaveBeenCalledTimes(1));
    const usageButton = await screen.findByRole("button", { name: "Weekly usage, 59% left" });
    expect(screen.getByRole("complementary", { name: "Bot navigation" })).not.toContainElement(usageButton);

    await fireEvent.click(usageButton);
    const usageDialog = screen.getByRole("dialog", { name: "Weekly usage" });
    const usageProgress = within(usageDialog).getByRole("progressbar", { name: "Weekly usage remaining" });
    expect(usageProgress).toHaveAttribute("aria-valuenow", "59");
    expect(usageProgress).toHaveAttribute("aria-valuetext", "59% left");
    expect(within(usageDialog).getByText("59%")).toBeInTheDocument();
    expect(within(usageDialog).getByText("Resets")).toBeInTheDocument();
    await fireEvent.click(within(usageDialog).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(window.openbot.agent.getUsage).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/ChatGPT Pro/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Developer preview/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Lifetime/i)).not.toBeInTheDocument();

    await fireEvent.keyDown(usageDialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Weekly usage" })).not.toBeInTheDocument());
    await waitFor(() => expect(usageButton).toHaveFocus());

    const accountButton = screen.getByRole("button", { name: "Open account actions" });
    await fireEvent.click(accountButton);
    const accountDialog = screen.getByRole("dialog", { name: "Account actions" });
    expect(within(accountDialog).getByRole("button", { name: /Check for updates/ })).toBeInTheDocument();
    expect(within(accountDialog).getByRole("button", { name: "Marketplace" })).toBeInTheDocument();
    expect(within(accountDialog).getByRole("button", { name: "Providers & permissions" })).toBeInTheDocument();
    expect(within(accountDialog).getByRole("button", { name: "Send feedback" })).toBeInTheDocument();
    expect(within(accountDialog).getByRole("button", { name: "Message" })).toBeInTheDocument();
    expect(within(accountDialog).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(within(accountDialog).queryByText("person@example.com")).not.toBeInTheDocument();
    expect(within(accountDialog).queryByRole("button", { name: /photo/i })).not.toBeInTheDocument();
    expect(within(accountDialog).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(within(accountDialog).queryByText("Weekly usage")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export data" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export diagnostics" })).not.toBeInTheDocument();

    await fireEvent.keyDown(accountDialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Account actions" })).not.toBeInTheDocument());
    await waitFor(() => expect(accountButton).toHaveFocus());

    await fireEvent.click(accountButton);
    const reopenedAccountDialog = await screen.findByRole("dialog", { name: "Account actions" });
    fireEvent.click(within(reopenedAccountDialog).getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("feedback"));

    fireEvent.click(accountButton);
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("message"));
  });

  it("opens global settings from the dock and restores focus after every close path", async () => {
    render(() => <App />);
    const settingsButton = await screen.findByRole("button", { name: "Settings" });

    await fireEvent.click(settingsButton);
    let dialog = await screen.findByRole("dialog", { name: "General" });
    const launchSwitch = within(dialog).getByRole("switch", { name: "Launch OpenBot at login" });
    await fireEvent.click(launchSwitch);
    expect(launchSwitch).not.toBeChecked();

    await fireEvent.click(within(dialog).getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(settingsButton).toHaveFocus());

    await fireEvent.click(settingsButton);
    dialog = await screen.findByRole("dialog", { name: "General" });
    expect(within(dialog).getByRole("switch", { name: "Launch OpenBot at login" })).not.toBeChecked();
    await fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(settingsButton).toHaveFocus());

    await fireEvent.click(settingsButton);
    await screen.findByRole("dialog", { name: "General" });
    await fireEvent.pointerDown(screen.getByTestId("settings-modal-backdrop"), { button: 0 });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(settingsButton).toHaveFocus());
  });

  it("persists the product analytics opt-out", async () => {
    render(() => <App />);
    await fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    await fireEvent.click(await screen.findByRole("switch", { name: "Share product analytics" }));

    await waitFor(() => expect(window.openbot.setAnalyticsPreference).toHaveBeenCalledWith({ enabled: false }));
  });

  it("persists the MacBook notch preference from settings on macOS", async () => {
    render(() => <App />);
    await fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const notchSwitch = await screen.findByRole("switch", { name: "Show status in the MacBook notch" });
    expect(notchSwitch).toBeChecked();

    await fireEvent.click(notchSwitch);

    await waitFor(() =>
      expect(window.openbot.dynamicIsland.setPreference).toHaveBeenCalledWith({
        enabled: false,
        hapticsEnabled: true,
        idleVisible: true,
        additionalDisplaysEnabled: true,
      }),
    );
    expect(notchSwitch).not.toBeChecked();
  });

  it("does not open desktop analytics when the saved preference is disabled", async () => {
    vi.mocked(window.openbot.getAnalyticsPreference).mockResolvedValueOnce({ enabled: false });
    const setTrackingEnabled = vi.spyOn(desktopAnalytics, "setTrackingEnabled");
    render(() => <App />);

    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(setTrackingEnabled).toHaveBeenCalledWith(false));
    expect(trackAnalytics).not.toHaveBeenCalledWith("desktop_app_opened", expect.anything());
    setTrackingEnabled.mockRestore();
  });

  it("signs out from the account menu without removing local data", async () => {
    render(() => <App />);
    await fireEvent.click(await screen.findByRole("button", { name: "Open account actions" }));
    await fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(window.openbot.auth.logout).toHaveBeenCalledOnce());
    expect(trackAnalytics).toHaveBeenCalledWith("account_sign_out", { result: "succeeded" });
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
      errorCode: null,
    });
    render(() => <App />);

    expect(await screen.findByText("OpenBot update available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open account actions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Download update/ }));
    await waitFor(() => expect(window.openbot.update.download).toHaveBeenCalledOnce());
    expect(trackAnalytics).toHaveBeenCalledWith("update_action", {
      action: "download",
      result: "succeeded",
      phase: "downloading",
    });

    emitUpdateStatus?.({
      phase: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: 100,
      checkedAt: "2026-08-12T22:00:00.000Z",
      message: null,
      errorCode: null,
    });
    fireEvent.click(await screen.findByRole("button", { name: /Restart to update/ }));
    await waitFor(() => expect(window.openbot.update.install).toHaveBeenCalledOnce());
  });

  it("reports a returned update error as a failed action", async () => {
    vi.mocked(window.openbot.update.getStatus).mockResolvedValueOnce({
      phase: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: null,
      checkedAt: null,
      message: null,
      errorCode: null,
    });
    vi.mocked(window.openbot.update.download).mockResolvedValueOnce({
      phase: "error",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: null,
      checkedAt: "2026-08-12T22:00:00.000Z",
      message: "Could not check for updates. Try again.",
      errorCode: "download_failed",
    });
    render(() => <App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open account actions" }));
    fireEvent.click(await screen.findByRole("button", { name: /Download update/ }));

    await waitFor(() =>
      expect(trackAnalytics).toHaveBeenCalledWith("update_action", {
        action: "download",
        result: "failed",
        phase: "error",
        failure_code: "download_failed",
      }),
    );
  });

  it("confirms an installed app version on the next launch", async () => {
    const configureAnalytics = vi.spyOn(desktopAnalytics, "configure").mockReturnValue(true);
    window.localStorage.setItem("openbot:analytics-app-version", "0.0.9");
    render(() => <App />);

    await waitFor(() =>
      expect(trackAnalytics).toHaveBeenCalledWith("app_updated", {
        from_version: "0.0.9",
        to_version: "0.1.0",
      }),
    );
    expect(window.localStorage.getItem("openbot:analytics-app-version")).toBe("0.1.0");
    configureAnalytics.mockRestore();
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

  it("downloads the voice model before it requests microphone access", async () => {
    let resolvePreparation: ((status: VoiceModelStatus) => void) | undefined;
    let reportModelStatus: ((status: VoiceModelStatus) => void) | undefined;
    vi.mocked(window.openbot.voice.prepareModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    vi.mocked(window.openbot.voice.onModelStatus).mockImplementationOnce((listener) => {
      reportModelStatus = listener;
      return () => undefined;
    });
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    reportModelStatus?.({ phase: "downloading", progress: 47, message: null });
    await waitFor(() => {
      expect(screen.getAllByRole("status").some((status) => status.textContent?.includes("47%"))).toBe(true);
    });

    resolvePreparation?.({ phase: "ready", progress: 100, message: null });
    await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
  });

  it("shows a deferred voice setup error in the original conversation", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolvePreparation: ((status: VoiceModelStatus) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.prepareModel).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await waitFor(() => expect(window.openbot.voice.prepareModel).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    resolvePreparation?.({ phase: "error", progress: 0, message: "Local voice setup failed" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled());
    expect(screen.queryByText("Local voice setup failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    expect(await screen.findByText("Local voice setup failed")).toBeInTheDocument();
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

  it("sends the transcribed prompt when the send arrow is pressed during voice recording", async () => {
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));

    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        { botId: "chief", text: "Voice transcript", attachmentDraftIds: [] },
        "local",
      ),
    );
  });

  it("submits the accepted voice snapshot and preserves later draft changes", async () => {
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Existing draft";
    await fireEvent.input(composer);
    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());

    expect(composer).toHaveAttribute("aria-disabled", "true");
    await fireEvent.keyDown(composer, { key: "Enter" });
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();
    composer.textContent = "Later draft";
    await fireEvent.input(composer);

    resolveTranscription?.({ text: "Voice transcript" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        { botId: "chief", text: "Existing draft Voice transcript", attachmentDraftIds: [] },
        "local",
      ),
    );
    expect(window.openbot.agent.sendMessage).toHaveBeenCalledOnce();
    await waitFor(() => expect(composer).toHaveTextContent("Later draft"));
  });

  it("finishes an accepted voice send for the original bot after the chat changes", async () => {
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));

    resolveTranscription?.({ text: "Message for Chief" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        { botId: "chief", text: "Message for Chief", attachmentDraftIds: [] },
        "local",
      ),
    );
  });

  it("stores an ordinary voice transcript for the original bot after the chat changes", async () => {
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    const recording = await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(within(recording).getByRole("button", { name: "Stop voice recording" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));

    resolveTranscription?.({ text: "Draft for Chief" });
    await screen.findByRole("button", { name: "Create prompt with voice" });
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent("Draft for Chief"),
    );
  });

  it("shows a deferred transcription error in the original chat", async () => {
    let rejectTranscription: ((error: Error) => void) | undefined;
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectTranscription = reject;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Retry me";
    await fireEvent.input(composer);
    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));

    rejectTranscription?.(new Error("Transcription failed"));
    await screen.findByRole("button", { name: "Create prompt with voice" });
    expect(screen.queryByText("Transcription failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Transcription failed");
    await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(screen.queryByText("Transcription failed")).not.toBeInTheDocument());
  });

  it("finishes an accepted voice send on the original server after the server changes", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    resolveTranscription?.({ text: "Message for local Chief" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        {
          botId: "chief",
          text: "Message for local Chief",
          attachmentDraftIds: [],
        },
        "local",
      ),
    );
  });

  it("shows a deferred send error on the original server", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    vi.mocked(window.openbot.agent.sendMessage).mockRejectedValueOnce(new Error("Local send failed"));
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Later local draft";
    await fireEvent.input(composer);
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    resolveTranscription?.({ text: "Message for local Chief" });
    await waitFor(() => expect(window.openbot.agent.sendMessage).toHaveBeenCalledOnce());
    expect(screen.queryByText("Local send failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    expect(await screen.findByText("Local send failed")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent(
      "Later local draft Message for local Chief",
    );
  });

  it("shows a deferred read-state error on the original server", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let rejectRead: ((error: Error) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.agent.markConversationRead).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    installVoiceRecordingMocks();
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );

    rejectRead?.(new Error("Local read state failed"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create prompt with voice" })).toBeEnabled());
    expect(screen.queryByText("Local read state failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    expect(await screen.findByText("Local read state failed")).toBeInTheDocument();
  });

  it("saves a queued-message edit on its original server after the server changes", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    vi.mocked(window.openbot.agent.listQueue).mockResolvedValueOnce({
      botId: "chief",
      deliveries: [
        queuedDelivery("delivery-running", "Running", null, { status: "running", turnId: "turn-running" }),
        queuedDelivery("delivery-voice-edit", "Queued draft", 1),
      ],
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(await screen.findByRole("button", { name: "Edit queued message 1" }));
    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.queryByRole("button", { name: "Save queued message" })).not.toBeInTheDocument();

    resolveTranscription?.({ text: "Voice transcript" });
    await waitFor(() =>
      expect(window.openbot.agent.updateQueuedMessage).toHaveBeenCalledWith(
        {
          botId: "chief",
          deliveryId: "delivery-voice-edit",
          text: "Queued draft Voice transcript",
          keepAttachmentIds: [],
          attachmentDraftIds: [],
        },
        "local",
      ),
    );
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();
  });

  it("saves a queued voice edit when navigation happens before the send action", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveTranscription: ((result: { text: string }) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.voice.transcribe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    installVoiceRecordingMocks();
    vi.mocked(window.openbot.agent.listQueue).mockResolvedValueOnce({
      botId: "chief",
      deliveries: [
        queuedDelivery("delivery-running", "Running", null, { status: "running", turnId: "turn-running" }),
        queuedDelivery("delivery-navigation", "Queued draft", 1),
      ],
    });
    render(() => <App />);

    await fireEvent.click(await screen.findByRole("button", { name: "Edit queued message 1" }));
    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    await waitFor(() => expect(window.openbot.voice.transcribe).toHaveBeenCalledOnce());

    resolveTranscription?.({ text: "Voice transcript" });
    await waitFor(() =>
      expect(window.openbot.agent.updateQueuedMessage).toHaveBeenCalledWith(
        {
          botId: "chief",
          deliveryId: "delivery-navigation",
          text: "Queued draft Voice transcript",
          keepAttachmentIds: [],
          attachmentDraftIds: [],
        },
        "local",
      ),
    );
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();
  });

  it("retains a queued-message edit only in its original conversation", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    vi.mocked(window.openbot.agent.listQueue).mockResolvedValueOnce({
      botId: "chief",
      deliveries: [
        queuedDelivery("delivery-running", "Running", null, { status: "running", turnId: "turn-running" }),
        queuedDelivery("delivery-edit", "Queued draft", 1),
      ],
    });
    render(() => <App />);

    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Personal draft";
    await fireEvent.input(composer);
    await fireEvent.click(await screen.findByRole("button", { name: "Edit queued message 1" }));
    expect(composer).toHaveTextContent("Queued draft");

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.queryByRole("button", { name: "Save queued message" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    await screen.findByRole("button", { name: "Save queued message" });
    expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent("Queued draft");

    await fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("textbox", { name: "Message Chief" })).toHaveTextContent("Personal draft");
    expect(window.openbot.agent.updateQueuedMessage).not.toHaveBeenCalled();
  });

  it("shows the voice-send arrow while an agent turn is active", async () => {
    installVoiceRecordingMocks();
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-active",
        revision: 2,
        messages: [],
      },
    });

    await screen.findByRole("button", { name: "Stop agent" });
    await fireEvent.click(screen.getByRole("button", { name: "Create prompt with voice" }));
    await screen.findByRole("group", { name: "Voice recording" });
    expect(screen.getByRole("button", { name: "Send voice message" })).toBeInTheDocument();
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
    await screen.findByRole("button", { name: "Agent model: Luna" });
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    await fireEvent.input(search, { target: { value: "Sales" } });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    expect(screen.getByRole("heading", { name: "Sales Outbound" })).toBeInTheDocument();
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
        provider: "claude",
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
    await screen.findByRole("button", { name: "Agent model: Luna" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    await fireEvent.click(screen.getByRole("option", { name: "Sol" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not change model. Try again.");
    expect(screen.getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();
    expect(
      screen.queryByRole("radiogroup", { name: "What do you want me helping with most?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "true");
  });

  it("locks the header model picker during active work", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });
    await waitFor(() => expect(trigger).toBeEnabled());

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
    expect(trackAnalytics).not.toHaveBeenCalledWith("system_turn_started", expect.anything());
    expect(trackAnalytics).not.toHaveBeenCalledWith("system_turn_completed", expect.anything());
  });

  it("supports picker keyboard navigation and outside dismissal", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });

    await fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    const codex = within(picker).getByRole("tab", { name: /^ChatGPT:/ });
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
        provider: "claude",
        reasoningEffort: "medium",
      }),
    );
    expect(within(settings).getByRole("button", { name: "Agent model: Claude Opus 5" })).toBeEnabled();

    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Claude Opus 5" }));
    picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^ChatGPT:/ }));
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

  it("opens the agent memory modal from settings", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const settings = await screen.findByRole("complementary", { name: "Agent settings" });

    await fireEvent.click(within(settings).getByRole("button", { name: /Memories/ }));
    expect(await screen.findByRole("dialog", { name: "Memories" })).toBeInTheDocument();
    expect(await screen.findByText("This agent has no saved memories yet.")).toBeInTheDocument();
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
        provider: "claude",
        reasoningEffort: "medium",
      }),
    );
  });

  it("shows provider availability in the model picker", async () => {
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

    const trigger = await screen.findByRole("button", { name: "Agent model: Luna" });
    await fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    expect(within(picker).getByRole("tab", { name: /^ChatGPT: 0.144.1/ })).toBeEnabled();
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
    await waitFor(() => expect(compactAccountButton).toHaveFocus());

    await fireEvent.click(compactAccountButton);
    await fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Account actions" })).getByRole("button", { name: "Settings" }),
    );
    const compactSettingsDialog = await screen.findByRole("dialog", { name: "General" });
    await fireEvent.click(within(compactSettingsDialog).getByRole("button", { name: "Close settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(compactAccountButton).toHaveFocus());

    await fireEvent.click(screen.getByRole("button", { name: "Expand sidebar and search chats" }));

    expect(screen.getByRole("complementary", { name: "Bot navigation" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize left sidebar" })).toHaveAttribute("aria-valuenow", "280");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "Open Marketplace" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search chats" })).toHaveFocus());
  });

  it("opens Marketplace from the sidebar header", async () => {
    render(() => <App />);
    const marketplaceButton = await screen.findByRole("button", { name: "Open Marketplace" });

    await fireEvent.click(marketplaceButton);

    expect(await screen.findByRole("dialog", { name: "Marketplace" })).toBeInTheDocument();
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

  it("migrates old narrow sidebar widths to the expanded minimum", async () => {
    window.localStorage.setItem("openbot:left-panel-width", "220");
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    expect(screen.getByRole("separator", { name: "Resize left sidebar" })).toHaveAttribute("aria-valuenow", "240");
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
          ownerBotId: "chief",
        },
      ],
      activeTabId: "tab-pip",
    });

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    const conversation = screen.getByRole("main", { name: "Conversation" });
    expect(await screen.findByRole("complementary", { name: "Browser" })).toBeInTheDocument();
    expect(conversation).toHaveClass("browser-panel-active");

    await fireEvent.click(screen.getByRole("button", { name: "Open browser Picture in Picture" }));

    await waitFor(() => expect(window.openbot.browser.openPictureInPicture).toHaveBeenCalledWith(undefined));
    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();
    expect(conversation).not.toHaveClass("browser-panel-active");
    expect(window.openbot.browser.close).not.toHaveBeenCalled();

    emitBrowserPictureInPicture?.({
      type: "bounds-changed",
      bounds: { x: 720, y: 360, width: 460, height: 340 },
    });
    expect(window.localStorage.getItem("openbot:browser-pip-native-bounds")).toBe("720,360,460,340");

    emitBrowserPictureInPicture?.({ type: "dock" });
    expect(await screen.findByRole("complementary", { name: "Browser" })).toBeInTheDocument();
    expect(conversation).toHaveClass("browser-panel-active");
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
      ownerBotId: "chief",
    };
    const substackTab: BrowserTab = {
      id: "tab-substack",
      title: "Substack | Chat",
      url: "https://substack.com/chat",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
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

  it("restores the active embedded browser tab from the local display state", async () => {
    const firstTab: BrowserTab = {
      id: "tab-first",
      title: "First tab",
      url: "https://example.com/first",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
    };
    const activeTab: BrowserTab = {
      id: "tab-active",
      title: "Active tab",
      url: "https://example.com/active",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
    };
    vi.mocked(window.openbot.browser.getDisplayState).mockResolvedValueOnce({
      tabs: [firstTab, activeTab],
      activeTabId: activeTab.id,
    });

    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));

    expect(await screen.findByRole("tab", { name: "Active tab" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "First tab" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("textbox", { name: "Browser address" })).toHaveValue("https://example.com/active");
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
      ownerBotId: "chief",
    };
    const activeTab: BrowserTab = {
      id: "tab-active",
      title: "Active local tab",
      url: "https://example.com/active",
      loading: false,
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
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
          ownerBotId: "chief",
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
    expect(controlledTab).toHaveAttribute("aria-description", "Press Delete or Control/Command W to close");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    await fireEvent.keyDown(screen.getByRole("tab", { name: "Third page" }), { key: "Delete" });
    expect(window.openbot.browser.close).toHaveBeenCalledWith("tab-3");
    expect(screen.queryByRole("button", { name: "Hide browser panel" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(window.openbot.browser.open).toHaveBeenCalledWith({
      url: "https://www.google.com",
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
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
    expect(screen.getByRole("tab", { name: "Local smoke page, controlled by Chief" })).toBe(controlledTab);

    emitAgentEvent?.({ type: "browser-control-changed", state: { sessions: [] } });
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Local smoke page, controlled by Chief" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "Local smoke page" })).toBe(controlledTab);
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
          ownerBotId: "chief",
        },
        {
          id: "tab-login",
          title: "Sign in",
          url: "https://example.com/login",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerBotId: "chief",
        },
      ],
      activeTabId: "tab-public",
    });
    emitAgentEvent?.({
      type: "browser-takeover-requested",
      request: {
        requestId: "takeover-1",
        botId: "chief",
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
          ownerBotId: "chief",
        },
      ],
      activeTabId: "tab-login",
    });
    emitAgentEvent?.({
      type: "browser-takeover-requested",
      request: {
        requestId: "takeover-preview-failed",
        botId: "chief",
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
        target: "main",
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

  it("opens workspace Markdown in the right sidebar and keeps external opening explicit", async () => {
    const workspacePath = "/tmp/OpenBot/Bots/chief/recipe-tomato-basil-pasta.md";
    const sharedPath = "/tmp/OpenBot/Shared/menu.txt";
    vi.mocked(window.openbot.agent.readConversation).mockImplementation(async (botId) => ({
      botId,
      threadId: botId === "chief" ? "thread-chief" : null,
      activeTurnId: null,
      revision: 1,
      messages:
        botId === "chief"
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
    expect(window.openbot.agent.previewWorkspaceFile).toHaveBeenCalledWith({ botId: "chief", path: workspacePath });
    expect(window.openbot.agent.openWorkspaceFile).not.toHaveBeenCalled();
    expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith({ visible: false });

    await fireEvent.click(screen.getByRole("button", { name: "Open file externally" }));
    expect(window.openbot.agent.openWorkspaceFile).toHaveBeenCalledWith({ botId: "chief", path: workspacePath });
    await fireEvent.click(screen.getByRole("button", { name: "Close file preview" }));
    expect(screen.queryByRole("complementary", { name: "File preview" })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Open shared file menu.txt" }));
    expect(await screen.findByText("Pasta menu")).toBeInTheDocument();
    expect(window.openbot.agent.previewSharedFile).toHaveBeenCalledWith({ path: sharedPath });
    expect(window.openbot.agent.openSharedFile).not.toHaveBeenCalled();
  });

  it("queues from the composer and clears only after success", async () => {
    render(() => <App />);
    await confirmOnboardingModel();
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Run this Monday";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        { botId: "chief", text: "Run this Monday", attachmentDraftIds: [] },
        "local",
      ),
    );
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "delivery-1",
        },
        "local",
      ),
    );
    await waitFor(() => expect(composer).toHaveTextContent(""));
    expect(trackAnalytics).toHaveBeenCalledWith("message_send", {
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoning_effort: "medium",
      server_kind: "local",
      channel: "agent",
      attachment_count: 0,
      is_reply: false,
      result: "succeeded",
      delivery_count: 1,
    });
  });

  it("does not read an earlier agent reply again after sending a message", async () => {
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
            id: "assistant-before-send",
            author: "assistant",
            text: "Earlier agent reply",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });
    await screen.findByText("Earlier agent reply");
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(window.openbot.agent.markConversationRead).mockClear();

    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Continue this work";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "delivery-1" },
        "local",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(window.openbot.agent.markConversationRead).mock.calls).toEqual([
      [{ botId: "chief", throughMessageId: "delivery-1" }, "local"],
    ]);
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
    render(() => <App peopleEnabled />);
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
    expect(trackAnalytics).toHaveBeenCalledWith("message_send", {
      channel: "direct",
      attachment_count: 0,
      is_reply: false,
      result: "succeeded",
      delivery_count: 1,
      server_kind: "local",
    });

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
    render(() => <App peopleEnabled />);
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
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        {
          botId: "chief",
          text: "Yes, today please",
          attachmentDraftIds: [],
          replyToMessageId: "assistant-1",
        },
        "local",
      ),
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
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        {
          botId: "chief",
          text: "Improve this selected text.\n\n> friendlier closing sentence",
          attachmentDraftIds: [],
          replyToMessageId: "assistant-selection",
        },
        "local",
      ),
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
    expect(trackAnalytics).toHaveBeenCalledWith("reaction_action", { action: "add", result: "succeeded" });

    await fireEvent.pointerDown(screen.getByRole("button", { name: "More message actions" }), { button: 0 });
    await fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Copy" }), { button: 0 });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Ready to ship."));
  });

  it("lets the user remove only their own reaction while keeping the agent reaction read-only", async () => {
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
            id: "user-reactions",
            author: "user",
            text: "The launch is approved.",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
            reaction: "❤️",
            reactions: [
              { emoji: "❤️", actor: { kind: "user" } },
              { emoji: "🎉", actor: { kind: "bot", botId: "chief" } },
            ],
          },
        ],
      },
    });

    await screen.findByRole("img", { name: "Chief reacted with 🎉" });
    await fireEvent.click(screen.getByRole("button", { name: "Remove your reaction ❤️" }));
    expect(window.openbot.agent.setMessageReaction).toHaveBeenCalledWith({
      botId: "chief",
      messageId: "user-reactions",
      emoji: null,
    });
    expect(trackAnalytics).toHaveBeenCalledWith("reaction_action", { action: "remove", result: "succeeded" });
    expect(screen.getByRole("img", { name: "Chief reacted with 🎉" })).toBeInTheDocument();
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
    await fireEvent.pointerDown(screen.getByRole("menuitem", { name: /Add context/ }), { button: 0 });
    expect(filePickerClick).toHaveBeenCalledTimes(2);
    emitAttachmentImport?.({ type: "started", requestId: "picker-1", serverId: "local" });
    emitAttachmentImport?.({
      type: "completed",
      requestId: "picker-1",
      serverId: "local",
      attachments: [attachment("draft-1", "brief.pdf", "pdf")],
    });
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith(
        { botId: "chief", text: "", attachmentDraftIds: ["draft-1"] },
        "local",
      ),
    );
  });

  it("adds pathless pasted images reported by preload", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAttachmentImport?.({ type: "started", requestId: "paste-1", serverId: "local" });
    emitAttachmentImport?.({
      type: "completed",
      requestId: "paste-1",
      serverId: "local",
      attachments: [attachment("pasted-1", "pasted.png", "image")],
    });
    await fireEvent.click(await screen.findByRole("button", { name: "Remove pasted.png" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove pasted.png" })).not.toBeInTheDocument());
    expect(window.openbot.agent.discardDraftAttachment).toHaveBeenCalledWith("pasted-1", "local");
  });

  it("keeps an asynchronous pasted attachment with the bot that received the paste", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAttachmentImport?.({ type: "started", requestId: "paste-switch", serverId: "local" });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    emitAttachmentImport?.({
      type: "completed",
      requestId: "paste-switch",
      serverId: "local",
      attachments: [attachment("pasted-switch", "for-chief.png", "image")],
    });

    expect(screen.queryByRole("button", { name: "Remove for-chief.png" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(await screen.findByRole("button", { name: "Remove for-chief.png" })).toBeInTheDocument();
  });

  it("keeps an asynchronous attachment error with the bot that received the paste", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAttachmentImport?.({ type: "started", requestId: "paste-error", serverId: "local" });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    emitAttachmentImport?.({
      type: "error",
      requestId: "paste-error",
      serverId: "local",
      message: "Attachment import failed",
    });

    expect(screen.queryByText("Attachment import failed")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Attachment import failed");
  });

  it("keeps an asynchronous pasted attachment on the server that received the paste", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => [
      { ...local, active: serverId === "local" },
      { ...remote, active: serverId === "remote-1" },
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAttachmentImport?.({ type: "started", requestId: "paste-server-switch", serverId: "local" });
    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Studio Mac server" })).toHaveAttribute("aria-pressed", "true"),
    );
    emitAttachmentImport?.({
      type: "completed",
      requestId: "paste-server-switch",
      serverId: "local",
      attachments: [attachment("pasted-local", "for-local.png", "image")],
    });

    expect(screen.queryByRole("button", { name: "Remove for-local.png" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    const removeAttachment = await screen.findByRole("button", { name: "Remove for-local.png" });
    await fireEvent.click(removeAttachment);
    expect(window.openbot.agent.discardDraftAttachment).toHaveBeenCalledWith("pasted-local", "local");
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

    await screen.findByText("Start this work", { selector: ".message-copy" });
    await screen.findByRole("status", { name: "Chief is working" });
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
    await waitFor(() => expect(document.querySelector(".agent-queue-panel")).not.toBeInTheDocument());
    expect(queueSlot).toHaveAttribute("aria-hidden", "true");
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

  it("keeps the complete Bot draft when creation fails", async () => {
    vi.mocked(window.openbot.agent.createBot).mockRejectedValueOnce(
      new Error("The first message could not be queued."),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "Create new Bot" }));
    await fireEvent.click(await screen.findByRole("button", { name: /^Writing Partner\./ }));
    const name = screen.getByRole("textbox", { name: "Name" });
    const purpose = screen.getByRole("textbox", { name: "What should this Bot help with?" });
    await fireEvent.input(name, { target: { value: "My Writing Partner" } });
    await fireEvent.click(screen.getByRole("button", { name: "Create Bot" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The first message could not be queued.");
    expect(name).toHaveValue("My Writing Partner");
    expect(purpose).toHaveValue(
      "Help me draft and improve messages and documents while keeping the writing clear and natural.",
    );
    expect(screen.getByRole("heading", { name: "Create a new Bot" })).toBeInTheDocument();
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
    const answer = await screen.findByRole("textbox", {
      name: "Custom answer for: Which account?",
    });
    await fireEvent.input(answer, { target: { value: "Acme" } });
    await fireEvent.keyDown(answer, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.agent.respondToPrompt).toHaveBeenCalledWith({
        requestId: "prompt-1",
        answers: { account: ["Acme"] },
      }),
    );
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: "turn-1",
        revision: 20,
        messages: [
          {
            id: "question-prompt:turn-1:prompt-1",
            turnId: "turn-1",
            author: "assistant",
            source: "assistant",
            text: "",
            createdAt: "2026-08-28T12:00:00.000Z",
            status: "completed",
            itemType: "question_prompt",
            questionPrompt: {
              requestId: "prompt-1",
              questions: [
                {
                  id: "account",
                  header: "Account",
                  question: "Which account?",
                  isSecret: false,
                  options: null,
                },
              ],
              resolution: {
                status: "answered",
                responses: { account: { status: "answered", answers: ["Acme"] } },
              },
            },
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByRole("region", { name: "Answers sent" })).toBeVisible());
    expect(screen.queryByRole("textbox", { name: "Custom answer for: Which account?" })).not.toBeInTheDocument();
  });

  it("keeps the prompt active and reports a delivery failure", async () => {
    vi.mocked(window.openbot.agent.respondToPrompt).mockRejectedValueOnce(new Error("Provider is offline."));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-failure",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-failure",
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

    const answer = await screen.findByRole("textbox", { name: "Custom answer for: Which account?" });
    await fireEvent.input(answer, { target: { value: "Acme" } });
    await fireEvent.keyDown(answer, { key: "Enter" });

    expect(await screen.findByText("Provider is offline.")).toBeVisible();
    expect(screen.getByText("Answer failed")).toBeVisible();
    expect(answer).toBeEnabled();
  });

  it("replaces an active prompt when its resolution arrives from another client", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-external",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-external",
      questions: [
        {
          id: "account",
          header: "Account",
          question: "Which external account?",
          isSecret: false,
          options: null,
        },
      ],
    });
    expect(await screen.findByRole("textbox", { name: "Custom answer for: Which external account?" })).toBeVisible();

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: "turn-external",
        revision: 20,
        messages: [
          {
            id: "question-prompt:turn-external:prompt-external",
            turnId: "turn-external",
            author: "assistant",
            source: "assistant",
            text: "Question: Which external account?\nAnswer: External",
            createdAt: "2026-08-28T12:00:00.000Z",
            status: "completed",
            itemType: "question_prompt",
            questionPrompt: {
              requestId: "prompt-external",
              questions: [
                {
                  id: "account",
                  header: "Account",
                  question: "Which external account?",
                  isSecret: false,
                  options: null,
                },
              ],
              resolution: {
                status: "answered",
                responses: { account: { status: "answered", answers: ["External"] } },
              },
            },
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByRole("region", { name: "Answers sent" })).toBeVisible());
    expect(
      screen.queryByRole("textbox", { name: "Custom answer for: Which external account?" }),
    ).not.toBeInTheDocument();
  });

  it("hides an unresolved history record and mounts a rapid follow-up prompt", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: "turn-first",
        revision: 20,
        messages: [
          {
            id: "question-prompt:turn-first:prompt-first",
            turnId: "turn-first",
            author: "assistant",
            source: "assistant",
            text: "Question: First question?",
            createdAt: "2026-08-28T12:00:00.000Z",
            status: "completed",
            itemType: "question_prompt",
            questionPrompt: {
              requestId: "prompt-first",
              questions: [
                {
                  id: "first",
                  header: "First",
                  question: "First question?",
                  isSecret: false,
                  options: null,
                },
              ],
              resolution: null,
            },
          },
        ],
      },
    });
    expect(screen.queryByRole("region", { name: "Questions expired" })).not.toBeInTheDocument();

    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-first",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-first",
      questions: [
        {
          id: "first",
          header: "First",
          question: "First question?",
          isSecret: false,
          options: null,
        },
      ],
    });
    const firstAnswer = await screen.findByRole("textbox", { name: "Custom answer for: First question?" });
    await fireEvent.input(firstAnswer, { target: { value: "First answer" } });
    await fireEvent.keyDown(firstAnswer, { key: "Enter" });
    await screen.findByRole("region", { name: "Answers sent" });

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: "turn-first",
        revision: 21,
        messages: [
          {
            id: "question-prompt:turn-first:prompt-first",
            turnId: "turn-first",
            author: "assistant",
            source: "assistant",
            text: "Question: First question?\nAnswer: First answer",
            createdAt: "2026-08-28T12:00:00.000Z",
            status: "completed",
            itemType: "question_prompt",
            questionPrompt: {
              requestId: "prompt-first",
              questions: [
                {
                  id: "first",
                  header: "First",
                  question: "First question?",
                  isSecret: false,
                  options: null,
                },
              ],
              resolution: {
                status: "answered",
                responses: { first: { status: "answered", answers: ["First answer"] } },
              },
            },
          },
        ],
      },
    });

    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-second",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-second",
      questions: [
        {
          id: "second",
          header: "Second",
          question: "Second question?",
          isSecret: false,
          options: null,
        },
      ],
    });

    expect(await screen.findByRole("textbox", { name: "Custom answer for: Second question?" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Answers sent" })).not.toBeInTheDocument();
  });

  it("keeps an older resolved prompt when a new turn reuses its request ID", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-1",
        activeTurnId: null,
        revision: 20,
        messages: [
          {
            id: "question-prompt:turn-old:prompt-reused",
            turnId: "turn-old",
            author: "assistant",
            source: "assistant",
            text: "Question: Which account?\nAnswer: Acme",
            createdAt: "2026-08-28T12:00:00.000Z",
            status: "completed",
            itemType: "question_prompt",
            questionPrompt: {
              requestId: "prompt-reused",
              questions: [
                {
                  id: "account",
                  header: "Account",
                  question: "Which account?",
                  isSecret: false,
                  options: null,
                },
              ],
              resolution: {
                status: "answered",
                responses: { account: { status: "answered", answers: ["Acme"] } },
              },
            },
          },
        ],
      },
    });
    expect(await screen.findByRole("region", { name: "Answers sent" })).toBeVisible();

    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-reused",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-new",
      questions: [
        {
          id: "goal",
          header: "Goal",
          question: "What should I do next?",
          isSecret: false,
          options: null,
        },
      ],
    });

    expect(await screen.findByRole("textbox", { name: "Custom answer for: What should I do next?" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Answers sent" })).toBeVisible();
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

  it("merges a refreshed remote conversation page without dropping loaded messages", async () => {
    const message = (id: string, text: string) => ({
      id,
      author: "assistant" as const,
      text,
      createdAt: "2026-08-30T02:00:00.000Z",
      status: "completed" as const,
    });
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(
      testConversationPage("chief", [message("reply-old", "Loaded earlier")], {
        pageInfo: { hasOlder: true, olderCursor: "older" },
      }),
    );
    render(() => <App />);
    expect(await screen.findByText("Loaded earlier")).toBeInTheDocument();

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage("chief", [message("reply-new", "Fresh remote reply")], {
        revision: 2,
        pageInfo: { hasOlder: true, olderCursor: "older" },
      }),
    });

    expect(await screen.findByText("Fresh remote reply")).toBeInTheDocument();
    expect(screen.getByText("Loaded earlier")).toBeInTheDocument();
  });

  it("keeps the current read state when an older page returns stale read data", async () => {
    const latestMessage = {
      id: "reply-latest-page",
      author: "assistant" as const,
      text: "Latest reply",
      createdAt: "2026-08-30T02:02:00.000Z",
      status: "completed" as const,
    };
    const latestPage = testConversationPage("chief", [latestMessage], {
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
      pageInfo: { hasOlder: true, olderCursor: "older" },
    });
    let resolveOlderPage: ((page: ConversationPage) => void) | undefined;
    vi.mocked(window.openbot.agent.readConversationPage).mockImplementation(async (input) => {
      if (input.anchor?.type !== "before") return latestPage;
      return await new Promise((resolve) => {
        resolveOlderPage = resolve;
      });
    });

    function Harness() {
      const controller = createAppController({});
      return (
        <AppControllerProvider controller={controller}>
          <button type="button" onClick={() => void controller.loadOlderAgentMessages("chief")}>
            Load older agent messages
          </button>
          <output data-testid="agent-read-state">
            {controller.conversationReads().chief?.unreadCount ?? -1}|
            {controller
              .activeMessages()
              .map((message) => message.id)
              .join(",")}
          </output>
        </AppControllerProvider>
      );
    }

    render(() => <Harness />);
    await waitFor(() => expect(screen.getByTestId("agent-read-state")).toHaveTextContent("0|reply-latest-page"));
    await fireEvent.click(screen.getByRole("button", { name: "Load older agent messages" }));
    await waitFor(() => expect(resolveOlderPage).toBeDefined());

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage("chief", [latestMessage], {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: latestMessage.id, throughMessageId: null },
        pageInfo: { hasOlder: true, olderCursor: "older" },
      }),
    });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("agent-read-state")).toHaveTextContent("0|reply-latest-page"));

    resolveOlderPage?.(
      testConversationPage(
        "chief",
        [
          {
            id: "reply-older-page",
            author: "assistant",
            text: "Older reply",
            createdAt: "2026-08-30T02:01:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: latestMessage.id, throughMessageId: null },
        },
      ),
    );

    await waitFor(() =>
      expect(screen.getByTestId("agent-read-state")).toHaveTextContent("0|reply-older-page,reply-latest-page"),
    );
  });

  it("keeps a refreshed conversation page read while its agent chat is open", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-visible",
            author: "assistant",
            text: "Visible remote reply",
            createdAt: "2026-08-30T02:01:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-visible", throughMessageId: null },
        },
      ),
    });

    expect(await screen.findByText("Visible remote reply")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "reply-visible",
        },
        "local",
      ),
    );
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
  });

  it("does not mark an attachment-only conversation refresh as unread", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-attachment-only",
            author: "assistant",
            text: "",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
            itemType: "agent_attachment",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
        },
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
    expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument();
  });

  it("does not persist a redundant read for an already-read refreshed page", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-already-read",
            author: "assistant",
            text: "Historical visible reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "reply-already-read" },
        },
      ),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
    expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument();
  });

  it("keeps a successful read when an equal-revision unread page arrives later", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const delayedPage = testConversationPage(
      "chief",
      [
        {
          id: "reply-delayed-read-state",
          author: "assistant",
          text: "Reply from the delayed page",
          createdAt: "2026-08-30T02:02:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "reply-delayed-read-state", throughMessageId: null },
      },
    );

    emitAgentEvent?.({ type: "conversation-page", page: delayedPage });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());

    emitAgentEvent?.({ type: "conversation-page", page: delayedPage });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(window.openbot.agent.markConversationRead).mock.calls).toEqual([
      [{ botId: "chief", throughMessageId: "reply-delayed-read-state" }, "local"],
    ]);
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();
  });

  it("keeps a successful realtime read when a pending reload resolves later", async () => {
    let resolveInitialPage: ((page: ConversationPage) => void) | undefined;
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    });
    vi.mocked(window.openbot.agent.readConversationPage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitialPage = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(resolveInitialPage).toBeDefined());
    const unreadPage = testConversationPage(
      "chief",
      [
        {
          id: "reply-reload-race",
          author: "assistant",
          text: "Reply before the reload resolves",
          createdAt: "2026-08-30T02:02:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "reply-reload-race", throughMessageId: null },
      },
    );

    emitAgentEvent?.({ type: "conversation-page", page: unreadPage });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());

    resolveInitialPage?.(unreadPage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
  });

  it("keeps a duplicate refreshed page read while persistence is pending", async () => {
    let resolveRead: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    });
    vi.mocked(window.openbot.agent.markConversationRead).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const duplicatePage = testConversationPage(
      "chief",
      [
        {
          id: "reply-pending-read",
          author: "assistant",
          text: "Reply with a pending read",
          createdAt: "2026-08-30T02:02:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "reply-pending-read", throughMessageId: null },
      },
    );

    emitAgentEvent?.({ type: "conversation-page", page: duplicatePage });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();

    emitAgentEvent?.({ type: "conversation-page", page: duplicatePage });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();

    resolveRead?.({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "reply-pending-read" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("restores a newer unread reply when its queued read fails", async () => {
    let resolveFirstRead: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    let rejectSecondRead: ((error: Error) => void) | undefined;
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({
      chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    });
    vi.mocked(window.openbot.agent.markConversationRead)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectSecondRead = reject;
          }),
      );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-read-a",
            author: "assistant",
            text: "First queued reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-read-a", throughMessageId: null },
        },
      ),
    });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-read-a",
            author: "assistant",
            text: "First queued reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
          {
            id: "reply-read-b",
            author: "assistant",
            text: "Newer queued reply",
            createdAt: "2026-08-30T02:03:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 3,
          readState: { unreadCount: 2, firstUnreadMessageId: "reply-read-a", throughMessageId: null },
        },
      ),
    });
    await screen.findByText("Newer queued reply");
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce();

    resolveFirstRead?.({ unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "reply-read-a" });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledTimes(2));
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValueOnce(
      testConversationPage(
        "chief",
        [
          {
            id: "reply-read-b",
            author: "assistant",
            text: "Newer queued reply",
            createdAt: "2026-08-30T02:03:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 3,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-read-b", throughMessageId: "reply-read-a" },
        },
      ),
    );
    rejectSecondRead?.(new Error("Newer read unavailable"));

    expect(await screen.findByText("Newer read unavailable")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
  });

  it("retries an automatic read for the same message after persistence fails", async () => {
    vi.mocked(window.openbot.agent.markConversationRead).mockRejectedValueOnce(new Error("Read unavailable"));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const page = testConversationPage(
      "chief",
      [
        {
          id: "reply-read-retry",
          author: "assistant",
          text: "Visible reply that needs a retry",
          createdAt: "2026-08-30T02:02:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "reply-read-retry", throughMessageId: null },
      },
    );
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValueOnce(page);

    emitAgentEvent?.({ type: "conversation-page", page });
    expect(await screen.findByText("Read unavailable")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();

    emitAgentEvent?.({ type: "conversation-page", page });
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenNthCalledWith(
        2,
        {
          botId: "chief",
          throughMessageId: "reply-read-retry",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("does not carry a failed automatic read to the same bot on another server", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let selectedServerId = "local";
    let returningToLocal = false;
    let rejectLocalRead: ((error: Error) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockImplementation(async (serverId) => {
      selectedServerId = serverId;
      returningToLocal = serverId === "local";
      return [
        { ...local, active: serverId === "local" },
        { ...remote, active: serverId === "remote-1" },
      ];
    });
    vi.mocked(window.openbot.agent.readConversationPage).mockImplementation(async (input) => {
      if (selectedServerId === "remote-1") {
        return testConversationPage(
          input.botId,
          [
            {
              id: "reply-remote-loaded",
              author: "assistant",
              text: "Remote loaded reply",
              createdAt: "2026-08-30T02:02:30.000Z",
              status: "completed",
            },
          ],
          {
            readState: { unreadCount: 1, firstUnreadMessageId: "reply-remote-loaded", throughMessageId: null },
          },
        );
      }
      if (returningToLocal) {
        return testConversationPage(
          input.botId,
          [
            {
              id: "reply-local",
              author: "assistant",
              text: "Local reply after returning",
              createdAt: "2026-08-30T02:02:00.000Z",
              status: "completed",
            },
          ],
          {
            readState: { unreadCount: 1, firstUnreadMessageId: "reply-local", throughMessageId: null },
          },
        );
      }
      return testConversationPage(input.botId);
    });
    vi.mocked(window.openbot.agent.listConversationReads)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        chief: { unreadCount: 1, firstUnreadMessageId: "reply-remote", throughMessageId: null },
      })
      .mockResolvedValueOnce({
        chief: { unreadCount: 1, firstUnreadMessageId: "reply-local", throughMessageId: null },
      });
    vi.mocked(window.openbot.agent.markConversationRead).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectLocalRead = reject;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-local",
            author: "assistant",
            text: "Local visible reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-local", throughMessageId: null },
        },
      ),
    });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(window.openbot.servers.select).toHaveBeenCalledWith("remote-1"));
    await waitFor(() => expect(window.openbot.agent.listConversationReads).toHaveBeenCalledTimes(2));
    await screen.findByText("Remote loaded reply");
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();
    rejectLocalRead?.(new Error("Local read unavailable"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-remote",
            author: "assistant",
            text: "Remote unread reply",
            createdAt: "2026-08-30T02:03:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-remote", throughMessageId: null },
        },
      ),
    });
    await screen.findByText("Remote unread reply");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce();
    expect(screen.queryByText("Local read unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Local server" }));
    await waitFor(() => expect(window.openbot.agent.listConversationReads).toHaveBeenCalledTimes(3));
    await screen.findByText("Local reply after returning");
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenNthCalledWith(
        2,
        { botId: "chief", throughMessageId: "reply-local" },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("keeps a queued read scoped to its original server", async () => {
    const local = testServer("local", true);
    const remote = testServer("remote-1", false);
    let resolveFirstRead: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([local, remote]);
    vi.mocked(window.openbot.servers.select).mockResolvedValueOnce([
      { ...local, active: false },
      { ...remote, active: true },
    ]);
    vi.mocked(window.openbot.agent.markConversationRead)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementationOnce(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: input.throughMessageId,
      }));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-first-local",
            author: "assistant",
            text: "First local reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-first-local", throughMessageId: null },
        },
      ),
    });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-first-local",
            author: "assistant",
            text: "First local reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
          {
            id: "reply-second-local",
            author: "assistant",
            text: "Second local reply",
            createdAt: "2026-08-30T02:03:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 3,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-second-local", throughMessageId: null },
        },
      ),
    });
    await screen.findByText("Second local reply");
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce();

    await fireEvent.click(screen.getByRole("button", { name: "Studio Mac server" }));
    await waitFor(() => expect(window.openbot.agent.listConversationReads).toHaveBeenCalledTimes(2));
    resolveFirstRead?.({
      unreadCount: 1,
      firstUnreadMessageId: "reply-second-local",
      throughMessageId: "reply-first-local",
    });

    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledTimes(2));
    expect(window.openbot.agent.markConversationRead).toHaveBeenNthCalledWith(
      2,
      { botId: "chief", throughMessageId: "reply-second-local" },
      "local",
    );
  });

  it("does not mark an older boundary from a rejected conversation page", async () => {
    let resolveInitialPage: ((page: ConversationPage) => void) | undefined;
    vi.mocked(window.openbot.agent.readConversationPage).mockImplementation(
      async (): Promise<ConversationPage> =>
        await new Promise((resolve) => {
          resolveInitialPage = resolve;
        }),
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-newer-boundary",
            author: "assistant",
            text: "Newest visible reply",
            createdAt: "2026-08-30T02:02:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-newer-boundary", throughMessageId: null },
        },
      ),
    });
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "reply-newer-boundary",
        },
        "local",
      ),
    );

    resolveInitialPage?.(
      testConversationPage(
        "chief",
        [
          {
            id: "reply-older-boundary",
            author: "assistant",
            text: "Older reply",
            createdAt: "2026-08-30T02:01:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 1,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-older-boundary", throughMessageId: null },
        },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalledWith(
      {
        botId: "chief",
        throughMessageId: "reply-older-boundary",
      },
      "local",
    );
    expect(screen.getByText("Newest visible reply")).toBeInTheDocument();
  });

  it("retries an explicit chat-open reload when its page revision is stale", async () => {
    const unreadState = {
      unreadCount: 1,
      firstUnreadMessageId: "reply-current-revision",
      throughMessageId: null,
    };
    const currentPage = testConversationPage(
      "chief",
      [
        {
          id: "reply-current-revision",
          author: "assistant",
          text: "Current revision reply",
          createdAt: "2026-08-30T02:03:00.000Z",
          status: "completed",
        },
      ],
      { revision: 2, readState: unreadState },
    );
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({ chief: unreadState });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: currentPage.threadId,
      activeTurnId: null,
      revision: currentPage.revision,
      readState: unreadState,
      messages: currentPage.messages,
    });
    render(() => <App />);
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();

    vi.mocked(window.openbot.agent.readConversationPage)
      .mockResolvedValueOnce(
        testConversationPage(
          "chief",
          [
            {
              id: "reply-stale-revision",
              author: "assistant",
              text: "Stale revision reply",
              createdAt: "2026-08-30T02:02:00.000Z",
              status: "completed",
            },
          ],
          {
            revision: 1,
            readState: { unreadCount: 1, firstUnreadMessageId: "reply-stale-revision", throughMessageId: null },
          },
        ),
      )
      .mockResolvedValueOnce(currentPage);
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "reply-current-revision",
        },
        "local",
      ),
    );
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalledWith(
      {
        botId: "chief",
        throughMessageId: "reply-stale-revision",
      },
      "local",
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("uses the latest visible reply after one stale retry without reloading the queue", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-applied-revision",
            author: "assistant",
            text: "Applied revision reply",
            createdAt: "2026-08-30T02:03:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "reply-applied-revision" },
        },
      ),
    });
    await screen.findByText("Applied revision reply");
    const stalePage = testConversationPage("chief", [], {
      revision: 1,
      readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
    });
    const callsBeforeOpen = vi.mocked(window.openbot.agent.readConversationPage).mock.calls.length;
    const queueCallsBeforeOpen = vi.mocked(window.openbot.agent.listQueue).mock.calls.length;
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(stalePage);

    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() => expect(window.openbot.agent.readConversationPage).toHaveBeenCalledTimes(callsBeforeOpen + 2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.openbot.agent.readConversationPage).toHaveBeenCalledTimes(callsBeforeOpen + 2);
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
      { botId: "chief", throughMessageId: "reply-applied-revision" },
      "local",
    );
    expect(window.openbot.agent.listQueue).toHaveBeenCalledTimes(queueCallsBeforeOpen);
  });

  it("applies an explicit read after an older automatic read", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const firstPage = testConversationPage(
      "chief",
      [
        {
          id: "reply-automatic-first",
          author: "assistant",
          text: "First automatic reply",
          createdAt: "2026-08-30T02:03:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "reply-automatic-first", throughMessageId: null },
      },
    );
    emitAgentEvent?.({ type: "conversation-page", page: firstPage });
    await waitFor(() => expect(window.openbot.agent.markConversationRead).toHaveBeenCalledOnce());

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    await screen.findByRole("heading", { name: "Sales Outbound" });
    const newerPage = testConversationPage(
      "chief",
      [
        ...firstPage.messages,
        {
          id: "reply-explicit-newer",
          author: "assistant",
          text: "Newer reply while closed",
          createdAt: "2026-08-30T02:04:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 3,
        readState: {
          unreadCount: 1,
          firstUnreadMessageId: "reply-explicit-newer",
          throughMessageId: "reply-automatic-first",
        },
      },
    );
    emitAgentEvent?.({ type: "conversation-page", page: newerPage });
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValueOnce(newerPage);

    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenNthCalledWith(
        2,
        { botId: "chief", throughMessageId: "reply-explicit-newer" },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("marks the latest visible reply when a chat-open reload fails", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    await screen.findByRole("heading", { name: "Sales Outbound" });
    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "reply-before-load-failure",
            author: "assistant",
            text: "Visible reply before load failure",
            createdAt: "2026-08-30T02:04:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 1, firstUnreadMessageId: "reply-before-load-failure", throughMessageId: null },
        },
      ),
    });
    vi.mocked(window.openbot.agent.readConversationPage).mockRejectedValueOnce(new Error("Reload unavailable"));

    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(await screen.findByText("Reload unavailable")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "reply-before-load-failure" },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
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
    await waitFor(() => expect(screen.queryByRole("button", { name: /Sales Outbound/ })).not.toBeInTheDocument());
  });

  it("stops queued work when conversation loading and the runtime are unavailable", async () => {
    vi.mocked(window.openbot.agent.readConversationPage).mockRejectedValue(new Error("OpenBot is not signed in."));
    vi.mocked(window.openbot.agent.listQueue).mockResolvedValue({
      botId: "chief",
      deliveries: [
        queuedDelivery("running-delivery", "Stuck work", null, {
          status: "running",
          turnId: "turn-stuck",
        }),
        queuedDelivery("queued-delivery", "Later work", 1),
      ],
    });

    render(() => <App />);
    await confirmOnboardingModel();
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Keep this draft";
    await fireEvent.input(composer);

    await fireEvent.click(await screen.findByRole("button", { name: "Stop agent" }));

    await waitFor(() => expect(window.openbot.agent.stop).toHaveBeenCalledWith({ botId: "chief" }));
  });

  it("disables force-stop on a remote host that does not advertise the capability", async () => {
    vi.mocked(window.openbot.servers.list).mockResolvedValueOnce([
      testServer("local", false),
      {
        ...testServer("remote-1", true),
        compatibility: {
          localAppVersion: "0.5.0",
          hostAppVersion: "0.4.0",
          localProtocol: { minimum: 1, maximum: 2 },
          hostProtocol: { minimum: 1, maximum: 1 },
          negotiatedProtocol: 1,
          capabilities: [],
        },
      },
    ]);
    vi.mocked(window.openbot.agent.listQueue).mockResolvedValue({
      botId: "chief",
      deliveries: [queuedDelivery("running-delivery", "Stuck work", null, { status: "running", turnId: "turn-stuck" })],
    });

    render(() => <App />);
    const stopButton = await screen.findByRole("button", { name: "Stop agent" });
    expect(stopButton).toBeDisabled();
    expect(stopButton).toHaveAttribute("title", "Update OpenBot on the host to stop this agent.");
    await fireEvent.click(stopButton);
    expect(window.openbot.agent.stop).not.toHaveBeenCalled();
    expect(window.openbot.agent.interrupt).not.toHaveBeenCalled();
  });

  it("shows the server rail and opens the join flow", async () => {
    render(() => <App />);
    expect(await screen.findByRole("complementary", { name: "Servers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings for Local" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Add remote server" }));
    expect(await screen.findByRole("dialog", { name: "Join a server" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Invite link" })).toBeInTheDocument();
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

    expect(await screen.findByRole("button", { name: "Open settings for Local" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Design studio server" }));
    expect(await screen.findByRole("button", { name: "Open settings for Design studio" })).toBeInTheDocument();
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
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "agent-new-2",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "2 new messages" })).not.toBeInTheDocument());
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "smooth", top: 1080 }));
    expect(scrollElement.scrollTop).toBe(1080);
  });

  it("keeps a reply unread while the open agent chat is in the background and clears it on focus", async () => {
    const unreadPage = testConversationPage(
      "chief",
      [
        {
          id: "agent-background-answer",
          author: "assistant",
          text: "Ready while OpenBot was in the background",
          createdAt: "2026-08-19T09:03:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: {
          unreadCount: 1,
          firstUnreadMessageId: "agent-background-answer",
          throughMessageId: null,
        },
      },
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await waitFor(() => expect(emitDynamicIslandAction).toBeDefined());
    vi.mocked(window.openbot.agent.markConversationRead).mockClear();
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(unreadPage);

    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({ type: "conversation-page", page: unreadPage });

    expect(await screen.findByText("Ready while OpenBot was in the background")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "message",
        message: { messageId: "agent-background-answer" },
      }),
    );

    window.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "agent-background-answer",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "idle",
      }),
    );
  });

  it("keeps a queued snapshot unread when the app loses focus before rendering it", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    vi.mocked(window.openbot.agent.markConversationRead).mockClear();

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 2,
        messages: [
          {
            id: "agent-focus-race",
            author: "assistant",
            text: "Rendered after focus was lost",
            createdAt: "2026-08-19T09:03:30.000Z",
            status: "completed",
          },
        ],
      },
    });
    window.dispatchEvent(new Event("blur"));

    expect(await screen.findByText("Rendered after focus was lost")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument();
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
  });

  it("extends an in-flight focus read to a newer visible agent reply", async () => {
    const oldPage = testConversationPage(
      "chief",
      [
        {
          id: "agent-focus-old",
          author: "assistant",
          text: "Older background reply",
          createdAt: "2026-08-19T09:03:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "agent-focus-old", throughMessageId: null },
      },
    );
    const newPage = testConversationPage(
      "chief",
      [
        ...oldPage.messages,
        {
          id: "agent-focus-new",
          author: "assistant",
          text: "Newer reply during focus read",
          createdAt: "2026-08-19T09:04:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 3,
        readState: { unreadCount: 2, firstUnreadMessageId: "agent-focus-old", throughMessageId: null },
      },
    );
    let resolveFirstRead: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({ type: "conversation-page", page: oldPage });
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(oldPage);
    vi.mocked(window.openbot.agent.markConversationRead)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementation(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: input.throughMessageId,
      }));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "agent-focus-old" },
        "local",
      ),
    );
    emitAgentEvent?.({ type: "conversation-page", page: newPage });
    expect(await screen.findByText("Newer reply during focus read")).toBeInTheDocument();
    resolveFirstRead?.({
      unreadCount: 1,
      firstUnreadMessageId: "agent-focus-new",
      throughMessageId: "agent-focus-old",
    });

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "agent-focus-new" },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument());
  });

  it("keeps a newer agent reply unread when an earlier focus read resolves in the background", async () => {
    const oldPage = testConversationPage(
      "chief",
      [
        {
          id: "agent-stale-read-old",
          author: "assistant",
          text: "Reply visible before focus",
          createdAt: "2026-08-19T09:03:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: { unreadCount: 1, firstUnreadMessageId: "agent-stale-read-old", throughMessageId: null },
      },
    );
    const newPage = testConversationPage(
      "chief",
      [
        ...oldPage.messages,
        {
          id: "agent-stale-read-new",
          author: "assistant",
          text: "Reply received after focus was lost",
          createdAt: "2026-08-19T09:04:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 3,
        readState: { unreadCount: 2, firstUnreadMessageId: "agent-stale-read-old", throughMessageId: null },
      },
    );
    let resolveFirstRead: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({ type: "conversation-page", page: oldPage });
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(oldPage);
    vi.mocked(window.openbot.agent.markConversationRead)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementation(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: input.throughMessageId,
      }));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "agent-stale-read-old" },
        "local",
      ),
    );
    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({ type: "conversation-page", page: newPage });
    expect(await screen.findByText("Reply received after focus was lost")).toBeInTheDocument();
    resolveFirstRead?.({
      unreadCount: 0,
      firstUnreadMessageId: null,
      throughMessageId: "agent-stale-read-old",
    });

    await waitFor(() => expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument());
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        { botId: "chief", throughMessageId: "agent-stale-read-new" },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument());
  });

  it("keeps another agent new until that agent is opened after focus returns", async () => {
    const unreadPage = testConversationPage(
      "sales-outbound",
      [
        {
          id: "sales-background-answer",
          author: "assistant",
          text: "Sales result from the background",
          createdAt: "2026-08-19T09:04:00.000Z",
          status: "completed",
        },
      ],
      {
        revision: 2,
        readState: {
          unreadCount: 1,
          firstUnreadMessageId: "sales-background-answer",
          throughMessageId: null,
        },
      },
    );
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    vi.mocked(window.openbot.agent.markConversationRead).mockClear();

    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({ type: "conversation-page", page: unreadPage });
    window.dispatchEvent(new Event("focus"));

    const sales = screen.getByRole("button", { name: /Sales Outbound/ });
    await waitFor(() => expect(sales).toHaveTextContent("1 new reply"));
    expect(window.openbot.agent.markConversationRead).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "message",
        message: { bot: { id: "sales-outbound" }, messageId: "sales-background-answer" },
      }),
    );

    vi.mocked(window.openbot.agent.readConversationPage).mockResolvedValue(unreadPage);
    await fireEvent.click(sales);

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "sales-outbound",
          throughMessageId: "sales-background-answer",
        },
        "local",
      ),
    );
    await waitFor(() => expect(sales).not.toHaveTextContent("1 new reply"));
    await waitFor(() =>
      expect(vi.mocked(window.openbot.dynamicIsland.publishPresentation).mock.calls.at(-1)?.[0]).toMatchObject({
        mode: "idle",
      }),
    );
  });

  it("shows a completed indicator only until the background app receives focus", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const chief = screen.getByRole("button", { name: /Chief/ });

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-foreground",
      status: "completed",
    });
    expect(chief).not.toHaveTextContent("Responded");

    window.dispatchEvent(new Event("blur"));
    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-background",
      status: "completed",
    });
    expect(chief).toHaveTextContent("Responded");

    window.dispatchEvent(new Event("focus"));
    expect(chief).not.toHaveTextContent("Responded");
  });

  it("keeps a message read when it arrives in the open agent chat", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
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

    await waitFor(() =>
      expect(document.querySelector('[data-chat-search-message="agent-visible-answer"]')).toHaveTextContent(
        "Visible as it arrives",
      ),
    );
    expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "agent-visible-answer",
        },
        "local",
      ),
    );
  });

  it("removes a citation marker split across streaming deltas", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    emitAgentEvent?.({
      type: "conversation-delta",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      messageId: "agent-cited-answer",
      delta: "Storms are likely.\u{e200}cite\u{e202}turn0fore",
      createdAt: "2026-08-19T09:03:00.000Z",
      revision: 1,
    });

    const message = await waitFor(() => {
      const element = document.querySelector('[data-chat-search-message="agent-cited-answer"]');
      expect(element).toHaveTextContent("Storms are likely.");
      return element;
    });
    expect(message).not.toHaveTextContent("cite");

    emitAgentEvent?.({
      type: "conversation-delta",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      messageId: "agent-cited-answer",
      delta: "cast0\u{e201} Take care.",
      createdAt: "2026-08-19T09:03:00.000Z",
      revision: 2,
    });

    await waitFor(() => expect(message).toHaveTextContent("Storms are likely. Take care."));
    expect(message).not.toHaveTextContent("turn0forecast0");
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
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "sales-outbound",
          throughMessageId: "sales-new",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
  });

  it("clears unread messages in the selected agent chat when queue loading fails", async () => {
    const unreadState = {
      unreadCount: 1,
      firstUnreadMessageId: "chief-new",
      throughMessageId: null,
    };
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({ chief: unreadState });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      readState: unreadState,
      messages: [
        {
          id: "chief-new",
          author: "assistant",
          text: "A new reply from Chief",
          createdAt: "2026-08-19T09:03:00.000Z",
          status: "completed",
        },
      ],
    });
    vi.mocked(window.openbot.agent.listQueue).mockRejectedValue(new Error("Queue unavailable"));

    render(() => <App />);
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    await screen.findByText("A new reply from Chief");
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "chief-new",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
    expect(screen.queryByRole("separator", { name: "New messages" })).not.toBeInTheDocument();
  });

  it("preserves explicit read intent when an agent status change supersedes the page request", async () => {
    const unreadState = {
      unreadCount: 1,
      firstUnreadMessageId: "chief-status-reply",
      throughMessageId: null,
    };
    const unreadPage = testConversationPage(
      "chief",
      [
        {
          id: "chief-status-reply",
          author: "assistant",
          text: "Reply visible after status change",
          createdAt: "2026-08-19T09:05:00.000Z",
          status: "completed",
        },
      ],
      { readState: unreadState },
    );
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({ chief: unreadState });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: unreadPage.threadId,
      activeTurnId: null,
      revision: unreadPage.revision,
      readState: unreadState,
      messages: unreadPage.messages,
    });
    render(() => <App />);
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();

    let resolveFirstPage: ((page: ConversationPage) => void) | undefined;
    let resolveSecondPage: ((page: ConversationPage) => void) | undefined;
    vi.mocked(window.openbot.agent.readConversationPage)
      .mockImplementationOnce(
        async (): Promise<ConversationPage> =>
          await new Promise((resolve) => {
            resolveFirstPage = resolve;
          }),
      )
      .mockImplementationOnce(
        async (): Promise<ConversationPage> =>
          await new Promise((resolve) => {
            resolveSecondPage = resolve;
          }),
      );
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() => expect(resolveFirstPage).toBeDefined());

    const currentStatus = await window.openbot.agent.getStatus();
    emitAgentEvent?.({ type: "status", status: { ...currentStatus, phase: "starting" } });
    await waitFor(() => expect(resolveSecondPage).toBeDefined());
    resolveFirstPage?.(unreadPage);
    resolveSecondPage?.(unreadPage);

    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "chief-status-reply",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("marks a newer reply that arrives while an opened agent chat is being marked read", async () => {
    const unreadState = {
      unreadCount: 1,
      firstUnreadMessageId: "chief-old-reply",
      throughMessageId: null,
    };
    vi.mocked(window.openbot.agent.listConversationReads).mockResolvedValueOnce({ chief: unreadState });
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValue({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      readState: unreadState,
      messages: [
        {
          id: "chief-old-reply",
          author: "assistant",
          text: "First visible reply",
          createdAt: "2026-08-19T09:03:00.000Z",
          status: "completed",
        },
      ],
    });
    let resolveInitialMark: ((state: NonNullable<ConversationPage["readState"]>) => void) | undefined;
    vi.mocked(window.openbot.agent.markConversationRead)
      .mockImplementationOnce(
        async (): Promise<NonNullable<ConversationPage["readState"]>> =>
          await new Promise((resolve) => {
            resolveInitialMark = resolve;
          }),
      )
      .mockImplementation(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: input.throughMessageId,
      }));

    render(() => <App />);
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "chief-old-reply",
        },
        "local",
      ),
    );

    emitAgentEvent?.({
      type: "conversation-page",
      page: testConversationPage(
        "chief",
        [
          {
            id: "chief-old-reply",
            author: "assistant",
            text: "First visible reply",
            createdAt: "2026-08-19T09:03:00.000Z",
            status: "completed",
          },
          {
            id: "chief-newer-reply",
            author: "assistant",
            text: "Newer visible reply",
            createdAt: "2026-08-19T09:04:00.000Z",
            status: "completed",
          },
        ],
        {
          revision: 2,
          readState: { unreadCount: 2, firstUnreadMessageId: "chief-old-reply", throughMessageId: null },
        },
      ),
    });

    expect(await screen.findByText("Newer visible reply")).toBeInTheDocument();
    resolveInitialMark?.({
      unreadCount: 1,
      firstUnreadMessageId: "chief-newer-reply",
      throughMessageId: "chief-old-reply",
    });
    await waitFor(() =>
      expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
        {
          botId: "chief",
          throughMessageId: "chief-newer-reply",
        },
        "local",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument());
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
    expect(window.openbot.agent.markConversationRead).toHaveBeenCalledWith(
      {
        botId: "chief",
        throughMessageId: "agent-new",
      },
      "local",
    );
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ behavior: "smooth", top: 840 }));
    expect(scrollElement.scrollTop).toBe(840);
  });

  it("keeps an open private message unread in the background and clears it on focus", async () => {
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
    await waitFor(() => expect(window.openbot.servers.readDirectConversationPage).toHaveBeenCalled());
    vi.mocked(window.openbot.servers.markDirectRead).mockClear();

    window.dispatchEvent(new Event("blur"));
    emitDirectMessage?.({
      type: "team-direct-message",
      memberIds: ["member-alice", "member-self"],
      message: {
        id: "direct-background",
        threadId: "thread-member-alice",
        senderMemberId: "member-alice",
        recipientMemberId: "member-self",
        text: "Private result from the background",
        createdAt: "2026-08-19T10:01:00.000Z",
        sequence: 1,
      },
    });

    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    expect(window.openbot.servers.markDirectRead).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 1,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: "1 new message" })).not.toBeInTheDocument());
  });

  it("extends an in-flight focus read to a newer visible private message", async () => {
    let resolveFirstRead: ((state: NonNullable<DirectConversationSnapshot["readState"]>) => void) | undefined;
    vi.mocked(window.openbot.servers.readDirectConversation).mockResolvedValueOnce({
      threadId: "thread-member-alice",
      otherMemberId: "member-alice",
      revision: 1,
      readState: { unreadCount: 1, firstUnreadMessageId: "direct-focus-old", throughSequence: 0 },
      messages: [
        {
          id: "direct-focus-old",
          threadId: "thread-member-alice",
          senderMemberId: "member-alice",
          recipientMemberId: "member-self",
          text: "Older private background message",
          createdAt: "2026-08-19T10:00:00.000Z",
          sequence: 1,
        },
      ],
    });
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
    window.dispatchEvent(new Event("blur"));
    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    vi.mocked(window.openbot.servers.markDirectRead)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementation(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughSequence: input.throughSequence,
      }));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 1,
      }),
    );
    emitDirectMessage?.({
      type: "team-direct-message",
      memberIds: ["member-alice", "member-self"],
      message: {
        id: "direct-focus-new",
        threadId: "thread-member-alice",
        senderMemberId: "member-alice",
        recipientMemberId: "member-self",
        text: "Newer private message during focus read",
        createdAt: "2026-08-19T10:01:00.000Z",
        sequence: 2,
      },
    });
    resolveFirstRead?.({
      unreadCount: 1,
      firstUnreadMessageId: "direct-focus-new",
      throughSequence: 1,
    });

    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 2,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument());
  });

  it("keeps a newer private message unread when an earlier focus read resolves in the background", async () => {
    let resolveFirstRead: ((state: NonNullable<DirectConversationSnapshot["readState"]>) => void) | undefined;
    vi.mocked(window.openbot.servers.readDirectConversation).mockResolvedValueOnce({
      threadId: "thread-member-alice",
      otherMemberId: "member-alice",
      revision: 1,
      readState: { unreadCount: 1, firstUnreadMessageId: "direct-stale-read-old", throughSequence: 0 },
      messages: [
        {
          id: "direct-stale-read-old",
          threadId: "thread-member-alice",
          senderMemberId: "member-alice",
          recipientMemberId: "member-self",
          text: "Private reply visible before focus",
          createdAt: "2026-08-19T10:00:00.000Z",
          sequence: 1,
        },
      ],
    });
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
    window.dispatchEvent(new Event("blur"));
    await fireEvent.click(await screen.findByRole("button", { name: /Alice/ }));
    expect(await screen.findByRole("status", { name: "1 new message" })).toBeInTheDocument();
    vi.mocked(window.openbot.servers.markDirectRead)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve;
          }),
      )
      .mockImplementation(async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughSequence: input.throughSequence,
      }));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 1,
      }),
    );
    window.dispatchEvent(new Event("blur"));
    emitDirectMessage?.({
      type: "team-direct-message",
      memberIds: ["member-alice", "member-self"],
      message: {
        id: "direct-stale-read-new",
        threadId: "thread-member-alice",
        senderMemberId: "member-alice",
        recipientMemberId: "member-self",
        text: "Private reply received after focus was lost",
        createdAt: "2026-08-19T10:01:00.000Z",
        sequence: 2,
      },
    });
    expect(await screen.findByText("Private reply received after focus was lost")).toBeInTheDocument();
    resolveFirstRead?.({ unreadCount: 0, firstUnreadMessageId: null, throughSequence: 1 });

    await waitFor(() => expect(screen.getByRole("status", { name: "1 new message" })).toBeInTheDocument());
    expect(window.openbot.servers.markDirectRead).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(window.openbot.servers.markDirectRead).toHaveBeenCalledWith({
        memberId: "member-alice",
        throughSequence: 2,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("status", { name: /new messages?/ })).not.toBeInTheDocument());
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
    window.dispatchEvent(new Event("blur"));
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
