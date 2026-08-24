import type {
  AgentEvent,
  AgentModelOption,
  AgentStatus,
  AppInfo,
  AppSetupState,
  AttachmentImportEvent,
  BotSummary,
  BrowserControlState,
  BrowserOpenInput,
  BrowserTab,
  CentralAuthState,
  CentralAuthUser,
  ConfigureHostInput,
  ConversationMessage,
  ConversationSnapshot,
  CreateTeamInviteInput,
  DirectConversationSnapshot,
  DirectMessage,
  DirectMessageRealtimeEvent,
  DirectThreadSummary,
  DirectTypingRealtimeEvent,
  HostStatus,
  InviteSummary,
  JoinServerInput,
  MacPermissionId,
  MacPermissionsState,
  OpenAttachmentInput,
  OpenBotDesktopApi,
  OpenSharedFileInput,
  OpenWorkspaceFileInput,
  QueueDelivery,
  QueueSnapshot,
  RemoteDesktopSession,
  ReorderQueueInput,
  RespondToPromptInput,
  SendDirectMessageInput,
  SendMessageInput,
  ServerSummary,
  SetAgentAvatarInput,
  SetMessageReactionInput,
  SetTeamTypingInput,
  SteerQueuedMessageInput,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamSessionSummary,
  UpdateBotInput,
  UpdateQueuedMessageInput,
  UpdateStatus,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import {
  STORY_AGENT_STATUS,
  STORY_APP_INFO,
  STORY_BOT_SUMMARIES,
  STORY_BROWSER_CONTROL,
  STORY_BROWSER_TABS,
  STORY_DIRECT_SNAPSHOTS,
  STORY_DIRECT_THREADS,
  STORY_HOST_STATUS,
  STORY_INVITES,
  STORY_MODELS,
  STORY_PRESENCE,
  STORY_REMOTE_DESKTOP_SESSION,
  STORY_SERVERS,
  STORY_SESSIONS,
  STORY_SNAPSHOTS,
  STORY_TEAM_MEMBERS,
  STORY_UPDATE_STATUS,
  STORY_USAGE,
} from "./fixtures";

type Listener<T> = (value: T) => void;

export interface MockOpenBotOptions {
  appInfo?: AppInfo;
  authState?: CentralAuthState;
  setupState?: AppSetupState;
  agentStatus?: AgentStatus;
  bots?: BotSummary[];
  models?: AgentModelOption[];
  snapshots?: Record<string, ConversationSnapshot>;
  browserTabs?: BrowserTab[];
  browserControlState?: BrowserControlState;
  servers?: ServerSummary[];
  presence?: TeamPresenceSnapshot;
  directThreads?: DirectThreadSummary[];
  directSnapshots?: Record<string, DirectConversationSnapshot>;
  hostStatus?: HostStatus;
  teamMembers?: TeamMemberSummary[];
  invites?: TeamInviteSummary[];
  sessions?: TeamSessionSummary[];
  remoteDesktopSessions?: RemoteDesktopSession[];
  updateStatus?: UpdateStatus;
}

export interface MockOpenBotControls {
  api: OpenBotDesktopApi;
  emitAgentEvent: (event: AgentEvent) => void;
  onLatestConversationOpened: (listener: (botId: string) => void) => () => void;
  onLatestDirectConversationOpened: (listener: (memberId: string) => void) => () => void;
  readConversationSnapshot: (botId: string) => ConversationSnapshot;
  updateConversationSnapshot: (botId: string, update: (snapshot: ConversationSnapshot) => void) => ConversationSnapshot;
  readDirectConversationSnapshot: (memberId: string) => DirectConversationSnapshot;
  updateDirectConversationSnapshot: (
    memberId: string,
    update: (snapshot: DirectConversationSnapshot) => void,
  ) => DirectConversationSnapshot;
  emitConversationDelta: (
    event: Omit<Extract<AgentEvent, { type: "conversation-delta" }>, "type" | "revision">,
  ) => void;
  setQueueSnapshot: (botId: string, deliveries: QueueDelivery[]) => QueueSnapshot;
  emitAuthState: (state: CentralAuthState) => void;
  emitPresence: (snapshot: TeamPresenceSnapshot) => void;
  emitDirectMessage: (event: DirectMessageRealtimeEvent) => void;
  emitDirectTyping: (event: DirectTypingRealtimeEvent) => void;
  emitInvite: (inviteUrl: string) => void;
  emitHostStatus: (status: HostStatus) => void;
  emitRemoteDesktopSessions: (sessions: RemoteDesktopSession[]) => void;
  dispose: () => void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMockOpenBot(options: MockOpenBotOptions = {}): MockOpenBotControls {
  const appInfo = clone(options.appInfo ?? STORY_APP_INFO);
  const defaultAuthState: CentralAuthState = {
    status: "signed_in",
    user: {
      id: "user-1",
      email: "person@example.com",
      name: "Norbert",
      avatarUrl: null,
    },
  };
  let authState = clone<CentralAuthState>(options.authState ?? defaultAuthState);
  let setupState = clone<AppSetupState>(options.setupState ?? { completed: true, preferredProvider: "codex" });
  const agentStatus = clone(options.agentStatus ?? STORY_AGENT_STATUS);
  let bots = clone(options.bots ?? STORY_BOT_SUMMARIES);
  const models = clone(options.models ?? STORY_MODELS);
  const snapshots = clone(options.snapshots ?? STORY_SNAPSHOTS);
  let browserTabs = clone(options.browserTabs ?? STORY_BROWSER_TABS);
  const browserControlState = clone(options.browserControlState ?? STORY_BROWSER_CONTROL);
  let servers = clone(options.servers ?? STORY_SERVERS);
  let presence = clone(options.presence ?? STORY_PRESENCE);
  let directThreads = clone(options.directThreads ?? STORY_DIRECT_THREADS);
  const directSnapshots = clone(options.directSnapshots ?? STORY_DIRECT_SNAPSHOTS);
  let hostStatus = clone(options.hostStatus ?? STORY_HOST_STATUS);
  let teamMembers = clone(options.teamMembers ?? STORY_TEAM_MEMBERS);
  let invites = clone(options.invites ?? STORY_INVITES);
  let sessions = clone(options.sessions ?? STORY_SESSIONS);
  let remoteDesktopSessions = clone(options.remoteDesktopSessions ?? [STORY_REMOTE_DESKTOP_SESSION]);
  let updateStatus = clone(options.updateStatus ?? STORY_UPDATE_STATUS);
  const usage = clone(STORY_USAGE);
  let botCounter = bots.length;
  let messageCounter = 10;
  let directMessageCounter = 10;

  const agentListeners = new Set<Listener<AgentEvent>>();
  const authListeners = new Set<Listener<CentralAuthState>>();
  const presenceListeners = new Set<Listener<TeamPresenceSnapshot>>();
  const directMessageListeners = new Set<Listener<DirectMessageRealtimeEvent>>();
  const directTypingListeners = new Set<Listener<DirectTypingRealtimeEvent>>();
  const inviteListeners = new Set<Listener<string>>();
  const hostListeners = new Set<Listener<HostStatus>>();
  const remoteDesktopListeners = new Set<Listener<RemoteDesktopSession[]>>();
  const updateListeners = new Set<Listener<UpdateStatus>>();
  const attachmentListeners = new Set<Listener<AttachmentImportEvent>>();
  const latestConversationListeners = new Set<Listener<string>>();
  const latestDirectConversationListeners = new Set<Listener<string>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const emit = <T>(listeners: Set<Listener<T>>, value: T) => {
    for (const listener of listeners) listener(clone(value));
  };
  const schedule = (callback: () => void, delay = 24) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  };
  const emptyQueue = (botId: string): QueueSnapshot => ({ botId, deliveries: [] });
  const queues = new Map<string, QueueSnapshot>(bots.map((bot) => [bot.id, emptyQueue(bot.id)]));

  function emitAgentEvent(event: AgentEvent): void {
    emit(agentListeners, event);
  }

  function emitAuthState(state: CentralAuthState): void {
    authState = clone(state);
    emit(authListeners, state);
  }

  function emitPresence(snapshot: TeamPresenceSnapshot): void {
    presence = clone(snapshot);
    emit(presenceListeners, snapshot);
  }

  function emitDirectMessage(event: DirectMessageRealtimeEvent): void {
    emit(directMessageListeners, event);
  }

  function emitDirectTyping(event: DirectTypingRealtimeEvent): void {
    emit(directTypingListeners, event);
  }

  function getDirectSnapshot(memberId: string): DirectConversationSnapshot {
    return (
      directSnapshots[memberId] ?? {
        threadId: `direct-${memberId}`,
        otherMemberId: memberId,
        messages: [],
        revision: 0,
      }
    );
  }

  function readDirectConversationSnapshot(memberId: string): DirectConversationSnapshot {
    return clone(getDirectSnapshot(memberId));
  }

  function updateDirectConversationSnapshot(
    memberId: string,
    update: (snapshot: DirectConversationSnapshot) => void,
  ): DirectConversationSnapshot {
    const snapshot = getDirectSnapshot(memberId);
    update(snapshot);
    snapshot.revision += 1;
    directSnapshots[memberId] = snapshot;
    return readDirectConversationSnapshot(memberId);
  }

  function emitInvite(inviteUrl: string): void {
    emit(inviteListeners, inviteUrl);
  }

  function emitHostStatus(status: HostStatus): void {
    hostStatus = clone(status);
    emit(hostListeners, status);
  }

  function emitRemoteDesktopSessions(sessionsValue: RemoteDesktopSession[]): void {
    remoteDesktopSessions = clone(sessionsValue);
    emit(remoteDesktopListeners, sessionsValue);
  }

  function getSnapshot(botId: string): ConversationSnapshot {
    return (
      snapshots[botId] ?? {
        botId,
        threadId: `thread-${botId}`,
        activeTurnId: null,
        revision: 0,
        messages: [],
      }
    );
  }

  function updateSnapshot(botId: string, update: (snapshot: ConversationSnapshot) => void): void {
    const snapshot = getSnapshot(botId);
    update(snapshot);
    snapshot.revision += 1;
    snapshots[botId] = snapshot;
    emitAgentEvent({ type: "conversation", snapshot });
  }

  function readConversationSnapshot(botId: string): ConversationSnapshot {
    return clone(getSnapshot(botId));
  }

  function updateConversationSnapshot(
    botId: string,
    update: (snapshot: ConversationSnapshot) => void,
  ): ConversationSnapshot {
    updateSnapshot(botId, update);
    return readConversationSnapshot(botId);
  }

  function emitConversationDelta(
    event: Omit<Extract<AgentEvent, { type: "conversation-delta" }>, "type" | "revision">,
  ): void {
    const snapshot = getSnapshot(event.botId);
    snapshot.revision += 1;
    snapshots[event.botId] = snapshot;
    emitAgentEvent({ ...event, type: "conversation-delta", revision: snapshot.revision });
  }

  function setQueueSnapshot(botId: string, deliveries: QueueDelivery[]): QueueSnapshot {
    const snapshot = { botId, deliveries: clone(deliveries) };
    queues.set(botId, snapshot);
    emitAgentEvent({ type: "queue-changed", snapshot });
    return clone(snapshot);
  }

  function createBotSummary(input: Partial<BotSummary> = {}): BotSummary {
    botCounter += 1;
    const id = input.id ?? `mock-agent-${botCounter}`;
    return {
      id,
      name: input.name ?? "New agent",
      title: input.title ?? "Generalist agent",
      description: input.description ?? "A new agent ready to help with focused work.",
      notifications: input.notifications ?? true,
      model: input.model ?? "gpt-5.6-luna",
      reasoningEffort: input.reasoningEffort ?? "medium",
      threadId: input.threadId ?? `thread-${id}`,
      workspacePath: input.workspacePath ?? `/mock/OpenBot/Bots/${id}`,
      preview: input.preview ?? "No messages yet",
      updatedAt: input.updatedAt ?? null,
      avatarSeed: input.avatarSeed ?? id,
      avatarHue: input.avatarHue ?? null,
      avatarUrl: input.avatarUrl ?? null,
    };
  }

  const api: OpenBotDesktopApi = {
    getAppInfo: async () => clone(appInfo),
    getSetupState: async () => clone(setupState),
    saveSetup: async ({ preferredProvider }) => {
      setupState = { completed: true, preferredProvider };
      return clone(setupState);
    },
    getMacPermissions: async (): Promise<MacPermissionsState> => ({
      screenRecording: "granted",
      accessibility: "granted",
    }),
    requestMacPermission: async (_permission: MacPermissionId) => ({
      screenRecording: "granted",
      accessibility: "granted",
    }),
    openExternal: async () => undefined,
    openUrl: async () => undefined,
    voice: {
      transcribe: async () => ({ text: "Mock voice transcript" }),
    },
    auth: {
      getState: async () => clone(authState),
      retry: async () => clone(authState),
      requestEmailCode: async (email) => {
        authState = {
          status: "code_sent",
          challengeId: "mock-challenge",
          email,
          expiresAt: Date.now() + 600_000,
          resendAvailableAt: Date.now() + 60_000,
          developmentCode: "2345-6789",
        };
        return clone(authState);
      },
      verifyEmailCode: async (_challengeId, _code) => {
        const email = authState.status === "code_sent" ? authState.email : "person@example.com";
        const user: CentralAuthUser = {
          id: "user-1",
          email,
          name: "Norbert",
          avatarUrl: null,
        };
        authState = { status: "signed_in", user };
        return clone(authState);
      },
      updateAvatar: async () => clone(authState),
      logout: async () => {
        authState = { status: "signed_out" };
        emitAuthState(authState);
        return clone(authState);
      },
      onEvent: (listener) => {
        authListeners.add(listener);
        return () => authListeners.delete(listener);
      },
    },
    agent: {
      getStatus: async () => clone(agentStatus),
      getUsage: async () => clone(usage),
      listModels: async () => clone(models),
      listBots: async () => clone(bots),
      createBot: async () => {
        const bot = createBotSummary();
        bots = [...bots, bot];
        queues.set(bot.id, emptyQueue(bot.id));
        emitAgentEvent({ type: "bots-changed", bots });
        return clone(bot);
      },
      updateBot: async (input: UpdateBotInput) => {
        const current = bots.find((bot) => bot.id === input.botId);
        if (!current) throw new Error("Agent not found");
        const { botId: _botId, ...updates } = input;
        const updated = { ...current, ...updates };
        bots = bots.map((bot) => (bot.id === updated.id ? updated : bot));
        emitAgentEvent({ type: "bots-changed", bots });
        return clone(updated);
      },
      setAvatar: async (input: SetAgentAvatarInput) => {
        const current = bots.find((bot) => bot.id === input.botId);
        if (!current) throw new Error("Agent not found");
        const updated = {
          ...current,
          avatarUrl: input.image ? `mock-avatar://${input.botId}` : null,
        };
        bots = bots.map((bot) => (bot.id === updated.id ? updated : bot));
        emitAgentEvent({ type: "bots-changed", bots });
        return clone(updated);
      },
      deleteBot: async (botId) => {
        bots = bots.filter((bot) => bot.id !== botId);
        queues.delete(botId);
        emitAgentEvent({ type: "bots-changed", bots });
      },
      readConversation: async (botId) => ({
        ...clone(getSnapshot(botId)),
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
      }),
      readConversationPage: async (input) => {
        if (!input.anchor || input.anchor.type === "latest") {
          emit(latestConversationListeners, input.botId);
        }
        const snapshot = clone(getSnapshot(input.botId));
        const messages = snapshot.messages.slice(-Math.min(input.limit ?? 50, 100));
        return {
          ...snapshot,
          messages,
          references: {},
          pageInfo: { hasOlder: snapshot.messages.length > messages.length, olderCursor: null },
          readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
        };
      },
      searchConversationMessages: async (input) => {
        const query = input.query.trim().toLocaleLowerCase();
        const results = bots.flatMap((bot) =>
          getSnapshot(bot.id)
            .messages.filter((message) => message.text.toLocaleLowerCase().includes(query))
            .map((message) => ({ botId: bot.id, message: clone(message) })),
        );
        return { results: results.slice(0, input.limit ?? 100), total: results.length, nextCursor: null };
      },
      listConversationReads: async () => ({}),
      markConversationRead: async (input) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: input.throughMessageId,
      }),
      chooseAttachments: async (_input) => [],
      onAttachmentImport: (listener) => {
        attachmentListeners.add(listener);
        return () => attachmentListeners.delete(listener);
      },
      discardDraftAttachment: async () => undefined,
      openAttachment: async (_input: OpenAttachmentInput) => undefined,
      openSharedFile: async (_input: OpenSharedFileInput) => undefined,
      openWorkspaceFile: async (_input: OpenWorkspaceFileInput) => undefined,
      sendMessage: async (input: SendMessageInput) => {
        const messageId = `mock-message-${messageCounter++}`;
        const deliveryId = `mock-delivery-${messageCounter++}`;
        const turnId = `mock-turn-${messageCounter++}`;
        const createdAt = new Date().toISOString();
        const userMessage: ConversationMessage = {
          id: messageId,
          turnId,
          author: "user",
          source: "user",
          text: input.text,
          createdAt,
          status: "completed",
          replyToMessageId: input.replyToMessageId ?? null,
        };
        const delivery: QueueDelivery = {
          id: deliveryId,
          messageId,
          recipientBotId: input.botId,
          sender: { kind: "user" },
          text: input.text,
          attachments: [],
          replyToMessageId: input.replyToMessageId ?? null,
          status: "running",
          position: null,
          turnId,
          error: null,
          createdAt,
        };
        updateSnapshot(input.botId, (snapshot) => {
          snapshot.activeTurnId = turnId;
          snapshot.messages = [...snapshot.messages, userMessage];
        });
        queues.set(input.botId, { botId: input.botId, deliveries: [delivery] });
        emitAgentEvent({
          type: "queue-changed",
          snapshot: queues.get(input.botId) ?? emptyQueue(input.botId),
        });
        emitAgentEvent({
          type: "turn-started",
          botId: input.botId,
          threadId: getSnapshot(input.botId).threadId ?? `thread-${input.botId}`,
          turnId,
        });

        schedule(() => {
          const assistantMessage: ConversationMessage = {
            id: `mock-reply-${messageCounter++}`,
            turnId,
            author: "assistant",
            source: "assistant",
            text: `Mock reply from ${bots.find((bot) => bot.id === input.botId)?.name ?? "agent"}: I received “${input.text}” and added it to the working context.`,
            createdAt: new Date().toISOString(),
            status: "completed",
          };
          updateSnapshot(input.botId, (snapshot) => {
            snapshot.activeTurnId = null;
            snapshot.messages = [...snapshot.messages, assistantMessage];
          });
          queues.set(input.botId, {
            botId: input.botId,
            deliveries: [{ ...delivery, status: "completed" }],
          });
          emitAgentEvent({
            type: "queue-changed",
            snapshot: queues.get(input.botId) ?? emptyQueue(input.botId),
          });
          emitAgentEvent({
            type: "turn-completed",
            botId: input.botId,
            threadId: getSnapshot(input.botId).threadId ?? `thread-${input.botId}`,
            turnId,
            status: "completed",
          });
        }, 80);

        return {
          messageId,
          deliveries: [{ id: deliveryId, recipientBotId: input.botId, status: "running", position: null }],
        };
      },
      setMessageReaction: async (input: SetMessageReactionInput) => {
        updateSnapshot(input.botId, (snapshot) => {
          const message = snapshot.messages.find((candidate) => candidate.id === input.messageId);
          if (message) message.reaction = input.emoji;
        });
      },
      listQueue: async (botId) => clone(queues.get(botId) ?? emptyQueue(botId)),
      cancelQueuedMessage: async (input) => {
        const queue = queues.get(input.botId) ?? emptyQueue(input.botId);
        queue.deliveries = queue.deliveries.map((delivery) =>
          delivery.id === input.deliveryId ? { ...delivery, status: "cancelled" } : delivery,
        );
        queues.set(input.botId, queue);
        emitAgentEvent({ type: "queue-changed", snapshot: queue });
      },
      steerQueuedMessage: async (input: SteerQueuedMessageInput) => {
        const queue = queues.get(input.botId) ?? emptyQueue(input.botId);
        queue.deliveries = queue.deliveries.map((delivery) =>
          delivery.id === input.deliveryId
            ? { ...delivery, status: "running", turnId: input.expectedTurnId, position: null }
            : delivery,
        );
        queues.set(input.botId, queue);
        emitAgentEvent({ type: "queue-changed", snapshot: queue });
      },
      updateQueuedMessage: async (input: UpdateQueuedMessageInput) => {
        const queue = queues.get(input.botId) ?? emptyQueue(input.botId);
        queue.deliveries = queue.deliveries.map((delivery) =>
          delivery.id === input.deliveryId ? { ...delivery, text: input.text } : delivery,
        );
        queues.set(input.botId, queue);
        emitAgentEvent({ type: "queue-changed", snapshot: queue });
      },
      reorderQueue: async (input: ReorderQueueInput) => {
        const queue = queues.get(input.botId) ?? emptyQueue(input.botId);
        const byId = new Map(queue.deliveries.map((delivery) => [delivery.id, delivery]));
        queue.deliveries = input.deliveryIds.flatMap((deliveryId, index) => {
          const delivery = byId.get(deliveryId);
          return delivery ? [{ ...delivery, position: index + 1 }] : [];
        });
        queues.set(input.botId, queue);
        emitAgentEvent({ type: "queue-changed", snapshot: queue });
      },
      interrupt: async (input) => {
        emitAgentEvent({
          type: "turn-completed",
          botId: input.botId,
          threadId: getSnapshot(input.botId).threadId ?? `thread-${input.botId}`,
          turnId: input.turnId,
          status: "interrupted",
        });
      },
      respondToPrompt: async (_input: RespondToPromptInput) => undefined,
      respondToApproval: async () => undefined,
      onEvent: (listener) => {
        agentListeners.add(listener);
        return () => agentListeners.delete(listener);
      },
    },
    browser: {
      open: async (input: BrowserOpenInput) => {
        const tab: BrowserTab = {
          id: `browser-tab-${browserTabs.length + 1}`,
          title: input.url,
          url: input.url,
          loading: false,
          ownerThreadId: input.ownerThreadId ?? null,
          ownerBotId: input.ownerBotId ?? null,
        };
        browserTabs = [...browserTabs, tab];
        emitAgentEvent({ type: "browser-changed", tabs: browserTabs, activeTabId: tab.id });
        return clone(tab);
      },
      activate: async () => undefined,
      reload: async () => undefined,
      close: async (tabId) => {
        browserTabs = browserTabs.filter((tab) => tab.id !== tabId);
        emitAgentEvent({
          type: "browser-changed",
          tabs: browserTabs,
          activeTabId: browserTabs[0]?.id ?? null,
        });
      },
      listTabs: async () => clone(browserTabs),
      getControlState: async () => clone(browserControlState),
      setVisible: async () => undefined,
    },
    update: {
      getStatus: async () => clone(updateStatus),
      check: async () => {
        updateStatus = { ...updateStatus, phase: "up-to-date", availableVersion: null };
        emit(updateListeners, updateStatus);
        return clone(updateStatus);
      },
      download: async () => {
        updateStatus = { ...updateStatus, phase: "downloading", progress: 0 };
        emit(updateListeners, updateStatus);
        return clone(updateStatus);
      },
      install: async () => {
        updateStatus = { ...updateStatus, phase: "installing" };
        emit(updateListeners, updateStatus);
      },
      onEvent: (listener) => {
        updateListeners.add(listener);
        return () => updateListeners.delete(listener);
      },
    },
    maintenance: {
      exportData: async () => ({ saved: true }),
      exportDiagnostics: async () => ({ saved: true }),
    },
    servers: {
      list: async () => clone(servers),
      select: async (serverId) => {
        servers = servers.map((server) => ({ ...server, active: server.id === serverId }));
        emitAgentEvent({ type: "bots-changed", bots });
        return clone(servers);
      },
      reorder: async ({ serverIds }) => {
        const serversById = new Map(servers.map((server) => [server.id, server]));
        servers = [
          ...servers.filter((server) => server.kind === "local"),
          ...serverIds.flatMap((serverId) => {
            const server = serversById.get(serverId);
            return server?.kind === "remote" ? [server] : [];
          }),
        ];
        return clone(servers);
      },
      join: async (input: JoinServerInput) => {
        const server: ServerSummary = {
          id: `server-${servers.length + 1}`,
          name: "Joined workspace",
          logoUrl: null,
          kind: "remote",
          state: "online",
          apiUrl: input.inviteUrl,
          remoteDesktopAvailable: false,
          role: "member",
          active: false,
        };
        servers = [...servers, server];
        return clone(server);
      },
      previewInvite: async () => ({
        serverId: "00000000-0000-4000-8000-000000000000",
        serverName: "Joined workspace",
        apiHostname: "story-host.openbot.run",
        role: "member",
        expiresAt: "2026-09-19T10:00:00.000Z",
        emailBound: false,
      }),
      takePendingInvite: async () => null,
      login: async (input) => {
        const server = servers.find((candidate) => candidate.id === input.serverId);
        if (!server) throw new Error("Server not found");
        return clone(server);
      },
      remove: async (serverId) => {
        servers = servers.filter((server) => server.id !== serverId);
      },
      getPresence: async () => clone(presence),
      getPresenceFor: async () => clone(presence),
      refreshIdentity: async (serverId) => {
        const server = servers.find((candidate) => candidate.id === serverId);
        if (!server) throw new Error("Server not found");
        return clone(server);
      },
      listMembers: async () => clone(teamMembers),
      updateMember: async (_serverId, input: UpdateTeamMemberInput) => {
        const member = teamMembers.find((candidate) => candidate.id === input.memberId);
        if (!member) throw new Error("Member not found");
        const updated = { ...member, ...input };
        teamMembers = teamMembers.map((candidate) => (candidate.id === updated.id ? updated : candidate));
        return clone(updated);
      },
      removeMember: async (_serverId, memberId) => {
        teamMembers = teamMembers.filter((member) => member.id !== memberId);
      },
      listInvites: async () => clone(invites),
      revokeInvite: async (_serverId, inviteId) => {
        invites = invites.filter((invite) => invite.id !== inviteId);
      },
      createInvite: async (_serverId, input: CreateTeamInviteInput): Promise<InviteSummary> => ({
        id: `invite-${invites.length + 1}`,
        inviteUrl: "https://team.example.com/invite/story-invite",
        expiresAt: "2026-09-19T10:00:00.000Z",
        role: input.role,
        usedAt: null,
        email: input.email ?? null,
      }),
      setTyping: async (_input: SetTeamTypingInput) => undefined,
      onPresence: (listener) => {
        presenceListeners.add(listener);
        return () => presenceListeners.delete(listener);
      },
      listDirectThreads: async () => clone(directThreads),
      readDirectConversation: async (memberId) =>
        clone(
          directSnapshots[memberId] ?? {
            threadId: `direct-${memberId}`,
            otherMemberId: memberId,
            messages: [],
            revision: 0,
          },
        ),
      readDirectConversationPage: async (input) => {
        if (!input.anchor || input.anchor.type === "latest") {
          emit(latestDirectConversationListeners, input.memberId);
        }
        const snapshot = clone(
          directSnapshots[input.memberId] ?? {
            threadId: `direct-${input.memberId}`,
            otherMemberId: input.memberId,
            messages: [],
            revision: 0,
          },
        );
        const messages = snapshot.messages.slice(-Math.min(input.limit ?? 50, 100));
        return {
          ...snapshot,
          messages,
          pageInfo: { hasOlder: snapshot.messages.length > messages.length, olderCursor: null },
        };
      },
      sendDirectMessage: async (input: SendDirectMessageInput) => {
        const message: DirectMessage = {
          id: input.clientMessageId,
          threadId: `direct-${input.memberId}`,
          senderMemberId: "member-self",
          recipientMemberId: input.memberId,
          text: input.text,
          createdAt: new Date().toISOString(),
          sequence: directMessageCounter++,
        };
        const snapshot = directSnapshots[input.memberId] ?? {
          threadId: message.threadId,
          otherMemberId: input.memberId,
          messages: [],
          revision: 0,
        };
        snapshot.messages = [...snapshot.messages, message];
        snapshot.revision += 1;
        directSnapshots[input.memberId] = snapshot;
        return clone(message);
      },
      markDirectRead: async (input) => {
        directThreads = directThreads.map((thread) =>
          thread.otherMemberId === input.memberId ? { ...thread, unreadCount: 0 } : thread,
        );
        const snapshot = directSnapshots[input.memberId];
        const readState = {
          unreadCount: 0,
          firstUnreadMessageId: null,
          throughSequence: input.throughSequence,
        };
        if (snapshot) snapshot.readState = readState;
        return readState;
      },
      setDirectTyping: async () => undefined,
      onDirectMessage: (listener) => {
        directMessageListeners.add(listener);
        return () => directMessageListeners.delete(listener);
      },
      onDirectTyping: (listener) => {
        directTypingListeners.add(listener);
        return () => directTypingListeners.delete(listener);
      },
      onEvent: (listener) => {
        void listener;
        return () => undefined;
      },
      onInvite: (listener) => {
        inviteListeners.add(listener);
        return () => inviteListeners.delete(listener);
      },
    },
    host: {
      getStatus: async () => clone(hostStatus),
      configure: async (input: ConfigureHostInput) => {
        hostStatus = {
          ...hostStatus,
          configured: true,
          phase: "idle",
          serverName: input.serverName,
        };
        emitHostStatus(hostStatus);
        return clone(hostStatus);
      },
      updateIdentity: async (input) => {
        hostStatus = {
          ...hostStatus,
          ...(input.serverName === undefined ? {} : { serverName: input.serverName }),
        };
        emitHostStatus(hostStatus);
        return clone(hostStatus);
      },
      getPresence: async () => clone(presence),
      start: async () => {
        hostStatus = { ...hostStatus, phase: "online", apiOnline: true, remoteDesktopReady: true };
        emitHostStatus(hostStatus);
        return clone(hostStatus);
      },
      stop: async () => {
        hostStatus = { ...hostStatus, phase: "idle", apiOnline: false, remoteDesktopReady: false };
        emitHostStatus(hostStatus);
        return clone(hostStatus);
      },
      listMembers: async () => clone(teamMembers),
      updateMember: async (input: UpdateTeamMemberInput) => {
        const member = teamMembers.find((candidate) => candidate.id === input.memberId);
        if (!member) throw new Error("Member not found");
        const updated = { ...member, ...input };
        teamMembers = teamMembers.map((candidate) => (candidate.id === updated.id ? updated : candidate));
        return clone(updated);
      },
      removeMember: async (memberId) => {
        teamMembers = teamMembers.filter((member) => member.id !== memberId);
      },
      listSessions: async () => clone(sessions),
      revokeSession: async (sessionId) => {
        sessions = sessions.filter((session) => session.id !== sessionId);
      },
      listInvites: async () => clone(invites),
      revokeInvite: async (inviteId) => {
        invites = invites.filter((invite) => invite.id !== inviteId);
      },
      createInvite: async (input: CreateTeamInviteInput): Promise<InviteSummary> => ({
        id: `invite-${invites.length + 1}`,
        role: input.role,
        expiresAt: "2026-09-19T10:00:00.000Z",
        usedAt: null,
        inviteUrl: "https://openbot.run/join?invite=mock-invite",
        email: input.email ?? null,
      }),
      onEvent: (listener) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    },
    remoteDesktop: {
      list: async () => clone(remoteDesktopSessions),
      connect: async (input) => {
        const session: RemoteDesktopSession = {
          ...clone(STORY_REMOTE_DESKTOP_SESSION),
          id: `remote-desktop-${remoteDesktopSessions.length + 1}`,
          serverId: input.serverId,
          createdAt: new Date().toISOString(),
        };
        remoteDesktopSessions = [...remoteDesktopSessions, session];
        emitRemoteDesktopSessions(remoteDesktopSessions);
        return clone(session);
      },
      selectDisplay: async (input) => {
        remoteDesktopSessions = remoteDesktopSessions.map((session) =>
          session.serverId === input.serverId ? { ...session, selectedDisplayId: input.displayId } : session,
        );
        emitRemoteDesktopSessions(remoteDesktopSessions);
      },
      disconnect: async (sessionId) => {
        remoteDesktopSessions = remoteDesktopSessions.filter((session) => session.id !== sessionId);
        emitRemoteDesktopSessions(remoteDesktopSessions);
      },
      onEvent: (listener) => {
        remoteDesktopListeners.add(listener);
        return () => remoteDesktopListeners.delete(listener);
      },
    },
  };

  return {
    api,
    emitAgentEvent,
    onLatestConversationOpened: (listener) => {
      latestConversationListeners.add(listener);
      return () => latestConversationListeners.delete(listener);
    },
    onLatestDirectConversationOpened: (listener) => {
      latestDirectConversationListeners.add(listener);
      return () => latestDirectConversationListeners.delete(listener);
    },
    readConversationSnapshot,
    updateConversationSnapshot,
    readDirectConversationSnapshot,
    updateDirectConversationSnapshot,
    emitConversationDelta,
    setQueueSnapshot,
    emitAuthState,
    emitPresence,
    emitDirectMessage,
    emitDirectTyping,
    emitInvite,
    emitHostStatus,
    emitRemoteDesktopSessions,
    dispose: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      agentListeners.clear();
      authListeners.clear();
      presenceListeners.clear();
      directMessageListeners.clear();
      directTypingListeners.clear();
      inviteListeners.clear();
      hostListeners.clear();
      remoteDesktopListeners.clear();
      updateListeners.clear();
      attachmentListeners.clear();
      latestConversationListeners.clear();
      latestDirectConversationListeners.clear();
      void appInfo;
    },
  };
}
