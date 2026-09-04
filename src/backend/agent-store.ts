import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { avatarFileExtension, isAvatarMimeType, isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  AGENT_PROVIDERS,
  type AgentModelId,
  type AgentProviderId,
  type AgentReasoningEffort,
  type AvatarImageInput,
  type BotSummary,
  type CreateBotInput,
  type DuplicateBotResult,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isReasoningEffort,
  isSidebarLayoutSnapshot,
  providerForLegacyModel,
  type SidebarLayoutSnapshot,
  type UpdateBotInput,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { isUuidV4 } from "@openbot/contracts/validation";
import { OpenBotDatabase, type ProviderSession, stableThreadId } from "./openbot-database";
import { isRecord } from "./protocol";

type StoredBot = BotSummary;
type PersistedStoredBot = Omit<StoredBot, "avatarUrl" | "provider"> & {
  avatarUrl?: string | null;
  provider?: AgentProviderId;
};
type StoredBotBase = Omit<PersistedStoredBot, "avatarSeed" | "avatarHue"> & DynamicRecord;

interface BotDuplicationMarker {
  operationId: string;
  sourceBotId: string;
}

interface StoredState {
  version: 2;
  examplesInitialized: boolean;
  bots: StoredBot[];
}

type LegacyStoredBot = Omit<PersistedStoredBot, "avatarSeed" | "avatarHue"> & {
  avatarShape: string;
  avatarColor: string;
};

const LEGACY_AVATAR_VARIANTS = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop"] as const;
const LEGACY_AVATAR_COLORS = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
] as const;

export const DEFAULT_AGENT_MODEL: AgentModelId = "gpt-5.6-luna";
export const DEFAULT_AGENT_PROVIDER: AgentProviderId = "codex";
export const DEFAULT_REASONING_EFFORT: AgentReasoningEffort = "medium";

// These two strings are history, not vocabulary. The first is the file a release before the move to
// SQLite wrote its state into, and is only ever read: renaming it means that file is never found and the
// data of anyone who has not yet run the importing release is lost. The second is a `command_id` already
// stamped into `orchestration_command_receipts` on every existing install, and is what stops the legacy
// import running a second time. Neither follows the bot-to-agent rename.
const LEGACY_AGENTS_STATE_FILE = "bots.json";
const LEGACY_AGENTS_IMPORT_COMMAND_ID = "legacy-import:bots:v1";

export class BotStore {
  readonly #statePath: string;
  readonly #botsRoot: string;
  readonly #sharedRoot: string;
  readonly #downloadsRoot: string;
  readonly #avatarsRoot: string;
  readonly #duplicationsRoot: string;
  readonly #database: OpenBotDatabase;
  #state: StoredState = { version: 2, examplesInitialized: false, bots: [] };
  #avatarUpdateQueue: Promise<void> = Promise.resolve();
  #creationQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, homePath: string, database = new OpenBotDatabase(userDataPath)) {
    const openbotRoot = join(homePath, "OpenBot");
    this.#statePath = join(userDataPath, LEGACY_AGENTS_STATE_FILE);
    this.#botsRoot = join(openbotRoot, "Bots");
    this.#sharedRoot = join(openbotRoot, "Shared");
    this.#downloadsRoot = join(openbotRoot, "Downloads");
    this.#avatarsRoot = join(userDataPath, "avatars", "agents");
    this.#duplicationsRoot = join(userDataPath, "agent-duplications");
    this.#database = database;
  }

  get database(): OpenBotDatabase {
    return this.#database;
  }

  get sharedRoot(): string {
    return this.#sharedRoot;
  }

  get downloadsRoot(): string {
    return this.#downloadsRoot;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#botsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#sharedRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#downloadsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#avatarsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#duplicationsRoot, { recursive: true, mode: 0o700 }),
      mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 }),
    ]);

    await this.#database.initialize();
    const persisted = this.#database.listAgents();
    if (persisted.length > 0 || this.#database.hasAggregateEvents("agents", "agents")) {
      if (!persisted.every(isStoredBot)) {
        throw new Error("Stored agent profiles use the old role field; update the data before starting OpenBot.");
      }
      this.#state = {
        version: 2,
        examplesInitialized: true,
        bots: persisted.map(normalizeStoredBot),
      };
    } else {
      const legacy = await this.#readState();
      await this.#database.backupLegacyFile(this.#statePath);
      const sessions: Array<{ bot: StoredBot; externalSessionId: string }> = [];
      legacy.bots = legacy.bots.map((bot) => {
        if (!bot.threadId) return bot;
        sessions.push({ bot, externalSessionId: bot.threadId });
        return { ...bot, threadId: stableThreadId(bot.id) };
      });
      legacy.examplesInitialized = true;
      this.#state = legacy;
      this.#database.replaceAgents(LEGACY_AGENTS_IMPORT_COMMAND_ID, legacy.bots, "agents.legacy-imported");
      for (const { bot, externalSessionId } of sessions) {
        this.#database.bindProviderSession({
          threadId: stableThreadId(bot.id),
          provider: bot.provider,
          externalSessionId,
          model: bot.model,
          effort: bot.reasoningEffort,
        });
      }
    }
    await this.#recoverPendingDuplications();
  }

  list(): BotSummary[] {
    return this.#state.bots.map((bot) => ({ ...bot }));
  }

  createBot(input: Omit<CreateBotInput, "initialMessage">): Promise<BotSummary> {
    return this.#enqueueCreation(() => this.#createBot(input));
  }

  async #createBot(input: Omit<CreateBotInput, "initialMessage">): Promise<BotSummary> {
    if (this.#state.bots.length >= INPUT_LIMITS.agents) {
      throw new Error(`A host can have up to ${INPUT_LIMITS.agents} agents.`);
    }
    const name = requiredText(input.name, "Agent name", INPUT_LIMITS.agentName);
    const description = requiredText(input.description, "Agent description", INPUT_LIMITS.agentDescription);
    if (!isAvatarSeed(input.avatarSeed)) throw new Error("Invalid avatar seed.");
    if (input.avatarHue !== null && !isAvatarHue(input.avatarHue)) throw new Error("Invalid avatar hue.");
    const record = this.#createRecord(`bot-${randomUUID()}`, name, "", description);
    record.avatarSeed = input.avatarSeed;
    record.avatarHue = input.avatarHue;
    await mkdir(record.workspacePath, { recursive: true, mode: 0o700 });
    this.#state.bots.unshift(record);
    try {
      this.#persist("agent.created");
    } catch (error) {
      this.#state.bots = this.#state.bots.filter((candidate) => candidate.id !== record.id);
      await rm(record.workspacePath, { recursive: true, force: true });
      throw error;
    }
    return { ...record };
  }

  duplicateBot(sourceId: string, operationId: string = randomUUID()): Promise<BotSummary> {
    if (!isUuidV4(operationId)) throw new Error("Invalid agent duplication operation id.");
    return this.#enqueueCreation(() => this.#duplicateBot(sourceId, operationId));
  }

  #enqueueCreation<T>(create: () => Promise<T>): Promise<T> {
    const operation = this.#creationQueue.then(create);
    this.#creationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #duplicateBot(sourceId: string, operationId: string): Promise<BotSummary> {
    if (this.#database.commandResult(duplicationCommandId(operationId)) !== undefined) {
      throw new Error("This agent duplication operation is already committed.");
    }
    if (this.#state.bots.length >= INPUT_LIMITS.agents) {
      throw new Error(`A host can have up to ${INPUT_LIMITS.agents} agents.`);
    }
    const source = this.#requireBot(sourceId);
    const sourceProfileSignature = duplicationProfileSignature(source);
    const sourceWorkspaceManifest = await workspaceMetadataFingerprint(source.workspacePath);
    const sourceAvatar = this.resolveAvatar(source.id);
    const sourceAvatarSignature = sourceAvatar ? await fileFingerprint(sourceAvatar.path) : null;
    const id = `bot-${randomUUID()}`;
    const record = this.#createRecord(
      id,
      duplicateBotName(source.name, this.#state.bots),
      source.title,
      source.description,
    );
    record.notifications = source.notifications;
    record.provider = source.provider;
    record.model = source.model;
    record.reasoningEffort = source.reasoningEffort;
    record.avatarSeed = source.avatarSeed;
    record.avatarHue = source.avatarHue;

    const stagedWorkspace = `${record.workspacePath}.openbot-stage`;
    const avatarDirectory = join(this.#avatarsRoot, record.id);
    const stagedAvatarDirectory = `${avatarDirectory}.openbot-stage`;
    const duplicationMarker = this.#duplicationMarkerPath(record.id);
    let stagedAvatarPath: string | null = null;
    try {
      await writeFile(duplicationMarker, `${JSON.stringify({ operationId, sourceBotId: sourceId })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await cp(source.workspacePath, stagedWorkspace, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
      if (sourceAvatar) {
        await mkdir(stagedAvatarDirectory, { recursive: true, mode: 0o700 });
        const extension = avatarFileExtension(sourceAvatar.mimeType);
        stagedAvatarPath = join(stagedAvatarDirectory, `${sourceAvatar.version}.${extension}`);
        await copyFile(sourceAvatar.path, stagedAvatarPath);
        record.avatarUrl = agentAvatarUrl(record.id, sourceAvatar.version, sourceAvatar.mimeType);
      }
      if (
        duplicationProfileSignature(source) !== sourceProfileSignature ||
        (await workspaceMetadataFingerprint(source.workspacePath)) !== sourceWorkspaceManifest ||
        (stagedAvatarPath ? await fileFingerprint(stagedAvatarPath) : null) !== sourceAvatarSignature ||
        (sourceAvatar ? await fileFingerprint(sourceAvatar.path) : null) !== sourceAvatarSignature
      ) {
        throw new Error("The agent changed while it was being duplicated. Try again.");
      }
      await rewriteInternalWorkspaceSymlinks(source.workspacePath, stagedWorkspace, record.workspacePath);
      if (this.#state.bots.length >= INPUT_LIMITS.agents) {
        throw new Error(`A host can have up to ${INPUT_LIMITS.agents} agents.`);
      }
      record.name = duplicateBotName(source.name, this.#state.bots);
      await rename(stagedWorkspace, record.workspacePath);
      if (sourceAvatar) await rename(stagedAvatarDirectory, avatarDirectory);
      this.#state.bots.unshift(record);
      try {
        this.#persist("agent.duplicated");
      } catch (error) {
        this.#state.bots = this.#state.bots.filter((candidate) => candidate.id !== record.id);
        throw error;
      }
      return { ...record };
    } catch (error) {
      await Promise.all([
        rm(stagedWorkspace, { recursive: true, force: true }),
        rm(record.workspacePath, { recursive: true, force: true }),
        rm(stagedAvatarDirectory, { recursive: true, force: true }),
        rm(avatarDirectory, { recursive: true, force: true }),
        rm(duplicationMarker, { force: true }),
      ]);
      throw error;
    }
  }

  committedBotDuplication(operationId: string, sourceBotId: string): DuplicateBotResult | null {
    if (!isUuidV4(operationId)) throw new Error("Invalid agent duplication operation id.");
    const value = this.#database.commandResult(duplicationCommandId(operationId));
    if (value === undefined) return null;
    const result = isRecord(value) ? value.result : null;
    const resultBot = isRecord(result) ? result.bot : null;
    const resultLayout = isRecord(result) ? result.layout : null;
    if (
      !isRecord(value) ||
      value.sourceBotId !== sourceBotId ||
      !isRecord(result) ||
      !isStoredBot(resultBot) ||
      !isSidebarLayoutSnapshot(resultLayout)
    ) {
      throw new Error("The agent duplication receipt is invalid.");
    }
    const bot = this.#state.bots.find((candidate) => candidate.id === resultBot.id);
    if (!bot) throw new Error("The duplicated agent no longer exists.");
    return {
      bot: { ...bot },
      layout: structuredClone(resultLayout),
    };
  }

  async commitBotDuplication(
    id: string,
    operationId: string,
    sourceBotId: string,
    layout: SidebarLayoutSnapshot,
  ): Promise<DuplicateBotResult> {
    const bot = this.#requireBot(id);
    const marker = await this.#readDuplicationMarker(id);
    if (!marker || marker.operationId !== operationId || marker.sourceBotId !== sourceBotId) {
      throw new Error("This agent duplication marker is invalid.");
    }
    const result = { bot: { ...bot }, layout: structuredClone(layout) };
    const receipt = this.#database.dispatch(
      duplicationCommandId(operationId),
      [
        {
          aggregateType: "agent-duplications",
          aggregateId: id,
          eventType: "agent-duplication.committed",
          payload: { sourceBotId, duplicateBotId: id },
        },
      ],
      () => ({ sourceBotId, result }),
    );
    await rm(this.#duplicationMarkerPath(id), { force: true }).catch(() => undefined);
    if (
      !isRecord(receipt) ||
      !isRecord(receipt.result) ||
      !isStoredBot(receipt.result.bot) ||
      !isSidebarLayoutSnapshot(receipt.result.layout)
    ) {
      throw new Error("The agent duplication receipt is invalid.");
    }
    return {
      bot: { ...normalizeStoredBot(receipt.result.bot) },
      layout: structuredClone(receipt.result.layout),
    };
  }

  async updateBot(input: UpdateBotInput): Promise<BotSummary> {
    const bot = this.#requireBot(input.botId);
    if (input.name !== undefined) {
      bot.name = requiredText(input.name, "Agent name", INPUT_LIMITS.agentName);
    }
    if (input.title !== undefined) {
      bot.title = limitedText(input.title, "Agent title", INPUT_LIMITS.agentTitle);
    }
    if (input.description !== undefined) {
      bot.description = limitedText(input.description, "Agent description", INPUT_LIMITS.agentDescription);
    }
    if (input.notifications !== undefined) bot.notifications = input.notifications;
    if (input.provider !== undefined) bot.provider = input.provider;
    if (input.model !== undefined) {
      bot.model = input.model;
    }
    if (input.reasoningEffort !== undefined) bot.reasoningEffort = input.reasoningEffort;
    if (input.avatarSeed !== undefined) bot.avatarSeed = input.avatarSeed;
    if (input.avatarHue !== undefined) bot.avatarHue = input.avatarHue;
    bot.updatedAt = new Date().toISOString();
    this.#persist("agent.updated");
    return { ...bot };
  }

  setMarketplaceSource(botId: string, source: NonNullable<BotSummary["marketplaceSource"]>): BotSummary {
    const bot = this.#requireBot(botId);
    bot.marketplaceSource = structuredClone(source);
    bot.updatedAt = new Date().toISOString();
    this.#persist("agent.marketplace-source-updated");
    return { ...bot, marketplaceSource: structuredClone(source) };
  }

  async setAvatar(botId: string, image: AvatarImageInput | null): Promise<BotSummary> {
    const operation = this.#avatarUpdateQueue.then(() => this.#setAvatar(botId, image));
    this.#avatarUpdateQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #setAvatar(botId: string, image: AvatarImageInput | null): Promise<BotSummary> {
    const bot = this.#requireBot(botId);
    const previous = this.resolveAvatar(botId);
    const previousAvatarUrl = bot.avatarUrl;
    const previousUpdatedAt = bot.updatedAt;
    if (image === null) {
      bot.avatarUrl = null;
      bot.updatedAt = new Date().toISOString();
      try {
        this.#persist("agent.avatar-removed");
      } catch (error) {
        bot.avatarUrl = previousAvatarUrl;
        bot.updatedAt = previousUpdatedAt;
        throw error;
      }
      if (previous) await rm(previous.path, { force: true }).catch(() => undefined);
      return { ...bot };
    }
    if (!isValidAvatarImage(image.mimeType, image.bytes)) {
      throw new Error("Choose a valid PNG, JPEG, or WebP image up to 512 KB.");
    }
    const version = randomUUID();
    const extension = avatarFileExtension(image.mimeType);
    const directory = join(this.#avatarsRoot, bot.id);
    const target = join(directory, `${version}.${extension}`);
    const temporary = `${target}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, image.bytes, { mode: 0o600 });
    await rename(temporary, target);
    bot.avatarUrl = agentAvatarUrl(bot.id, version, image.mimeType);
    bot.updatedAt = new Date().toISOString();
    try {
      this.#persist("agent.avatar-updated");
    } catch (error) {
      bot.avatarUrl = previousAvatarUrl;
      bot.updatedAt = previousUpdatedAt;
      await rm(target, { force: true });
      throw error;
    }
    if (previous) await rm(previous.path, { force: true }).catch(() => undefined);
    return { ...bot };
  }

  resolveAvatar(botId: string): { path: string; mimeType: AvatarImageInput["mimeType"]; version: string } | null {
    const bot = this.#requireBot(botId);
    if (!bot.avatarUrl) return null;
    const parsed = parseAgentAvatarUrl(bot.avatarUrl, bot.id);
    if (!parsed) return null;
    const extension = avatarFileExtension(parsed.mimeType);
    return {
      path: join(this.#avatarsRoot, bot.id, `${parsed.version}.${extension}`),
      mimeType: parsed.mimeType,
      version: parsed.version,
    };
  }

  async deleteBot(id: string): Promise<BotSummary> {
    const bot = this.#requireBot(id);
    this.#state.bots = this.#state.bots.filter((candidate) => candidate.id !== id);
    this.#database.hardDeleteAgent(`agents:hard-delete:${randomUUID()}`, id, bot.threadId, this.#state.bots);
    await Promise.all([
      rm(join(this.#avatarsRoot, id), { recursive: true, force: true }),
      rm(`${join(this.#avatarsRoot, id)}.openbot-stage`, { recursive: true, force: true }),
      rm(join(this.#botsRoot, id), { recursive: true, force: true }),
      rm(`${join(this.#botsRoot, id)}.openbot-stage`, { recursive: true, force: true }),
      rm(this.#duplicationMarkerPath(id), { force: true }),
    ]);
    return { ...bot };
  }

  async getOrCreate(id: string, name?: string, title?: string): Promise<BotSummary> {
    validateBotId(id);
    const existing = this.#state.bots.find((bot) => bot.id === id);
    if (existing) {
      await mkdir(existing.workspacePath, { recursive: true, mode: 0o700 });
      return { ...existing };
    }
    return this.#enqueueCreation(() => this.#getOrCreate(id, name, title));
  }

  async #getOrCreate(id: string, name?: string, title?: string): Promise<BotSummary> {
    validateBotId(id);
    const existing = this.#state.bots.find((bot) => bot.id === id);
    if (existing) {
      await mkdir(existing.workspacePath, { recursive: true, mode: 0o700 });
      return { ...existing };
    }
    if (this.#state.bots.length >= INPUT_LIMITS.agents) {
      throw new Error(`A host can have up to ${INPUT_LIMITS.agents} agents.`);
    }

    const record = this.#createRecord(id, name ?? titleFromId(id), title ?? "Local teammate");
    this.#state.bots.push(record);
    await mkdir(record.workspacePath, { recursive: true, mode: 0o700 });
    this.#persist("agent.created");
    return { ...record };
  }

  async #recoverPendingDuplications(): Promise<void> {
    const entries = await readdir(this.#duplicationsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".pending")) continue;
      const id = entry.name.slice(0, -".pending".length);
      if (!isGeneratedBotId(id)) continue;
      const bot = this.#state.bots.find((candidate) => candidate.id === id);
      const marker = await this.#readDuplicationMarker(id);
      if (bot && marker) {
        const committed = this.committedBotDuplication(marker.operationId, marker.sourceBotId);
        if (committed?.bot.id === id) {
          await rm(join(this.#duplicationsRoot, entry.name), { force: true });
          continue;
        }
      }
      if (bot) {
        this.#state.bots = this.#state.bots.filter((candidate) => candidate.id !== id);
        this.#database.hardDeleteAgent(`agents:duplicate-recovery:${randomUUID()}`, id, bot.threadId, this.#state.bots);
      }
      await Promise.all([
        rm(join(this.#botsRoot, id), { recursive: true, force: true }),
        rm(`${join(this.#botsRoot, id)}.openbot-stage`, { recursive: true, force: true }),
        rm(join(this.#avatarsRoot, id), { recursive: true, force: true }),
        rm(`${join(this.#avatarsRoot, id)}.openbot-stage`, { recursive: true, force: true }),
        rm(join(this.#duplicationsRoot, entry.name), { force: true }),
      ]);
    }
  }

  #duplicationMarkerPath(id: string): string {
    return join(this.#duplicationsRoot, `${id}.pending`);
  }

  async #readDuplicationMarker(id: string): Promise<BotDuplicationMarker | null> {
    try {
      const value = JSON.parse(await readFile(this.#duplicationMarkerPath(id), "utf8"));
      if (
        !isRecord(value) ||
        !isString(value.operationId) ||
        !isUuidV4(value.operationId) ||
        !isString(value.sourceBotId) ||
        !value.sourceBotId
      ) {
        return null;
      }
      return { operationId: value.operationId, sourceBotId: value.sourceBotId };
    } catch {
      return null;
    }
  }

  async ensureThreadId(id: string): Promise<string> {
    return this.ensureThreadIdNow(id);
  }

  ensureThreadIdNow(id: string): string {
    const bot = this.#requireBot(id);
    if (bot.threadId) return bot.threadId;
    bot.threadId = `openbot-thread-${randomUUID()}`;
    bot.updatedAt = new Date().toISOString();
    this.#persist("thread.created");
    return bot.threadId;
  }

  restoreThreadIdentity(id: string, threadId: string | null, updatedAt: string | null): void {
    const bot = this.#requireBot(id);
    bot.threadId = threadId;
    bot.updatedAt = updatedAt;
  }

  activeProviderSession(id: string): ProviderSession | null {
    const bot = this.#requireBot(id);
    if (!bot.threadId) return null;
    return this.#database.activeProviderSession(bot.threadId, bot.provider);
  }

  bindProviderSession(id: string, externalSessionId: string): ProviderSession {
    const bot = this.#requireBot(id);
    if (!bot.threadId) throw new Error(`Agent ${id} does not have an OpenBot thread.`);
    return this.#database.bindProviderSession({
      threadId: bot.threadId,
      provider: bot.provider,
      externalSessionId,
      model: bot.model,
      effort: bot.reasoningEffort,
    });
  }

  async updatePreview(id: string, preview: string): Promise<void> {
    const bot = this.#requireBot(id);
    bot.preview = preview.slice(0, 180);
    bot.updatedAt = new Date().toISOString();
    this.#persist("agent.preview-updated");
  }

  async #readState(): Promise<StoredState> {
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8"));
      if (!isRecord(parsed) || !isBoolean(parsed.examplesInitialized) || !Array.isArray(parsed.bots)) {
        throw new Error("Agent state is corrupt or from a newer OpenBot version; refusing to overwrite it.");
      }
      if (parsed.bots.some((bot) => isRecord(bot) && "role" in bot)) {
        throw new Error("Stored agent profiles use the old role field; update the data before starting OpenBot.");
      }

      let bots: StoredBot[];
      if (parsed.version === 1 && parsed.bots.every(isLegacyStoredBot)) {
        bots = parsed.bots.map(migrateLegacyBot);
      } else if (parsed.version === 2 && parsed.bots.every(isStoredBot)) {
        bots = parsed.bots.map(normalizeStoredBot);
      } else {
        throw new Error("Agent state is corrupt or from a newer OpenBot version; refusing to overwrite it.");
      }
      if (new Set(bots.map((bot) => bot.id)).size !== bots.length) {
        throw new Error("Agent state contains duplicate bot ids; refusing to overwrite it.");
      }
      return { version: 2, examplesInitialized: parsed.examplesInitialized, bots };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return { version: 2, examplesInitialized: false, bots: [] };
      }
      throw error;
    }
  }

  #persist(eventType: string): void {
    this.#database.replaceAgents(`agents:${eventType}:${randomUUID()}`, this.#state.bots, eventType);
  }

  #createRecord(id: string, name: string, title: string, description = ""): StoredBot {
    validateBotId(id);
    return {
      id,
      name,
      title,
      description,
      notifications: true,
      provider: DEFAULT_AGENT_PROVIDER,
      model: DEFAULT_AGENT_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      threadId: null,
      workspacePath: join(this.#botsRoot, id),
      preview: "No messages yet",
      updatedAt: null,
      avatarSeed: id,
      avatarHue: null,
      avatarUrl: null,
    };
  }

  #requireBot(id: string): StoredBot {
    const bot = this.#state.bots.find((candidate) => candidate.id === id);
    if (!bot) throw new Error(`Unknown bot: ${id}`);
    return bot;
  }
}

function requiredText(value: string, label: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > maxLength) throw new Error(`${label} is too long.`);
  return trimmed;
}

function limitedText(value: string, label: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${label} is too long.`);
  return trimmed;
}

function duplicateBotName(sourceName: string, bots: readonly StoredBot[]): string {
  const match = /^(.*?)(?: copy(?: (\d+))?)$/iu.exec(sourceName);
  const base = match?.[1]?.trim() || sourceName.trim();
  const existing = new Set(bots.map((bot) => bot.name.toLocaleLowerCase()));
  for (let index = 1; index <= INPUT_LIMITS.agents + 1; index += 1) {
    const suffix = index === 1 ? " copy" : ` copy ${index}`;
    const candidate = `${base.slice(0, Math.max(1, INPUT_LIMITS.agentName - suffix.length)).trimEnd()}${suffix}`;
    if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error("OpenBot could not create a unique agent copy name.");
}

/**
 * The part of an agent a copy is actually built from, which is what "the agent changed" has to mean.
 *
 * `preview`, `updatedAt` and `threadId` move on their own the moment a message lands, and a
 * duplicate takes none of the three — it gets a fresh thread and its own empty preview. Signing them
 * aborted duplications that were never incoherent, and copying a large workspace takes long enough
 * for an incoming message to land inside the window. Everything else is signed by omission, so a new
 * `BotSummary` field is guarded until someone decides otherwise here.
 */
export function duplicationProfileSignature(bot: BotSummary): string {
  const { preview, updatedAt, threadId, ...copied } = bot;
  return JSON.stringify(copied);
}

function duplicationCommandId(operationId: string): string {
  return `agent-duplication:${operationId}`;
}

async function rewriteInternalWorkspaceSymlinks(
  sourceRoot: string,
  stagedRoot: string,
  finalRoot: string,
): Promise<void> {
  const canonicalSourceRoot = await realpath(sourceRoot);
  const visit = async (stagedDirectory: string, sourceDirectory: string, finalDirectory: string): Promise<void> => {
    const entries = await readdir(stagedDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const stagedPath = join(stagedDirectory, entry.name);
      const sourcePath = join(sourceDirectory, entry.name);
      const finalPath = join(finalDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(stagedPath);
        const resolvedSourceTarget = resolve(dirname(sourcePath), target);
        let sourceRelativePath: string;
        try {
          const canonicalTarget = await realpath(resolvedSourceTarget);
          if (!isPathWithin(canonicalSourceRoot, canonicalTarget)) continue;
          sourceRelativePath = relative(canonicalSourceRoot, canonicalTarget);
        } catch {
          if (!isPathWithin(sourceRoot, resolvedSourceTarget)) continue;
          sourceRelativePath = relative(sourceRoot, resolvedSourceTarget);
        }
        const finalTarget = join(finalRoot, sourceRelativePath);
        const rewrittenTarget = isAbsolute(target) ? finalTarget : relative(dirname(finalPath), finalTarget) || ".";
        await rm(stagedPath);
        await symlink(rewrittenTarget, stagedPath);
      } else if (entry.isDirectory()) {
        await visit(stagedPath, sourcePath, finalPath);
      }
    }
  };
  await visit(stagedRoot, sourceRoot, finalRoot);
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function workspaceMetadataFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stats = await lstat(path, { bigint: true });
      hash.update(`${relativePath}\0${stats.mode}\0${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}\0`);
      if (stats.isSymbolicLink()) {
        hash.update(`link\0${await readlink(path)}\0`);
      } else if (stats.isDirectory()) {
        hash.update("directory\0");
        await visit(path, relativePath);
      } else if (stats.isFile()) {
        hash.update("file\0");
      } else {
        hash.update("other\0");
      }
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

async function fileFingerprint(path: string): Promise<string> {
  const stats = await lstat(path);
  const hash = createHash("sha256");
  hash.update(`${stats.mode}\0`);
  await updateHashFromFile(hash, path);
  return hash.digest("hex");
}

async function updateHashFromFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk);
}

function validateBotId(id: string): void {
  if (!isValidBotId(id)) {
    throw new Error("Invalid bot id.");
  }
}

function isValidBotId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && basename(id) === id;
}

function isGeneratedBotId(id: string): boolean {
  return id.startsWith("bot-") && isUuidV4(id.slice("bot-".length));
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function isStoredBotBase(value: unknown): value is StoredBotBase {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isValidBotId(value.id) &&
    isString(value.name) &&
    isString(value.title) &&
    isString(value.description) &&
    isBoolean(value.notifications) &&
    isAgentModel(value.model) &&
    isReasoningEffort(value.reasoningEffort) &&
    (isString(value.threadId) || value.threadId === null) &&
    isString(value.workspacePath) &&
    isString(value.preview) &&
    (isString(value.updatedAt) || value.updatedAt === null)
  );
}

function isStoredBot(value: unknown): value is PersistedStoredBot {
  if (!isRecord(value) || !isStoredBotBase(value)) return false;
  const record = value;
  return (
    (record.provider === undefined || isOneOf(AGENT_PROVIDERS, record.provider)) &&
    isAvatarSeed(record.avatarSeed) &&
    (record.avatarHue === null || isAvatarHue(record.avatarHue)) &&
    isMarketplaceSource(record.marketplaceSource)
  );
}

function isMarketplaceSource(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    isString(value.agentId) &&
    isString(value.versionId) &&
    isNumber(value.version) &&
    Number.isInteger(value.version) &&
    value.version > 0 &&
    Array.isArray(value.skillIds) &&
    value.skillIds.every(isString) &&
    Array.isArray(value.routineIds) &&
    value.routineIds.every(isString)
  );
}

function isLegacyStoredBot(value: unknown): value is LegacyStoredBot {
  if (!isRecord(value) || !isStoredBotBase(value)) return false;
  const record = value;
  return (
    isString(record.avatarShape) &&
    isOneOf(LEGACY_AVATAR_VARIANTS, record.avatarShape) &&
    isString(record.avatarColor) &&
    isOneOf(LEGACY_AVATAR_COLORS, record.avatarColor)
  );
}

function migrateLegacyBot(bot: LegacyStoredBot): StoredBot {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    notifications: bot.notifications,
    provider: providerForLegacyModel(bot.model),
    model: bot.model,
    reasoningEffort: bot.reasoningEffort,
    threadId: bot.threadId,
    workspacePath: bot.workspacePath,
    preview: bot.preview,
    updatedAt: bot.updatedAt,
    avatarSeed: bot.id,
    avatarHue: null,
    avatarUrl: null,
  };
}

function normalizeStoredBot(bot: PersistedStoredBot): StoredBot {
  return {
    ...bot,
    provider: bot.provider ?? providerForLegacyModel(bot.model),
    avatarUrl: isString(bot.avatarUrl) && parseAgentAvatarUrl(bot.avatarUrl, bot.id) ? bot.avatarUrl : null,
  };
}

function agentAvatarUrl(botId: string, version: string, mimeType: string): string {
  const url = new URL(`openbot-avatar://agent/${encodeURIComponent(botId)}`);
  url.searchParams.set("v", version);
  url.searchParams.set("type", mimeType);
  return url.toString();
}

function parseAgentAvatarUrl(
  value: string,
  expectedBotId: string,
): { version: string; mimeType: AvatarImageInput["mimeType"] } | null {
  try {
    const url = new URL(value);
    const botId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
    const version = url.searchParams.get("v") ?? "";
    const mimeType = url.searchParams.get("type") ?? "";
    if (
      url.protocol !== "openbot-avatar:" ||
      url.hostname !== "agent" ||
      botId !== expectedBotId ||
      !isUuidV4(version) ||
      !isAvatarMimeType(mimeType)
    ) {
      return null;
    }
    return { version, mimeType };
  } catch {
    return null;
  }
}
