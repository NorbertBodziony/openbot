import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type AgentModelId,
  type AgentReasoningEffort,
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  type BotAvatarColor,
  type BotAvatarShape,
  type BotSummary,
  isAgentModel,
  isAvatarColor,
  isAvatarShape,
  isReasoningEffort,
  type UpdateBotInput,
} from "../shared/ipc";
import { isRecord } from "./protocol";

type StoredBot = BotSummary;

interface StoredState {
  version: 1;
  examplesInitialized: boolean;
  bots: StoredBot[];
}

export const DEFAULT_AGENT_MODEL: AgentModelId = "gpt-5.6-luna";
export const DEFAULT_REASONING_EFFORT: AgentReasoningEffort = "medium";

const DEFAULT_BOTS = [
  ["chief", "Chief", "Chief of staff", "Coordinates work across your local OpenBot agents."],
  [
    "sales-outbound",
    "Sales Outbound",
    "Outbound specialist",
    "Researches prospects and prepares local outbound work.",
  ],
  [
    "inbox-manager",
    "Inbox Manager",
    "Inbox operations",
    "Helps review, organize, and draft inbox work.",
  ],
  [
    "account-manager",
    "Account Manager",
    "Customer accounts",
    "Keeps customer context and account follow-ups organized.",
  ],
  [
    "talent-scout",
    "Talent Scout",
    "Recruiting research",
    "Supports local candidate research and recruiting preparation.",
  ],
  [
    "expense-manager",
    "Expense Manager",
    "Finance operations",
    "Organizes local expense and finance operations.",
  ],
  [
    "offsite-crew",
    "Offsite crew",
    "Project planning",
    "Plans projects, events, and team logistics.",
  ],
] as const;

export class BotStore {
  readonly #statePath: string;
  readonly #botsRoot: string;
  readonly #sharedRoot: string;
  readonly #downloadsRoot: string;
  #state: StoredState = { version: 1, examplesInitialized: false, bots: [] };
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, homePath: string) {
    const openbotRoot = join(homePath, "OpenBot");
    this.#statePath = join(userDataPath, "bots.json");
    this.#botsRoot = join(openbotRoot, "Bots");
    this.#sharedRoot = join(openbotRoot, "Shared");
    this.#downloadsRoot = join(openbotRoot, "Downloads");
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

    this.#state = await this.#readState();
    if (!this.#state.examplesInitialized) {
      this.#state.bots = DEFAULT_BOTS.map(([id, name, role, description]) =>
        this.#createRecord(id, name, role, description),
      );
      this.#state.examplesInitialized = true;
    }
    await this.#persist();
  }

  list(): BotSummary[] {
    return this.#state.bots.map((bot) => ({ ...bot }));
  }

  async createBot(): Promise<BotSummary> {
    const record = this.#createRecord(`bot-${randomUUID()}`, "New agent", "New teammate");
    this.#state.bots.unshift(record);
    await mkdir(record.workspacePath, { recursive: true, mode: 0o700 });
    await this.#persist();
    return { ...record };
  }

  async updateBot(input: UpdateBotInput): Promise<BotSummary> {
    const bot = this.#requireBot(input.botId);
    if (input.name !== undefined) bot.name = requiredText(input.name, "Agent name", 80);
    if (input.role !== undefined) bot.role = input.role.trim().slice(0, 120);
    if (input.description !== undefined) bot.description = input.description.trim().slice(0, 2_000);
    if (input.notifications !== undefined) bot.notifications = input.notifications;
    if (input.model !== undefined) bot.model = input.model;
    if (input.reasoningEffort !== undefined) bot.reasoningEffort = input.reasoningEffort;
    if (input.avatarShape !== undefined) bot.avatarShape = input.avatarShape;
    if (input.avatarColor !== undefined) bot.avatarColor = input.avatarColor;
    bot.updatedAt = new Date().toISOString();
    await this.#persist();
    return { ...bot };
  }

  async deleteBot(id: string): Promise<BotSummary> {
    const bot = this.#requireBot(id);
    this.#state.bots = this.#state.bots.filter((candidate) => candidate.id !== id);
    await this.#persist();
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
    await this.#persist();
    return { ...record };
  }

  async setThreadId(id: string, threadId: string): Promise<void> {
    const bot = this.#requireBot(id);
    bot.threadId = threadId;
    bot.updatedAt = new Date().toISOString();
    await this.#persist();
  }

  async updatePreview(id: string, preview: string): Promise<void> {
    const bot = this.#requireBot(id);
    bot.preview = preview.slice(0, 180);
    bot.updatedAt = new Date().toISOString();
    await this.#persist();
  }

  async #readState(): Promise<StoredState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#statePath, "utf8"));
      if (
        !isRecord(parsed) ||
        parsed.version !== 1 ||
        typeof parsed.examplesInitialized !== "boolean" ||
        !Array.isArray(parsed.bots) ||
        !parsed.bots.every(isStoredBot)
      ) {
        throw new Error(
          "Agent state is corrupt or from a newer OpenBot version; refusing to overwrite it.",
        );
      }

      const bots = parsed.bots.map((bot) => ({ ...bot }));
      if (new Set(bots.map((bot) => bot.id)).size !== bots.length) {
        throw new Error("Agent state contains duplicate bot ids; refusing to overwrite it.");
      }
      return { version: 1, examplesInitialized: parsed.examplesInitialized, bots };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return { version: 1, examplesInitialized: false, bots: [] };
      }
      throw error;
    }
  }

  async #persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.#state, null, 2)}\n`;
    const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;

    this.#writeQueue = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, this.#statePath);
      });
    await this.#writeQueue;
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
      avatarShape: defaultAvatarShape(id),
      avatarColor: defaultAvatarColor(id),
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
  return trimmed.slice(0, maxLength);
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

function isStoredBot(value: unknown): value is StoredBot {
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
    (typeof value.updatedAt === "string" || value.updatedAt === null) &&
    isAvatarShape(value.avatarShape) &&
    isAvatarColor(value.avatarColor)
  );
}

function avatarIndex(id: string): number {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

function defaultAvatarShape(id: string): BotAvatarShape {
  return BOT_AVATAR_SHAPES[avatarIndex(id) % BOT_AVATAR_SHAPES.length] ?? "blob";
}

function defaultAvatarColor(id: string): BotAvatarColor {
  return BOT_AVATAR_COLORS[avatarIndex(`${id}:color`) % BOT_AVATAR_COLORS.length] ?? "orange";
}
