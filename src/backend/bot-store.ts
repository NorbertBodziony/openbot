import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isReasoningEffort,
  providerForLegacyModel,
  type UpdateBotInput,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { isUuidV4 } from "@openbot/contracts/validation";
import { OpenBotDatabase, type ProviderSession, stableThreadId } from "./openbot-database";
import { isRecord } from "./protocol";

type StoredBot = BotSummary;
type PersistedStoredBot = Omit<StoredBot, "avatarUrl" | "provider"> & {
  avatarUrl?: string | null;
  provider?: AgentProviderId;
};
type StoredBotBase = Omit<PersistedStoredBot, "avatarSeed" | "avatarHue"> & DynamicRecord;

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

export class BotStore {
  readonly #statePath: string;
  readonly #botsRoot: string;
  readonly #sharedRoot: string;
  readonly #downloadsRoot: string;
  readonly #avatarsRoot: string;
  readonly #database: OpenBotDatabase;
  #state: StoredState = { version: 2, examplesInitialized: false, bots: [] };
  #avatarUpdateQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, homePath: string, database = new OpenBotDatabase(userDataPath)) {
    const openbotRoot = join(homePath, "OpenBot");
    this.#statePath = join(userDataPath, "bots.json");
    this.#botsRoot = join(openbotRoot, "Bots");
    this.#sharedRoot = join(openbotRoot, "Shared");
    this.#downloadsRoot = join(openbotRoot, "Downloads");
    this.#avatarsRoot = join(userDataPath, "avatars", "agents");
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
      return;
    }

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
    this.#database.replaceAgents("legacy-import:bots:v1", legacy.bots, "agents.legacy-imported");
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

  list(): BotSummary[] {
    return this.#state.bots.map((bot) => ({ ...bot }));
  }

  async createBot(input: Omit<CreateBotInput, "initialMessage">): Promise<BotSummary> {
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
      rm(join(this.#botsRoot, id), { recursive: true, force: true }),
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

    const record = this.#createRecord(id, name ?? titleFromId(id), title ?? "Local teammate");
    this.#state.bots.push(record);
    await mkdir(record.workspacePath, { recursive: true, mode: 0o700 });
    this.#persist("agent.created");
    return { ...record };
  }

  async ensureThreadId(id: string): Promise<string> {
    const bot = this.#requireBot(id);
    if (bot.threadId) return bot.threadId;
    bot.threadId = `openbot-thread-${randomUUID()}`;
    bot.updatedAt = new Date().toISOString();
    this.#persist("thread.created");
    return bot.threadId;
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

function validateBotId(id: string): void {
  if (!isValidBotId(id)) {
    throw new Error("Invalid bot id.");
  }
}

function isValidBotId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && basename(id) === id;
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
    (record.avatarHue === null || isAvatarHue(record.avatarHue))
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
