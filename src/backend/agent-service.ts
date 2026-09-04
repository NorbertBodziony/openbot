import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AccountUsage,
  AgentEvent,
  AgentModelOption,
  AgentRuntimeSnapshot,
  AgentStatus,
  AttachmentDataInput,
  AvatarImageInput,
  BotMemory,
  BotSummary,
  ConversationPage,
  ConversationPageAnchor,
  ConversationReadState,
  ConversationSearchPage,
  ConversationSnapshot,
  ConversationWithReadState,
  CreateBotInput,
  CreateBotMemoryInput,
  CreateRoutineInput,
  DeleteBotMemoryInput,
  DeleteRoutineInput,
  DraftAttachment,
  DuplicateBotResult,
  ListRoutineRunsInput,
  QueuedMessageReceipt,
  QueueSnapshot,
  ReorderQueueInput,
  RespondToApprovalInput,
  RespondToBrowserTakeoverInput,
  RespondToPromptInput,
  Routine,
  RoutineRun,
  SendMessageInput,
  SetMessageReactionInput,
  SidebarLayoutSnapshot,
  SteerQueuedMessageInput,
  TestRoutineInput,
  UpdateBotInput,
  UpdateBotMemoryInput,
  UpdateQueuedMessageInput,
  UpdateRoutineInput,
} from "@openbot/contracts/ipc";
import { AGENT_RUNTIME_TEXT_LIMIT, isMessageReaction } from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { AgentMemories } from "./agent/agent-memories";
import { AttachmentGateway } from "./agent/attachment-gateway";
import { AttentionRegistry } from "./agent/attention-registry";
import { BootRecovery } from "./agent/boot-recovery";
import { ContextCompaction } from "./agent/context-compaction";
import { ConversationRuntime } from "./agent/conversation-runtime";
import {
  agentNamesById,
  deliveryInput,
  displayMessageReferences,
  responseAttachmentMessageId,
} from "./agent/delivery-content";
import { DeltaBuffer } from "./agent/delta-buffer";
import { DrainScheduler } from "./agent/drain-scheduler";
import { DuplicationGate } from "./agent/duplication-gate";
import { type AgentHostedSites, HostedSiteCoordinator } from "./agent/hosted-site-coordinator";
import { isHostedSiteMutationTool } from "./agent/hosted-site-events";
import { ImageGenRuntime } from "./agent/image-gen-runtime";
import { MailboxSync } from "./agent/mailbox-sync";
import { type AgentClientFactory, ProviderRuntime } from "./agent/provider-runtime";
import { type RoutineMutationOptions, RoutineScheduler } from "./agent/routine-scheduler";
import { type OpenBotToolResponse, openBotToolResult } from "./agent/routine-tools";
import { fitRuntimeSnapshot } from "./agent/runtime-snapshot";
import { isDynamicToolCall, providerForBot, providerLabel } from "./agent/thread-items";
import { ThreadLifecycle } from "./agent/thread-lifecycle";
import { type AgentBrowserHost, TurnLifecycle } from "./agent/turn-lifecycle";
import type { AgentClient, AgentProvider } from "./agent-client";
import type { BotStore } from "./agent-store";
import { OPENBOT_BROWSER_NAMESPACE } from "./browser-host";
import { type ConversationMarkerExclusions, ConversationReadStore } from "./conversation-read-store";
import { mergeConversationSnapshots } from "./conversation-snapshots";
import type { MailboxStore } from "./mailbox-store";
import { type AppServerRequest, type DynamicToolCallParams, decodeRecordResponse, isRecord } from "./protocol";
import { isWithin, sharedPathFromInput, workspacePathFromInput } from "./workspace-paths";

const logger = createOpenBotLogger("agent-service");

// Both types were declared in this module before the split and are part of the frozen public
// surface, so they keep being reachable from here rather than only from the controller that owns
// them now. `Pick<AgentService, ...>` in team-api-server.ts does not cover exported types.
export type { AgentClientFactory } from "./agent/provider-runtime";
export type { RoutineMutationOptions } from "./agent/routine-scheduler";

interface AgentServiceEvents {
  event: [event: AgentEvent];
}

export interface ResolvedSharedFile {
  path: string;
  name: string;
  size: number;
}

export class AgentService extends EventEmitter<AgentServiceEvents> {
  readonly #store: BotStore;
  readonly #mailbox: MailboxStore;
  readonly #browser: AgentBrowserHost;
  readonly #conversationReads: ConversationReadStore;
  readonly #memories: AgentMemories;
  readonly #routines: RoutineScheduler;
  readonly #providers: ProviderRuntime;
  readonly #prepareBotWorkspace: (bot: BotSummary) => Promise<void>;
  readonly #hostedSites: HostedSiteCoordinator;
  readonly #conversation: ConversationRuntime;
  readonly #attention: AttentionRegistry;
  readonly #images: ImageGenRuntime;
  readonly #threads: ThreadLifecycle;
  readonly #drain: DrainScheduler;
  readonly #attachments: AttachmentGateway;
  readonly #mailboxSync: MailboxSync;
  readonly #boot: BootRecovery;
  readonly #deltas: DeltaBuffer;
  readonly #turn: TurnLifecycle;
  readonly #compaction: ContextCompaction;
  readonly #duplication: DuplicationGate;
  #initialized = false;
  #stopping = false;

  constructor(
    store: BotStore,
    mailbox: MailboxStore,
    browser: AgentBrowserHost,
    requestTimeoutMs = 30_000,
    preferredProvider: AgentProvider = "codex",
    clientFactory: AgentClientFactory | null = null,
    bundledCodexExecutable: string | null | undefined = undefined,
    bundledClaudeExecutable: string | null | undefined = null,
    bundledGrokExecutable: string | null | undefined = null,
    prepareBotWorkspace: (bot: BotSummary) => Promise<void> = async () => undefined,
    hostedSites: AgentHostedSites | null = null,
  ) {
    super();
    this.#store = store;
    this.#mailbox = mailbox;
    this.#browser = browser;
    this.#conversationReads = new ConversationReadStore(store.database);
    this.#prepareBotWorkspace = prepareBotWorkspace;
    this.#conversation = new ConversationRuntime(
      store,
      (event) => this.#emit(event),
      () => this.listBots(),
    );
    this.#memories = new AgentMemories({
      store,
      conversation: this.#conversation,
      emit: (event) => this.#emit(event),
      emitError: (code, error, botId) => this.#emitError(code, error, botId),
    });
    this.#routines = new RoutineScheduler({
      store,
      mailbox,
      conversation: this.#conversation,
      hooks: {
        emit: (event) => this.#emit(event),
        emitError: (code, error, botId) => this.#emitError(code, error, botId),
        emitQueue: (botId) => this.#mailboxSync.emitQueue(botId),
        scheduleDrain: (botId) => this.#drain.scheduleDrain(botId),
        interrupt: (botId, turnId) => this.interrupt(botId, turnId),
        awaitDrain: (botId) => this.#drain.taskFor(botId),
        syncMailboxMessages: (snapshot) => this.#mailboxSync.syncMailboxMessages(snapshot),
        listBots: () => this.listBots(),
        pendingDuplicateBots: () => this.#duplication.pendingBots(),
        isRunning: () => this.#initialized && !this.#stopping,
      },
    });
    this.#hostedSites = new HostedSiteCoordinator({
      store,
      conversation: this.#conversation,
      hostedSites,
      emitError: (code, error, botId) => this.#emitError(code, error, botId),
      isStopping: () => this.#stopping,
    });
    this.#providers = new ProviderRuntime({
      conversation: this.#conversation,
      hooks: {
        bindClient: (client) => {
          client.on("notification", (notification) => this.#turn.handleNotification(notification, client));
          client.on("request", (request) => void this.#handleServerRequest(client, request));
        },
        onProvidersReady: async () => {
          await this.#boot.reconcileUnresolvedDeliveries();
          void this.#boot.backfillProviderHistory();
          for (const bot of this.#store.list()) this.#drain.scheduleDrain(bot.id);
        },
        onProviderLost: (client) => {
          this.#compaction.dispose();
          this.#attention.clearPrompts(client);
          this.#attention.clearBrowserTakeovers();
          this.#attention.clearApprovals();
          this.#browser.clearControls();
        },
        isStopping: () => this.#stopping,
      },
      emit: (event) => this.#emit(event),
      emitError: (code, error, botId) => this.#emitError(code, error, botId),
      requestTimeoutMs,
      preferredProvider,
      clientFactory,
      bundledCodexExecutable,
      bundledClaudeExecutable,
      bundledGrokExecutable,
    });
    this.#compaction = new ContextCompaction({
      store,
      providers: this.#providers,
      emitError: (code, error, botId) => this.#emitError(code, error, botId),
      scheduleDrain: (botId) => this.#drain.scheduleDrain(botId),
    });
    this.#attention = new AttentionRegistry({
      conversation: this.#conversation,
      browser: this.#browser,
      hostedSites: this.#hostedSites,
      routines: this.#routines,
      emit: (event) => this.#emit(event),
      emitError: (code, error, botId) => this.#emitError(code, error, botId),
      emitRuntimeSnapshot: () => this.#emitRuntimeSnapshot(),
    });
    this.#duplication = new DuplicationGate({
      store,
      mailbox,
      conversation: this.#conversation,
      memories: this.#memories,
      routines: this.#routines,
      hooks: {
        emit: (event) => this.#emit(event),
        listBots: () => this.listBots(),
        deleteBotData: (bot) => this.#deleteBotData(bot),
        hasAttentionFor: (botId) => this.#attention.hasAttentionFor(botId),
        scheduleDrain: (botId) => this.#drain.scheduleDrain(botId),
      },
    });
    this.#browser.onChanged((tabs, activeTabId) => {
      this.#attention.cancelTakeoversForMissingTabs(tabs);
      this.#emit({ type: "browser-changed", tabs, activeTabId });
    });
    this.#images = new ImageGenRuntime({
      conversation: this.#conversation,
      mailbox,
      hooks: {
        trackItem: (itemId, turnId) => {
          this.#turn.trackItem(itemId, turnId);
        },
      },
    });
    this.#deltas = new DeltaBuffer({
      conversation: this.#conversation,
      database: store.database,
      hooks: { emit: (event) => this.#emit(event) },
    });
    this.#mailboxSync = new MailboxSync({
      database: store.database,
      mailbox,
      conversation: this.#conversation,
      routines: this.#routines,
      hooks: {
        emit: (event) => this.#emit(event),
        emitError: (code, error, botId) => this.#emitError(code, error, botId),
      },
    });
    this.#boot = new BootRecovery({
      store,
      mailbox,
      providers: this.#providers,
      conversation: this.#conversation,
      mailboxSync: this.#mailboxSync,
      hooks: { emitError: (code, error, botId) => this.#emitError(code, error, botId) },
    });
    this.#attachments = new AttachmentGateway({
      conversation: this.#conversation,
      mailbox,
      sharedRoot: store.sharedRoot,
      hooks: {
        emit: (event) => this.#emit(event),
        emitError: (code, error, botId) => this.#emitError(code, error, botId),
      },
    });
    this.#threads = new ThreadLifecycle({
      store,
      mailbox,
      conversation: this.#conversation,
      memories: this.#memories,
      compaction: this.#compaction,
      hooks: {
        logRecovery: (botId, provider, outcome) =>
          logger.warn("Recovered an unavailable provider session.", { botId, provider, outcome }),
      },
    });
    this.#drain = new DrainScheduler({
      store,
      mailbox,
      mailboxSync: this.#mailboxSync,
      conversation: this.#conversation,
      providers: this.#providers,
      duplication: this.#duplication,
      compaction: this.#compaction,
      routines: this.#routines,
      threads: this.#threads,
      hooks: {
        emitError: (code, error, botId) => this.#emitError(code, error, botId),
        isStopping: () => this.#stopping,
      },
    });
    this.#browser.onControlChanged((state) => {
      this.#emit({ type: "browser-control-changed", state });
    });
    this.#turn = new TurnLifecycle({
      store,
      mailbox,
      mailboxSync: this.#mailboxSync,
      conversation: this.#conversation,
      providers: this.#providers,
      memories: this.#memories,
      attention: this.#attention,
      browser,
      compaction: this.#compaction,
      images: this.#images,
      deltas: this.#deltas,
      hooks: {
        emit: (event) => this.#emit(event),
        emitError: (code, error, botId) => this.#emitError(code, error, botId),
        emitRuntimeSnapshot: () => this.#emitRuntimeSnapshot(),
        scheduleDrain: (botId) => this.#drain.scheduleDrain(botId),
        listBots: () => this.listBots(),
      },
    });
  }

  getStatus(): AgentStatus {
    return this.#providers.status();
  }

  async getUsage(botId?: string): Promise<AccountUsage> {
    if (!botId) return this.#providers.usage();
    const bot = this.listBots().find((candidate) => candidate.id === botId);
    if (!bot) throw new Error("Agent not found.");
    return this.#providers.usage({ provider: bot.provider, model: bot.model });
  }

  listBots(): BotSummary[] {
    return this.#duplication.visibleBots(this.#store.list());
  }

  getRuntimeSnapshot(): AgentRuntimeSnapshot {
    const bots = this.listBots();
    const runtimeBots: AgentRuntimeSnapshot["bots"] = bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      notifications: bot.notifications,
      preview: bot.preview.slice(0, AGENT_RUNTIME_TEXT_LIMIT),
      updatedAt: bot.updatedAt,
      avatarSeed: bot.avatarSeed,
      avatarHue: bot.avatarHue,
      avatarUrl: bot.avatarUrl,
    }));
    const activeTurns: AgentRuntimeSnapshot["activeTurns"] = [];
    const latestMessages: AgentRuntimeSnapshot["latestMessages"] = [];
    for (const bot of bots) {
      const live = this.#conversation.snapshot(bot.id);
      const liveLatest = [...(live?.messages ?? [])]
        .reverse()
        .find(
          (message) =>
            (message.author === "assistant" || message.author === "agent") &&
            message.itemType !== "commentary" &&
            message.itemType !== "question_prompt" &&
            message.itemType !== "agent_attachment",
        );
      const persisted =
        !live || !liveLatest
          ? this.#store.database.readConversationRuntime(bot.id, bot.threadId)
          : { activeTurnId: null, latestMessage: null };
      const activeTurnId = live ? live.activeTurnId : persisted.activeTurnId;
      if (activeTurnId && bot.threadId) {
        activeTurns.push({ botId: bot.id, threadId: bot.threadId, turnId: activeTurnId });
      }
      const latest = liveLatest ?? persisted.latestMessage;
      if (latest) {
        latestMessages.push({
          botId: bot.id,
          id: latest.id,
          text: latest.text.slice(0, AGENT_RUNTIME_TEXT_LIMIT),
          createdAt: latest.createdAt,
        });
      }
    }
    return fitRuntimeSnapshot({
      bots: runtimeBots,
      activeTurns,
      work: this.#mailbox.listRuntimeWork(
        bots.map((bot) => bot.id),
        this.#turn.failedTurns(),
      ),
      latestMessages,
      ...this.#attention.runtimeAttention(),
      failedTurns: [...this.#turn.failedTurns()].map(([botId, turnId]) => ({ botId, turnId })),
    });
  }

  listMemories(botId: string): BotMemory[] {
    return this.#memories.list(botId);
  }

  createMemory(input: CreateBotMemoryInput): BotMemory {
    return this.#memories.create(input);
  }

  updateMemory(input: UpdateBotMemoryInput): BotMemory {
    return this.#memories.update(input);
  }

  deleteMemory(input: DeleteBotMemoryInput): void {
    this.#memories.delete(input);
  }

  clearMemories(botId: string): void {
    this.#memories.clear(botId);
  }

  listRoutines(botId: string): Routine[] {
    return this.#routines.list(botId);
  }

  createRoutine(input: CreateRoutineInput, options: RoutineMutationOptions = {}): Routine {
    return this.#routines.create(input, options);
  }

  updateRoutine(input: UpdateRoutineInput, options: RoutineMutationOptions = {}): Routine {
    return this.#routines.update(input, options);
  }

  deleteRoutine(input: DeleteRoutineInput, options: RoutineMutationOptions = {}): Promise<void> {
    return this.#routines.delete(input, options);
  }

  testRoutine(input: TestRoutineInput): Promise<RoutineRun> {
    return this.#routines.test(input);
  }

  listRoutineRuns(input: ListRoutineRunsInput): RoutineRun[] {
    return this.#routines.listRuns(input);
  }

  listModels(): AgentModelOption[] {
    return this.#providers.listModels();
  }

  async createBot(input: CreateBotInput): Promise<BotSummary> {
    const initialMessage = input.initialMessage.trim();
    if (!initialMessage) throw new Error("Initial message is required.");
    if (input.initialMessage.length > INPUT_LIMITS.messageText) throw new Error("Initial message is too long.");
    let bot = await this.#store.createBot(input);
    try {
      await this.#prepareBotWorkspace(bot);
      const preferredProvider = this.#providers.preferredProvider();
      if (preferredProvider !== bot.provider) {
        const models = this.#providers.listModels();
        const preferredDefault =
          preferredProvider === "codex" ? "gpt-5.6-luna" : preferredProvider === "claude" ? "claude-opus-5" : null;
        const preferredModel =
          models.find((model) => model.provider === preferredProvider && model.id === preferredDefault) ??
          models.find((model) => model.provider === preferredProvider);
        if (!preferredModel) throw new Error(`${providerLabel(preferredProvider)} has no available model.`);
        bot = await this.#store.updateBot({
          botId: bot.id,
          provider: preferredProvider,
          model: preferredModel.id,
          reasoningEffort: preferredModel.defaultReasoningEffort,
        });
      }
      await this.sendMessage({ botId: bot.id, text: initialMessage, attachmentDraftIds: [] });
      return this.#store.list().find((candidate) => candidate.id === bot.id) ?? bot;
    } catch (error) {
      let rollbackError: unknown;
      try {
        await this.#deleteBotData(bot);
      } catch (caught) {
        rollbackError = caught;
      }
      this.#emit({ type: "bots-changed", bots: this.listBots() });
      if (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Agent setup failed and the incomplete agent could not be removed.",
        );
      }
      throw error;
    }
  }

  async createBotProfile(input: Omit<CreateBotInput, "initialMessage"> & { title?: string }): Promise<BotSummary> {
    let bot = await this.#store.createBot(input);
    try {
      await this.#prepareBotWorkspace(bot);
      if (input.title) bot = await this.#store.updateBot({ botId: bot.id, title: input.title });
      this.#emit({ type: "bots-changed", bots: this.listBots() });
      return bot;
    } catch (error) {
      await this.#deleteBotData(bot);
      throw error;
    }
  }

  committedBotDuplication(operationId: string, sourceBotId: string): DuplicateBotResult | null {
    return this.#store.committedBotDuplication(operationId, sourceBotId);
  }

  duplicateBot(sourceBotId: string, operationId: string = randomUUID()): Promise<BotSummary> {
    return this.#duplication.duplicate(sourceBotId, operationId);
  }

  commitBotDuplication(botId: string, layout: SidebarLayoutSnapshot): Promise<DuplicateBotResult> {
    return this.#duplication.commit(botId, layout);
  }

  setMarketplaceSource(botId: string, source: NonNullable<BotSummary["marketplaceSource"]>): BotSummary {
    const bot = this.#store.setMarketplaceSource(botId, source);
    this.#emit({ type: "bots-changed", bots: this.listBots() });
    return bot;
  }

  async updateBot(input: UpdateBotInput): Promise<BotSummary> {
    this.#conversation.requireKnownBot(input.botId);
    const previous = this.#store.list().find((bot) => bot.id === input.botId);
    const requestedModel = input.model
      ? this.#providers
          .listModels()
          .find((model) => model.id === input.model && (!input.provider || model.provider === input.provider))
      : undefined;
    if (input.model && !requestedModel) throw new Error("The selected agent model is unavailable.");
    const requestedProvider = input.provider ?? requestedModel?.provider ?? previous?.provider;
    if (input.provider && requestedModel && requestedModel.provider !== input.provider) {
      throw new Error("The selected model does not belong to that provider.");
    }
    if (requestedProvider && previous && requestedProvider !== providerForBot(previous)) {
      if (!input.model || !input.provider) {
        throw new Error("Changing provider requires an atomic provider and model selection.");
      }
      const hasPendingWork = this.#mailbox
        .listQueue(input.botId)
        .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status));
      const activeTurn =
        this.#conversation.snapshot(input.botId)?.activeTurnId ??
        (previous.threadId ? this.#store.database.readConversation(input.botId, previous.threadId).activeTurnId : null);
      if (hasPendingWork || activeTurn) {
        throw new Error("Wait for the active turn and queue to finish before changing provider.");
      }
      await this.ensureProvider(requestedProvider);
    }
    const profileChanged =
      input.name !== undefined ||
      input.title !== undefined ||
      input.description !== undefined ||
      input.model !== undefined ||
      input.reasoningEffort !== undefined;
    const bot = await this.#store.updateBot({
      ...input,
      ...(requestedModel && !input.provider ? { provider: requestedModel.provider } : {}),
    });
    const activeSession = this.#store.activeProviderSession(bot.id);
    if (previous?.threadId && requestedProvider && requestedProvider !== providerForBot(previous)) {
      this.#store.database.deactivateProviderSessions(previous.threadId);
    } else if (activeSession && (input.model || input.reasoningEffort)) {
      this.#store.database.updateProviderSessionConfig(
        activeSession.id,
        activeSession.threadId,
        bot.model,
        bot.reasoningEffort,
      );
    }
    if (profileChanged && activeSession) {
      // Re-resume before the next turn so App Server receives the updated standing instructions.
      this.#conversation.unloadThread(activeSession.externalSessionId);
    }
    this.#emit({ type: "bots-changed", bots: this.listBots() });
    return bot;
  }

  async setAvatar(botId: string, image: AvatarImageInput | null): Promise<BotSummary> {
    const bot = await this.#store.setAvatar(botId, image);
    this.#emit({ type: "bots-changed", bots: this.listBots() });
    return bot;
  }

  refreshBotRuntime(botId: string): void {
    this.#threads.refreshBotRuntime(botId);
  }

  resolveAvatar(botId: string): { path: string; mimeType: AvatarImageInput["mimeType"]; version: string } | null {
    return this.#store.resolveAvatar(botId);
  }

  async resolveSharedFile(inputPath: string): Promise<ResolvedSharedFile> {
    const sharedRoot = await realpath(this.#store.sharedRoot);
    const candidatePath = sharedPathFromInput(this.#store.sharedRoot, inputPath);
    const resolvedPath = await realpath(candidatePath);
    if (!isWithin(sharedRoot, resolvedPath)) {
      throw new Error("Shared file must be inside the shared directory.");
    }
    const metadata = await stat(resolvedPath);
    if (!metadata.isFile()) throw new Error("Shared path is not a file.");
    return { path: resolvedPath, name: basename(resolvedPath), size: metadata.size };
  }

  async resolveWorkspaceFile(botId: string, inputPath: string): Promise<ResolvedSharedFile> {
    const bot = this.#store.list().find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Unknown agent: ${botId}`);
    const workspaceRoot = await realpath(bot.workspacePath);
    const candidatePath = workspacePathFromInput(bot.workspacePath, bot.id, inputPath);
    const resolvedPath = await realpath(candidatePath);
    if (!isWithin(workspaceRoot, resolvedPath)) {
      throw new Error("Workspace file must be inside the agent workspace.");
    }
    const metadata = await stat(resolvedPath);
    if (!metadata.isFile()) throw new Error("Workspace path is not a file.");
    return { path: resolvedPath, name: basename(resolvedPath), size: metadata.size };
  }

  async deleteBot(botId: string): Promise<void> {
    const bot = this.#store.list().find((candidate) => candidate.id === botId);
    if (!bot) throw new Error(`Unknown agent: ${botId}`);
    const hasPendingWork = this.#mailbox
      .listQueue(botId)
      .deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status));
    if (hasPendingWork || this.#conversation.snapshot(botId)?.activeTurnId) {
      throw new Error("Stop the agent and cancel its queued messages before deleting it.");
    }

    const { wasPending, release } = this.#duplication.releaseForDelete(botId);
    try {
      await this.#deleteBotData(bot);
    } finally {
      release();
    }
    this.#duplication.forget(botId);
    if (!wasPending) this.#emit({ type: "bots-changed", bots: this.listBots() });
    this.#routines.arm();
  }

  async #deleteBotData(bot: BotSummary): Promise<void> {
    const providerSessions = bot.threadId ? this.#store.database.listProviderSessions(bot.threadId) : [];
    const errors: unknown[] = [];
    try {
      await this.#mailbox.deleteBotData(bot.id);
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#store.deleteBot(bot.id);
    } catch (error) {
      errors.push(error);
    }
    this.#conversation.forgetBot(bot.id);
    this.#turn.forgetBot(bot.id);
    this.#drain.forgetBot(bot.id);
    this.#hostedSites.forgetBot(bot.id);
    if (bot.threadId) {
      for (const session of providerSessions) {
        this.#conversation.unbindThread(session.externalSessionId);
        this.#conversation.unloadThread(session.externalSessionId);
        this.#compaction.forgetThread(session.externalSessionId);
      }
    }
    this.#compaction.forgetBot(bot.id);
    if (errors.length > 0) throw new AggregateError(errors, "The agent data could not be removed completely.");
  }

  async initialize(): Promise<void> {
    this.#stopping = false;
    await this.#store.initialize();
    await this.#mailbox.initialize();
    this.#boot.recoverPersistedTurns();
    this.#hostedSites.restore();
    this.#routines.skipMissed(new Date());
    this.#initialized = true;
    await this.#providers.start();
    for (const bot of this.#store.list()) this.#mailboxSync.emitQueue(bot.id);
    await this.#routines.resumePendingRuns();
    this.#routines.arm();
  }

  setPreferredProvider(provider: AgentProvider): Promise<void> {
    return this.#providers.setPreferredProvider(provider, this.#initialized);
  }

  ensureProvider(provider: AgentProvider): Promise<void> {
    return this.#providers.ensureProvider(provider);
  }

  refreshProviders(): Promise<AgentStatus> {
    return this.#providers.refreshProviders();
  }

  refreshProvider(provider: AgentProvider): Promise<AgentStatus> {
    return this.#providers.refreshProvider(provider);
  }

  connectChatGPT(openExternal: (url: string) => Promise<void>): Promise<AgentStatus> {
    return this.#providers.connectChatGPT(openExternal);
  }

  connectClaude(): Promise<AgentStatus> {
    return this.#providers.connectClaude();
  }

  connectGrok(): Promise<AgentStatus> {
    return this.#providers.connectGrok();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#initialized = false;
    this.#routines.dispose();
    this.#hostedSites.dispose();
    this.#compaction.dispose();
    this.#deltas.dispose();
    this.#threads.dispose();
    this.#memories.clearPending();
    this.#attention.clearPrompts();
    this.#attention.clearBrowserTakeovers();
    this.#attention.clearApprovals();
    const clients = this.#providers.dispose();
    for (const [botId, snapshot] of this.#conversation.activeSnapshots()) {
      if (!snapshot.activeTurnId) continue;
      const session = this.#store.activeProviderSession(botId);
      if (session) this.#images.interrupt(botId, session.externalSessionId, snapshot.activeTurnId);
    }
    this.#turn.dispose();
    this.#drain.dispose();
    this.#browser.clearControls();
    await Promise.all(clients.map((client) => client.stop().catch(() => undefined)));
    await Promise.allSettled(this.#drain.pendingTasks());
    await Promise.allSettled(this.#images.pendingPromises());
    this.#images.dispose();
    await Promise.allSettled(this.#attachments.pendingCommands());
    this.#attachments.dispose();
    this.#providers.markStopped();
  }

  async readConversation(botId: string): Promise<ConversationSnapshot> {
    const bot = await this.#store.getOrCreate(botId);
    const persisted = this.#store.database.readConversation(botId, bot.threadId);
    const live = this.#conversation.snapshot(botId);
    const snapshot = live?.activeTurnId ? mergeConversationSnapshots(persisted, live) : persisted;
    this.#mailboxSync.syncMailboxMessages(snapshot);
    this.#conversation.setSnapshot(botId, snapshot);
    return structuredClone(snapshot);
  }

  async readConversationFor(botId: string, memberId: string): Promise<ConversationWithReadState> {
    const snapshot = await this.readConversation(botId);
    return {
      ...snapshot,
      readState: this.#conversationReads.readState(memberId, snapshot),
    };
  }

  async readConversationPageFor(
    botId: string,
    memberId: string,
    anchor: ConversationPageAnchor = { type: "latest" },
    limit = 50,
    options: ConversationMarkerExclusions = {},
  ): Promise<ConversationPage> {
    const bot = await this.#store.getOrCreate(botId);
    this.#mailboxSync.reconcilePersistedMailboxMessages(bot);
    const page = this.#store.database.readConversationPage(botId, bot.threadId, anchor, limit, options);
    return {
      ...page,
      readState: this.#conversationReads.readStateForThread(memberId, bot.threadId, options),
    };
  }

  searchConversationMessages(query: string, botId?: string, cursor?: string, limit = 100): ConversationSearchPage {
    return this.#store.database.searchConversationMessages(query, botId, cursor, limit);
  }

  listConversationReads(
    memberId: string,
    options: ConversationMarkerExclusions = {},
  ): Record<string, ConversationReadState> {
    return this.#conversationReads.listStates(memberId, this.listBots(), options);
  }

  adoptConversationReads(sourceMemberId: string, targetMemberId: string): void {
    this.#conversationReads.adoptMemberState(sourceMemberId, targetMemberId);
  }

  async markConversationRead(
    botId: string,
    memberId: string,
    throughMessageId: string | null,
    options: ConversationMarkerExclusions = {},
  ): Promise<ConversationReadState> {
    const snapshot = await this.readConversation(botId);
    const previous = this.#conversationReads.readState(memberId, snapshot).throughMessageId;
    const state = this.#conversationReads.markRead(memberId, snapshot, throughMessageId, options);
    if (this.#conversationReads.readState(memberId, snapshot).throughMessageId !== previous) {
      // Read cursors are shared by a member's devices, not by every team member.
      // Invalidate without broadcasting a reader's cursor; each client reloads its own state.
      this.#emit({ type: "conversation-invalidated", botId, revision: snapshot.revision });
    }
    return state;
  }

  async markConversationUnread(botId: string, memberId: string): Promise<ConversationReadState> {
    const snapshot = await this.readConversation(botId);
    const state = this.#conversationReads.markUnread(memberId, snapshot);
    this.#emit({ type: "conversation-invalidated", botId, revision: snapshot.revision });
    return state;
  }

  prepareAttachments(paths: string[]): Promise<DraftAttachment[]> {
    return this.#mailbox.prepareAttachments(paths);
  }

  prepareImportedAttachments(paths: string[], data: AttachmentDataInput[]): Promise<DraftAttachment[]> {
    return this.#mailbox.prepareImportedAttachments(paths, data);
  }

  discardDraftAttachment(id: string): Promise<void> {
    return this.#mailbox.discardDraft(id);
  }

  listQueue(botId: string): QueueSnapshot {
    return this.#mailbox.listQueue(botId);
  }

  acknowledgeFailedTurn(botId: string, turnId: string): void {
    this.#turn.acknowledgeFailedTurn(botId, turnId);
  }

  async cancelQueuedMessage(botId: string, deliveryId: string): Promise<void> {
    await this.#mailbox.cancel(botId, deliveryId);
    this.#mailboxSync.emitQueue(botId);
  }

  async updateQueuedMessage(input: UpdateQueuedMessageInput): Promise<void> {
    await this.#mailbox.updateQueuedMessage(
      input.botId,
      input.deliveryId,
      input.text,
      input.keepAttachmentIds,
      input.attachmentDraftIds,
    );
    const snapshot = this.#conversation.snapshot(input.botId);
    if (snapshot) this.#mailboxSync.syncMailboxMessages(snapshot);
    this.#mailboxSync.emitQueue(input.botId);
    if (snapshot) this.#conversation.emitConversation(snapshot, "queue.message-updated");
  }

  async reorderQueue(input: ReorderQueueInput): Promise<void> {
    await this.#mailbox.reorderQueue(input.botId, input.deliveryIds);
    this.#mailboxSync.emitQueue(input.botId);
  }

  async steerQueuedMessage(input: SteerQueuedMessageInput): Promise<void> {
    const bot = await this.#store.getOrCreate(input.botId);
    const client = this.#providers.requireReadyClient(providerForBot(bot));
    const session = this.#store.activeProviderSession(bot.id);
    const snapshot = this.#conversation.ensureSnapshot(bot.id, bot.threadId);
    if (!session || !snapshot.activeTurnId || snapshot.activeTurnId !== input.expectedTurnId) {
      throw new Error("The active turn changed before this message could be steered.");
    }
    const context = this.#mailbox.getDelivery(input.deliveryId);
    if (!context || context.delivery.recipientBotId !== bot.id || context.delivery.status !== "queued") {
      throw new Error("Only queued messages can be steered.");
    }

    const turnId = snapshot.activeTurnId;
    await this.#mailbox.markSteering(input.deliveryId, turnId);
    this.#mailboxSync.emitQueue(bot.id);
    try {
      await client.request(
        "turn/steer",
        {
          threadId: session.externalSessionId,
          expectedTurnId: turnId,
          clientUserMessageId: input.deliveryId,
          input: deliveryInput(context, agentNamesById(this.#store.list())),
        },
        decodeRecordResponse,
      );
      await this.#mailbox.markRunning(input.deliveryId, turnId);
      this.#mailboxSync.syncMailboxMessages(snapshot);
      this.#mailboxSync.emitQueue(bot.id);
      this.#conversation.emitConversation(snapshot, "queue.message-steered", { deliveryId: input.deliveryId });
    } catch (error) {
      await this.#mailbox.restoreQueued(input.deliveryId);
      this.#mailboxSync.emitQueue(bot.id);
      throw error;
    }
  }

  async sendMessage(input: SendMessageInput): Promise<QueuedMessageReceipt> {
    if (this.#duplication.isPending(input.botId)) throw new Error(`Unknown agent: ${input.botId}`);
    const bot = await this.#store.getOrCreate(input.botId);
    await this.ensureProvider(providerForBot(bot));
    const receipt = await this.#mailbox.enqueue({
      sender: { kind: "user" },
      recipientBotIds: [bot.id],
      text: input.text,
      draftIds: input.attachmentDraftIds ?? [],
      replyToMessageId: input.replyToMessageId ?? null,
    });
    const delivery = this.#mailbox.getDelivery(receipt.deliveries[0].id);
    if (!delivery) throw new Error("Unable to create queued message.");
    const snapshot = this.#conversation.ensureSnapshot(bot.id, bot.threadId);
    this.#mailboxSync.syncMailboxMessages(snapshot);
    await this.#store.updatePreview(
      bot.id,
      displayMessageReferences(
        delivery.delivery.text,
        delivery.delivery.attachments,
        agentNamesById(this.#store.list()),
      ) || delivery.delivery.attachments.map((item) => item.name).join(", "),
    );
    this.#emit({ type: "bots-changed", bots: this.listBots() });
    this.#conversation.emitConversation(snapshot);
    this.#mailboxSync.emitQueue(bot.id);
    this.#drain.scheduleDrain(bot.id);
    return receipt;
  }

  async setMessageReaction(input: SetMessageReactionInput): Promise<void> {
    const bot = await this.#store.getOrCreate(input.botId);
    const snapshot = this.#conversation.ensureSnapshot(bot.id, bot.threadId);
    if (!snapshot.messages.some((message) => message.id === input.messageId)) {
      await this.readConversation(bot.id);
    }
    const current = this.#conversation.ensureSnapshot(bot.id, bot.threadId);
    if (!current.messages.some((message) => message.id === input.messageId)) {
      throw new Error("The message is no longer available.");
    }
    await this.#mailbox.setReaction(bot.id, input.messageId, { kind: "user" }, input.emoji);
    this.#mailboxSync.syncMailboxMessages(current);
    this.#conversation.emitConversation(current);
  }

  async interrupt(botId: string, turnId: string): Promise<void> {
    const bot = await this.#store.getOrCreate(botId);
    const client = this.#providers.requireReadyClient(providerForBot(bot));
    const session = this.#store.activeProviderSession(botId);
    if (!session) return;
    this.#images.interrupt(botId, session.externalSessionId, turnId);
    await client.request("turn/interrupt", { threadId: session.externalSessionId, turnId }, decodeRecordResponse);
  }

  async interruptAll(): Promise<void> {
    if (!this.#providers.isReady()) return;
    const requests: Promise<unknown>[] = [];
    for (const [botId, snapshot] of this.#conversation.activeSnapshots()) {
      if (!snapshot.threadId || !snapshot.activeTurnId) continue;
      const bot = this.#store.list().find((candidate) => candidate.id === botId);
      const client = bot ? this.#providers.clientForBot(bot) : null;
      const session = bot ? this.#store.activeProviderSession(bot.id) : null;
      if (!client || !session) continue;
      this.#images.interrupt(botId, session.externalSessionId, snapshot.activeTurnId);
      requests.push(
        client
          .request(
            "turn/interrupt",
            {
              threadId: session.externalSessionId,
              turnId: snapshot.activeTurnId,
            },
            decodeRecordResponse,
          )
          .catch((error) => this.#emitError("interrupt_failed", error, botId)),
      );
    }
    await Promise.all(requests);
  }

  async respondToPrompt(input: RespondToPromptInput): Promise<void> {
    await this.#attention.respondToPrompt(input);
  }

  async respondToApproval(input: RespondToApprovalInput): Promise<void> {
    await this.#attention.respondToApproval(input);
  }

  async respondToBrowserTakeover(input: RespondToBrowserTakeoverInput): Promise<void> {
    await this.#attention.respondToBrowserTakeover(input);
  }

  async #handleServerRequest(client: AgentClient, request: AppServerRequest): Promise<void> {
    try {
      switch (request.method) {
        case "item/commandExecution/requestApproval":
          this.#attention.surfaceApproval(client, request, "command");
          return;
        case "item/fileChange/requestApproval":
          this.#attention.surfaceApproval(client, request, "file-change");
          return;
        case "item/permissions/requestApproval":
          this.#attention.surfaceApproval(client, request, "permissions");
          return;
        case "applyPatchApproval":
        case "execCommandApproval":
          this.#attention.surfaceLegacyApproval(client, request);
          return;
        case "item/tool/call": {
          if (!isDynamicToolCall(request.params)) throw new Error("Invalid dynamic tool request.");
          if (request.params.namespace === OPENBOT_BROWSER_NAMESPACE) {
            const botId = this.#conversation.botForThread(request.params.threadId);
            if (!botId) throw new Error("The browsing OpenBot agent is unknown.");
            if (request.params.tool === "request_takeover") {
              client.respond(request.id, await this.#attention.surfaceBrowserTakeover(request));
              return;
            }
            client.respond(
              request.id,
              await this.#browser.handleDynamicTool({
                ...request.params,
                threadId: this.#conversation.publicThreadId(botId, request.params.threadId),
                ownerBotId: botId,
              }),
            );
            return;
          }
          if (request.params.namespace === "openbot") {
            if (request.params.tool === "ask_user") {
              this.#attention.surfaceDynamicPrompt(client, request);
              return;
            }
            if (isHostedSiteMutationTool(request.params.tool)) {
              await this.#attention.surfaceHostedSiteApproval(client, request, request.params, request.params.tool);
              return;
            }
            client.respond(request.id, await this.#handleOpenBotTool(request.params));
            return;
          }
          throw new Error(`Unsupported dynamic tool namespace: ${request.params.namespace}`);
        }
        case "item/tool/requestUserInput":
          this.#attention.surfacePrompt(client, request);
          return;
        case "mcpServer/elicitation/request":
          this.#attention.surfaceMcpElicitation(client, request);
          return;
        case "currentTime/read":
          client.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
          return;
        default:
          client.respondError(request.id, {
            code: -32601,
            message: `OpenBot does not implement server request ${request.method}.`,
          });
      }
    } catch (error) {
      if (client.running) {
        try {
          client.respondError(request.id, { code: -32603, message: String(error) });
        } catch {
          // The process can exit between the running check and the write.
        }
      }
      this.#emitError("server_request_failed", error);
    }
  }

  async #handleOpenBotTool(params: DynamicToolCallParams): Promise<OpenBotToolResponse> {
    const senderBotId = this.#conversation.botForThread(params.threadId);
    if (!senderBotId) throw new Error("The sending OpenBot agent is unknown.");

    if (params.tool === "list_sites") {
      return openBotToolResult({ sites: await this.#hostedSites.listSites(), limit: 10 });
    }

    if (isHostedSiteMutationTool(params.tool)) throw new Error("Hosted site changes require user approval.");

    if (params.tool === "attach_files_to_response") {
      const args = params.arguments;
      if (!isRecord(args) || !Array.isArray(args.paths)) throw new Error("paths must be an array of local files.");
      if (
        args.paths.length === 0 ||
        args.paths.length > INPUT_LIMITS.attachments ||
        !args.paths.every((path) => isString(path) && path.trim().length > 0 && path.length <= INPUT_LIMITS.path)
      ) {
        throw new Error(`paths must contain between 1 and ${INPUT_LIMITS.attachments} valid local file paths.`);
      }

      const messageId = responseAttachmentMessageId(params.threadId, params.turnId, params.callId);
      return this.#attachments.attachFiles(senderBotId, params, args.paths, messageId);
    }

    if (params.tool === "list_agents") {
      const agents = this.listBots().map((bot) => {
        const queue = this.#mailbox.listQueue(bot.id);
        return {
          id: bot.id,
          name: bot.name,
          title: bot.title,
          description: bot.description,
          status: this.#conversation.snapshot(bot.id)?.activeTurnId
            ? "working"
            : queue.deliveries.some((delivery) => delivery.status === "queued")
              ? "queued"
              : "ready",
        };
      });
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify({ agents }) }],
      };
    }

    if (params.tool === "update_profile") {
      const args = params.arguments;
      if (!isRecord(args)) throw new Error("update_profile arguments are required.");
      const botId = args.botId;
      if (!isString(botId) || !botId.trim()) throw new Error("botId is required.");
      const profileFields = ["name", "title", "description"] as const;
      if (!profileFields.some((field) => args[field] !== undefined)) {
        throw new Error("At least one profile field is required.");
      }
      const input: UpdateBotInput = { botId };
      for (const field of profileFields) {
        const value = args[field];
        if (value !== undefined && !isString(value)) throw new Error(`${field} must be a string.`);
        if (value !== undefined) input[field] = value;
      }
      const updated = await this.updateBot(input);
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              id: updated.id,
              name: updated.name,
              title: updated.title,
              description: updated.description,
            }),
          },
        ],
      };
    }

    const routineResult = await this.#routines.handleTool(params, senderBotId);
    if (routineResult) return routineResult;

    const memoryResult = this.#memories.handleTool(params, senderBotId);
    if (memoryResult) return memoryResult;

    if (params.tool === "react_to_user_message") {
      const args = params.arguments;
      if (!isRecord(args) || !isMessageReaction(args.emoji)) {
        throw new Error("emoji must be exactly one complete Unicode emoji.");
      }
      const delivery = this.#mailbox
        .findDeliveriesByTurn(senderBotId, params.turnId)
        .find((candidate) => candidate.delivery.sender.kind === "user");
      if (!delivery) throw new Error("Only the current user message can receive an agent reaction.");
      await this.#mailbox.setReaction(
        senderBotId,
        delivery.delivery.id,
        { kind: "bot", botId: senderBotId },
        args.emoji,
      );
      const snapshot = this.#conversation.ensureSnapshot(senderBotId, params.threadId);
      this.#mailboxSync.syncMailboxMessages(snapshot);
      this.#conversation.emitConversation(snapshot);
      return openBotToolResult({ status: "reacted", messageId: delivery.delivery.id, emoji: args.emoji });
    }

    if (params.tool !== "send_message" || !isRecord(params.arguments)) {
      throw new Error(`Unsupported OpenBot tool: ${params.tool}`);
    }
    const recipientValues = params.arguments.recipientBotIds;
    if (!Array.isArray(recipientValues) || !recipientValues.every((item) => isString(item))) {
      throw new Error("recipientBotIds must be an array of bot ids.");
    }
    if (recipientValues.length !== new Set(recipientValues).size) {
      throw new Error("Duplicate recipients are not allowed.");
    }
    if (recipientValues.includes(senderBotId)) throw new Error("An agent cannot message itself.");
    const knownIds = new Set(this.listBots().map((bot) => bot.id));
    for (const recipient of recipientValues) {
      if (!knownIds.has(recipient)) throw new Error(`Unknown OpenBot agent: ${recipient}`);
    }
    const paths = params.arguments.paths ?? [];
    if (!Array.isArray(paths) || !paths.every((item) => isString(item))) {
      throw new Error("paths must be an array of local file paths.");
    }
    const replyToMessageId = params.arguments.replyToMessageId;
    if (replyToMessageId !== undefined && replyToMessageId !== null && !isString(replyToMessageId)) {
      throw new Error("replyToMessageId must be a message id.");
    }
    if (!isString(params.arguments.text)) throw new Error("text is required.");

    const receipt = await this.#mailbox.enqueue({
      sender: { kind: "bot", botId: senderBotId },
      recipientBotIds: recipientValues,
      text: params.arguments.text,
      sourcePaths: paths,
      replyToMessageId: replyToMessageId ?? null,
      idempotencyKey: `${params.threadId}:${params.turnId}:${params.callId}`,
    });
    for (const recipient of recipientValues) {
      this.#mailboxSync.emitQueue(recipient);
      this.#drain.scheduleDrain(recipient);
    }
    const snapshot = this.#conversation.ensureSnapshot(senderBotId, params.threadId);
    this.#mailboxSync.syncMailboxMessages(snapshot);
    this.#conversation.emitConversation(snapshot);
    return {
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify(receipt) }],
    };
  }

  #emitError(code: string, error: unknown, botId?: string): void {
    this.#emit({
      type: "error",
      botId,
      code,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  #emitRuntimeSnapshot(): void {
    this.#emit({ type: "runtime-snapshot", snapshot: this.getRuntimeSnapshot() });
  }

  #emit(event: AgentEvent): void {
    this.emit("event", event);
  }
}
