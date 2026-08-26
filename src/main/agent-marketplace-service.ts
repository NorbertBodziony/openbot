import { readFile } from "node:fs/promises";
import type {
  AgentPublicationPreview,
  AgentSubmission,
  AvatarImageInput,
  BotSummary,
  InstallMarketplaceAgentInput,
  InstallMarketplaceAgentResult,
  MarketplaceAgentDetail,
  MarketplaceAgentPage,
  MarketplaceAgentQuery,
  MarketplaceAgentRoutine,
  MarketplaceAgentSkill,
  MarketplaceAgentSummary,
  RoutineSchedule,
  SubmitMarketplaceAgentInput,
} from "@openbot/contracts/ipc";
import { isAvatarHue, isAvatarSeed, isRoutineSchedule } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";

interface AgentMarketplaceAuth {
  requestAuthorized<T>(path: string, init: RequestInit, decoder: (value: unknown) => T, timeoutMs?: number): Promise<T>;
  downloadAuthorized(path: string): Promise<Uint8Array>;
  resolveApiUrl(path: string): string;
}

interface AgentMarketplaceAgents {
  listBots(): BotSummary[];
  listRoutines(botId: string): Array<{
    name: string;
    instruction: string;
    active: boolean;
    trigger: { schedule: RoutineSchedule };
  }>;
  resolveAvatar(botId: string): { path: string; mimeType: AvatarImageInput["mimeType"] } | null;
  createBotProfile(input: {
    name: string;
    title?: string;
    description: string;
    avatarSeed: string;
    avatarHue: MarketplaceAgentDetail["avatarHue"];
  }): Promise<BotSummary>;
  setAvatar(botId: string, image: AvatarImageInput): Promise<BotSummary>;
  createRoutine(input: {
    botId: string;
    name: string;
    instruction: string;
    active: boolean;
    timezone: string;
    schedule: RoutineSchedule;
  }): unknown;
  deleteBot(botId: string): Promise<void>;
}

interface AgentMarketplaceSkills {
  listPublishable(botId: string): Promise<MarketplaceAgentSkill[]>;
  installVersion(input: { botId: string; skillId: string; versionId: string }): Promise<unknown>;
}

export class AgentMarketplaceService {
  constructor(
    private readonly auth: AgentMarketplaceAuth,
    private readonly agents: AgentMarketplaceAgents,
    private readonly skills: AgentMarketplaceSkills,
  ) {}

  async list(query: MarketplaceAgentQuery = {}): Promise<MarketplaceAgentPage> {
    const params = new URLSearchParams();
    if (query.query) params.set("query", query.query);
    if (query.featured) params.set("featured", "true");
    if (query.sort) params.set("sort", query.sort);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit) params.set("limit", String(query.limit));
    const page = await this.auth.requestAuthorized(
      `/v1/marketplace/agents/?${params}`,
      { method: "GET" },
      decodeAgentPage,
    );
    return { ...page, agents: page.agents.map((agent) => this.withAbsoluteAvatar(agent)) };
  }

  async get(agentId: string): Promise<MarketplaceAgentDetail> {
    const detail = await this.auth.requestAuthorized(
      `/v1/marketplace/agents/${encodeURIComponent(agentId)}`,
      { method: "GET" },
      decodeAgentDetail,
    );
    return this.withAbsoluteAvatar(detail);
  }

  async listMine(): Promise<AgentSubmission[]> {
    const values = await this.auth.requestAuthorized(
      "/v1/marketplace/agents/mine",
      { method: "GET" },
      decodeAgentSubmissions,
    );
    return values.map((value) => this.withAbsoluteAvatar(value));
  }

  async preview(botId: string): Promise<AgentPublicationPreview> {
    const bot = this.agents.listBots().find((candidate) => candidate.id === botId);
    if (!bot) throw new Error("Choose a local agent first.");
    const skills = await this.skills.listPublishable(botId);
    const routines = this.agents.listRoutines(botId).map(({ name, instruction, active, trigger }) => ({
      name,
      instruction,
      active,
      schedule: trigger.schedule,
    }));
    return {
      botId,
      name: bot.name,
      title: bot.title,
      description: bot.description,
      avatarSeed: bot.avatarSeed,
      avatarHue: bot.avatarHue,
      avatarUrl: bot.avatarUrl,
      skills,
      routines,
    };
  }

  async submit(input: SubmitMarketplaceAgentInput): Promise<AgentSubmission> {
    const snapshot = await this.preview(input.botId);
    const form = new FormData();
    form.set("snapshot", JSON.stringify({ ...snapshot, avatarUrl: null }));
    if (input.agentId) form.set("agentId", input.agentId);
    const avatar = this.agents.resolveAvatar(input.botId);
    if (avatar) {
      const bytes = new Uint8Array(await readFile(avatar.path));
      form.set("avatar", new Blob([toArrayBuffer(bytes)], { type: avatar.mimeType }), "avatar");
    }
    const submission = await this.auth.requestAuthorized(
      "/v1/marketplace/agents/",
      { method: "POST", body: form },
      decodeAgentSubmission,
      30_000,
    );
    return this.withAbsoluteAvatar(submission);
  }

  async install(input: InstallMarketplaceAgentInput): Promise<InstallMarketplaceAgentResult> {
    if (!validTimezone(input.timezone)) throw new Error("The local timezone is invalid.");
    const detail = await this.get(input.agentId);
    let bot = await this.agents.createBotProfile({
      name: detail.name,
      title: detail.title,
      description: detail.description,
      avatarSeed: detail.avatarSeed,
      avatarHue: detail.avatarHue,
    });
    try {
      if (detail.avatarUrl) {
        const bytes = await this.auth.downloadAuthorized(detail.avatarUrl);
        const mimeType = imageMimeType(bytes);
        if (!mimeType) throw new Error("The marketplace agent avatar is invalid.");
        bot = await this.agents.setAvatar(bot.id, { mimeType, bytes });
      }
      for (const skill of detail.skills) {
        await this.skills.installVersion({ botId: bot.id, skillId: skill.skillId, versionId: skill.versionId });
      }
      for (const routine of detail.routines) {
        this.agents.createRoutine({
          botId: bot.id,
          name: routine.name,
          instruction: routine.instruction,
          active: routine.active,
          timezone: input.timezone,
          schedule: localSchedule(routine.schedule),
        });
      }
    } catch (error) {
      await this.agents.deleteBot(bot.id).catch(() => undefined);
      throw error;
    }
    await this.auth.requestAuthorized(
      `/v1/marketplace/agents/${encodeURIComponent(detail.id)}/install`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptId: input.receiptId }),
      },
      decodeInstallReceipt,
    );
    return { bot };
  }

  private withAbsoluteAvatar<T extends { avatarUrl: string | null }>(value: T): T {
    return { ...value, avatarUrl: value.avatarUrl ? this.auth.resolveApiUrl(value.avatarUrl) : null };
  }
}

function localSchedule(schedule: RoutineSchedule): RoutineSchedule {
  return schedule.kind === "interval" ? { ...schedule, anchorAt: new Date().toISOString() } : structuredClone(schedule);
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function imageMimeType(bytes: Uint8Array): AvatarImageInput["mimeType"] | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP")
    return "image/webp";
  return null;
}

function decodeAgentPage(value: unknown): MarketplaceAgentPage {
  if (
    !isDynamicRecord(value) ||
    !Array.isArray(value.agents) ||
    !value.agents.every(isAgentSummary) ||
    (value.nextCursor !== null && !isString(value.nextCursor))
  )
    throw new Error("Invalid agent marketplace response.");
  return { agents: value.agents, nextCursor: value.nextCursor };
}

function decodeAgentDetail(value: unknown): MarketplaceAgentDetail {
  if (!isAgentSummary(value)) throw new Error("Invalid marketplace agent detail.");
  if (!isDynamicRecord(value)) throw new Error("Invalid marketplace agent detail.");
  const item = value;
  if (
    !isString(item.versionId) ||
    !Array.isArray(item.skills) ||
    !item.skills.every(isSkill) ||
    !Array.isArray(item.routines) ||
    !item.routines.every(isRoutine)
  )
    throw new Error("Invalid marketplace agent detail.");
  return {
    ...value,
    versionId: item.versionId,
    skills: item.skills.map(agentSkill),
    routines: item.routines.map(agentRoutine),
  };
}

function agentSkill(value: unknown): MarketplaceAgentSkill {
  if (!isDynamicRecord(value) || !isSkill(value)) throw new Error("Invalid marketplace agent skill.");
  return {
    skillId: value.skillId,
    versionId: value.versionId,
    slug: value.slug,
    name: value.name,
    version: value.version,
  };
}

function agentRoutine(value: unknown): MarketplaceAgentRoutine {
  if (!isDynamicRecord(value) || !isRoutine(value)) throw new Error("Invalid marketplace agent routine.");
  return { name: value.name, instruction: value.instruction, active: value.active, schedule: value.schedule };
}

function decodeAgentSubmissions(value: unknown): AgentSubmission[] {
  if (!Array.isArray(value) || !value.every(isAgentSubmission)) throw new Error("Invalid agent submissions.");
  return value;
}

function decodeAgentSubmission(value: unknown): AgentSubmission {
  if (!isAgentSubmission(value)) throw new Error("Invalid agent submission.");
  return value;
}

function decodeInstallReceipt(value: unknown): { installed: true } {
  if (!isDynamicRecord(value) || value.installed !== true) throw new Error("Invalid agent install receipt.");
  return { installed: true };
}

function isAgentSummary(value: unknown): value is MarketplaceAgentSummary {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.title) &&
    isString(value.description) &&
    isString(value.creatorName) &&
    isNumber(value.version) &&
    isNumber(value.installs) &&
    isBoolean(value.featured) &&
    isAvatarSeed(value.avatarSeed) &&
    (value.avatarHue === null || isAvatarHue(value.avatarHue)) &&
    (value.avatarUrl === null || isString(value.avatarUrl)) &&
    isNumber(value.skillCount) &&
    isNumber(value.routineCount) &&
    isNumber(value.activeRoutineCount) &&
    isString(value.updatedAt)
  );
}

function isAgentSubmission(value: unknown): value is AgentSubmission {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.agentId) &&
    isString(value.name) &&
    isString(value.title) &&
    isString(value.description) &&
    isNumber(value.version) &&
    isOneOf(["pending", "approved", "rejected"], value.status) &&
    (value.rejectionNote === null || isString(value.rejectionNote)) &&
    isAvatarSeed(value.avatarSeed) &&
    (value.avatarHue === null || isAvatarHue(value.avatarHue)) &&
    (value.avatarUrl === null || isString(value.avatarUrl)) &&
    isNumber(value.skillCount) &&
    isNumber(value.routineCount) &&
    isNumber(value.activeRoutineCount) &&
    isString(value.createdAt)
  );
}

function isSkill(value: unknown): value is MarketplaceAgentSkill {
  return (
    isDynamicRecord(value) &&
    isString(value.skillId) &&
    isString(value.versionId) &&
    isString(value.slug) &&
    isString(value.name) &&
    isNumber(value.version)
  );
}

function isRoutine(value: unknown): value is MarketplaceAgentRoutine {
  return (
    isDynamicRecord(value) &&
    isString(value.name) &&
    isString(value.instruction) &&
    isBoolean(value.active) &&
    isRoutineSchedule(value.schedule)
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
