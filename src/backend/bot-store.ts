import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { INPUT_LIMITS } from "../shared/input-limits";
import {
  type AgentModelId,
  type AgentReasoningEffort,
  type BotSummary,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isReasoningEffort,
  type UpdateBotInput,
} from "../shared/ipc";
import {
  OpenBotDatabase,
  type ProviderSession,
  providerForStoredModel,
  stableThreadId,
} from "./openbot-database";
import { isRecord } from "./protocol";

type StoredBot = BotSummary;

interface StoredState {
  version: 2;
  examplesInitialized: boolean;
  bots: StoredBot[];
}

type LegacyStoredBot = Omit<StoredBot, "avatarSeed" | "avatarHue"> & {
  avatarShape: string;
  avatarColor: string;
};

const LEGACY_AVATAR_SHAPES = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop",
] as const;
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
export const DEFAULT_REASONING_EFFORT: AgentReasoningEffort = "medium";

export class BotStore {
  readonly #statePath: string;
  readonly #botsRoot: string;
  readonly #sharedRoot: string;
  readonly #downloadsRoot: string;
  readonly #database: OpenBotDatabase;
  #state: StoredState = { version: 2, examplesInitialized: false, bots: [] };

  constructor(
    userDataPath: string,
    homePath: string,
    database = new OpenBotDatabase(userDataPath),
  ) {
    const openbotRoot = join(homePath, "OpenBot");
    this.#statePath = join(userDataPath, "bots.json");
    this.#botsRoot = join(openbotRoot, "Bots");
    this.#sharedRoot = join(openbotRoot, "Shared");
    this.#downloadsRoot = join(openbotRoot, "Downloads");
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
      mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 }),
    ]);

    await this.#database.initialize();
    const persisted = this.#database.listAgents();
    if (persisted.length > 0 || this.#database.hasAggregateEvents("agents", "agents")) {
      this.#state = { version: 2, examplesInitialized: true, bots: persisted };
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
        provider: providerForStoredModel(bot.model),
        externalSessionId,
        model: bot.model,
        effort: bot.reasoningEffort,
      });
    }
  }

  list(): BotSummary[] {
    return this.#state.bots.map((bot) => ({ ...bot }));
  }

  async createBot(): Promise<BotSummary> {
    if (this.#state.bots.length >= INPUT_LIMITS.agents) {
      throw new Error(`A host can have up to ${INPUT_LIMITS.agents} agents.`);
    }
    const record = this.#createRecord(`bot-${randomUUID()}`, "New agent", "New teammate");
    this.#state.bots.unshift(record);
    await mkdir(record.workspacePath, { recursive: true, mode: 0o700 });
    this.#persist("agent.created");
    return { ...record };
  }

  async updateBot(input: UpdateBotInput): Promise<BotSummary> {
    const bot = this.#requireBot(input.botId);
    if (input.name !== undefined) {
      bot.name = requiredText(input.name, "Agent name", INPUT_LIMITS.agentName);
    }
    if (input.role !== undefined) {
      bot.role = limitedText(input.role, "Agent title", INPUT_LIMITS.agentTitle);
    }
    if (input.description !== undefined) {
      bot.description = limitedText(
        input.description,
        "Agent description",
        INPUT_LIMITS.agentDescription,
      );
    }
    if (input.notifications !== undefined) bot.notifications = input.notifications;
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

  async deleteBot(id: string): Promise<BotSummary> {
    const bot = this.#requireBot(id);
    this.#state.bots = this.#state.bots.filter((candidate) => candidate.id !== id);
    this.#database.hardDeleteAgent(
      `agents:hard-delete:${randomUUID()}`,
      id,
      bot.threadId,
      this.#state.bots,
    );
    return { ...bot };
  }

  async getOrCreate(id: string, name?: string, role?: string): Promise<BotSummary> {
    validateBotId(id);
    const existing = this.#state.bots.find((bot) => bot.id === id);
    if (existing) {
      await mkdir(existing.workspacePath, { recursive: true, mode: 0o700 });
      return { ...existing };
    }

    const record = this.#createRecord(id, name ?? titleFromId(id), role ?? "Local teammate");
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
    return this.#database.activeProviderSession(bot.threadId, providerForStoredModel(bot.model));
  }

  bindProviderSession(id: string, externalSessionId: string): ProviderSession {
    const bot = this.#requireBot(id);
    if (!bot.threadId) throw new Error(`Agent ${id} does not have an OpenBot thread.`);
    return this.#database.bindProviderSession({
      threadId: bot.threadId,
      provider: providerForStoredModel(bot.model),
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
      const parsed: unknown = JSON.parse(await readFile(this.#statePath, "utf8"));
      if (
        !isRecord(parsed) ||
        typeof parsed.examplesInitialized !== "boolean" ||
        !Array.isArray(parsed.bots)
      ) {
        throw new Error(
          "Agent state is corrupt or from a newer OpenBot version; refusing to overwrite it.",
        );
      }

      let bots: StoredBot[];
      if (parsed.version === 1 && parsed.bots.every(isLegacyStoredBot)) {
        bots = parsed.bots.map(migrateLegacyBot);
      } else if (parsed.version === 2 && parsed.bots.every(isStoredBot)) {
        bots = parsed.bots.map((bot) => ({ ...bot }));
      } else {
        throw new Error(
          "Agent state is corrupt or from a newer OpenBot version; refusing to overwrite it.",
        );
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
    this.#database.replaceAgents(
      `agents:${eventType}:${randomUUID()}`,
      this.#state.bots,
      eventType,
    );
  }

  #createRecord(id: string, name: string, role: string, description = ""): StoredBot {
    validateBotId(id);
    return {
      id,
      name,
      role,
      description,
      notifications: true,
      model: DEFAULT_AGENT_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      threadId: null,
      workspacePath: join(this.#botsRoot, id),
      preview: "No messages yet",
      updatedAt: null,
      avatarSeed: id,
      avatarHue: null,
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

function isStoredBotBase(value: unknown): value is Omit<StoredBot, "avatarSeed" | "avatarHue"> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isValidBotId(value.id) &&
    typeof value.name === "string" &&
    typeof value.role === "string" &&
    typeof value.description === "string" &&
    typeof value.notifications === "boolean" &&
    isAgentModel(value.model) &&
    isReasoningEffort(value.reasoningEffort) &&
    (typeof value.threadId === "string" || value.threadId === null) &&
    typeof value.workspacePath === "string" &&
    typeof value.preview === "string" &&
    (typeof value.updatedAt === "string" || value.updatedAt === null)
  );
}

function isStoredBot(value: unknown): value is StoredBot {
  if (!isStoredBotBase(value) || !isRecord(value)) return false;
  const record: Record<string, unknown> = value;
  return (
    isAvatarSeed(record.avatarSeed) && (record.avatarHue === null || isAvatarHue(record.avatarHue))
  );
}

function isLegacyStoredBot(value: unknown): value is LegacyStoredBot {
  if (!isStoredBotBase(value) || !isRecord(value)) return false;
  const record: Record<string, unknown> = value;
  return (
    typeof record.avatarShape === "string" &&
    LEGACY_AVATAR_SHAPES.includes(record.avatarShape as (typeof LEGACY_AVATAR_SHAPES)[number]) &&
    typeof record.avatarColor === "string" &&
    LEGACY_AVATAR_COLORS.includes(record.avatarColor as (typeof LEGACY_AVATAR_COLORS)[number])
  );
}

function migrateLegacyBot(bot: LegacyStoredBot): StoredBot {
  const { avatarShape: _avatarShape, avatarColor: _avatarColor, ...rest } = bot;
  return { ...rest, avatarSeed: bot.id, avatarHue: null };
}
