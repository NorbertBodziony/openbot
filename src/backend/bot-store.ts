import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { BotSummary } from "../shared/ipc";
import { isRecord } from "./protocol";

type StoredBot = BotSummary;

interface StoredState {
  version: 1;
  bots: StoredBot[];
}

const DEFAULT_BOTS = [
  ["chief", "Chief", "Chief of staff"],
  ["sales-outbound", "Sales Outbound", "Outbound specialist"],
  ["inbox-manager", "Inbox Manager", "Inbox operations"],
  ["account-manager", "Account Manager", "Customer accounts"],
  ["talent-scout", "Talent Scout", "Recruiting research"],
  ["expense-manager", "Expense Manager", "Finance operations"],
  ["offsite-crew", "Offsite crew", "Project planning"],
] as const;

export class BotStore {
  readonly #statePath: string;
  readonly #botsRoot: string;
  readonly #sharedRoot: string;
  readonly #downloadsRoot: string;
  #state: StoredState = { version: 1, bots: [] };
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, homePath: string) {
    const infeldRoot = join(homePath, "Infeld");
    this.#statePath = join(userDataPath, "agent-state.json");
    this.#botsRoot = join(infeldRoot, "Bots");
    this.#sharedRoot = join(infeldRoot, "Shared");
    this.#downloadsRoot = join(infeldRoot, "Downloads");
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
    if (this.#state.bots.length === 0) {
      this.#state.bots = DEFAULT_BOTS.map(([id, name, role]) => this.#createRecord(id, name, role));
      await this.#persist();
    }
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
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bots)) {
        return { version: 1, bots: [] };
      }

      const bots = parsed.bots.filter(isStoredBot);
      return { version: 1, bots };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return { version: 1, bots: [] };
      throw error;
    }
  }

  async #persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.#state, null, 2)}\n`;
    const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;

    this.#writeQueue = this.#writeQueue.then(async () => {
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.#statePath);
    });
    await this.#writeQueue;
  }

  #createRecord(id: string, name: string, role: string): StoredBot {
    validateBotId(id);
    return {
      id,
      name,
      role,
      threadId: null,
      workspacePath: join(this.#botsRoot, id),
      preview: "Ready for a local task.",
      updatedAt: null,
    };
  }

  #requireBot(id: string): StoredBot {
    const bot = this.#state.bots.find((candidate) => candidate.id === id);
    if (!bot) throw new Error(`Unknown bot: ${id}`);
    return bot;
  }
}

function validateBotId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || basename(id) !== id) {
    throw new Error("Invalid bot id.");
  }
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
    typeof value.name === "string" &&
    typeof value.role === "string" &&
    (typeof value.threadId === "string" || value.threadId === null) &&
    typeof value.workspacePath === "string" &&
    typeof value.preview === "string" &&
    (typeof value.updatedAt === "string" || value.updatedAt === null)
  );
}
