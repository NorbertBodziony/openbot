import { readFile } from "node:fs/promises";
import type {
  AgentPublicationPreview,
  AgentSubmission,
  AgentSummary,
  AvatarImageInput,
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
  listAgents(): AgentSummary[];
  listRoutines(agentId: string): Array<{
    id: string;
    name: string;
    instruction: string;
    active: boolean;
    trigger: { schedule: RoutineSchedule };
  }>;
  resolveAvatar(agentId: string): { path: string; mimeType: AvatarImageInput["mimeType"] } | null;
  createAgentProfile(input: {
    name: string;
    title?: string;
    description: string;
    avatarSeed: string;
    avatarHue: MarketplaceAgentDetail["avatarHue"];
  }): Promise<AgentSummary>;
  updateAgent(input: {
    agentId: string;
    name: string;
    title: string;
    description: string;
    avatarSeed: string;
    avatarHue: MarketplaceAgentDetail["avatarHue"];
  }): Promise<AgentSummary>;
  setAvatar(agentId: string, image: AvatarImageInput | null): Promise<AgentSummary>;
  createRoutine(
    input: {
      agentId: string;
      name: string;
      instruction: string;
      active: boolean;
      timezone: string;
      schedule: RoutineSchedule;
    },
    options?: { recordConversationEvent?: boolean },
  ): { id: string };
  deleteRoutine(
    input: { agentId: string; routineId: string },
    options?: { recordConversationEvent?: boolean },
  ): Promise<void>;
  setMarketplaceSource(agentId: string, source: NonNullable<AgentSummary["marketplaceSource"]>): AgentSummary;
  deleteAgent(agentId: string): Promise<void>;
}

interface AgentMarketplaceSkills {
  listPublishable(agentId: string): Promise<MarketplaceAgentSkill[]>;
  installVersion(input: { agentId: string; skillId: string; versionId: string }): Promise<unknown>;
  uninstall(input: { agentId: string; skillId: string }): Promise<void>;
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

  async get(listingId: string): Promise<MarketplaceAgentDetail> {
    const detail = await this.auth.requestAuthorized(
      `/v1/marketplace/agents/${encodeURIComponent(listingId)}`,
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

  async preview(agentId: string): Promise<AgentPublicationPreview> {
    const agent = this.agents.listAgents().find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error("Choose a local agent first.");
    const skills = await this.skills.listPublishable(agentId);
    const routines = this.agents.listRoutines(agentId).map(({ name, instruction, active, trigger }) => ({
      name,
      instruction,
      active,
      schedule: trigger.schedule,
    }));
    return {
      agentId: agentId,
      name: agent.name,
      title: agent.title,
      description: agent.description,
      avatarSeed: agent.avatarSeed,
      avatarHue: agent.avatarHue,
      avatarUrl: agent.avatarUrl,
      skills,
      routines,
    };
  }

  async submit(input: SubmitMarketplaceAgentInput): Promise<AgentSubmission> {
    const snapshot = await this.preview(input.agentId);
    const form = new FormData();
    form.set("snapshot", JSON.stringify(toMarketplaceSnapshotWire(snapshot)));
    // The multipart field names the marketplace listing being updated, and is the deployed spelling.
    if (input.listingId) form.set("agentId", input.listingId);
    const avatar = this.agents.resolveAvatar(input.agentId);
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
    const detail = await this.get(input.listingId);
    const existing = input.agentId
      ? this.agents.listAgents().find((candidate) => candidate.id === input.agentId)
      : undefined;
    if (input.agentId && !existing) throw new Error("The installed agent no longer exists.");
    if (existing?.marketplaceSource?.listingId !== detail.id) {
      if (existing) throw new Error("This local agent was installed from a different marketplace agent.");
    }
    if (existing?.marketplaceSource?.versionId === detail.versionId) return { agent: existing };

    let avatar: AvatarImageInput | null = null;
    if (detail.avatarUrl) {
      const bytes = await this.auth.downloadAuthorized(detail.avatarUrl);
      const mimeType = imageMimeType(bytes);
      if (!mimeType) throw new Error("The marketplace agent avatar is invalid.");
      avatar = { mimeType, bytes };
    }
    let agent =
      existing ??
      (await this.agents.createAgentProfile({
        name: detail.name,
        title: detail.title,
        description: detail.description,
        avatarSeed: detail.avatarSeed,
        avatarHue: detail.avatarHue,
      }));
    const createdRoutineIds: string[] = [];
    try {
      for (const skill of detail.skills) {
        await this.skills.installVersion({ agentId: agent.id, skillId: skill.skillId, versionId: skill.versionId });
      }
      for (const routine of detail.routines) {
        const created = this.agents.createRoutine(
          {
            agentId: agent.id,
            name: routine.name,
            instruction: routine.instruction,
            active: routine.active,
            timezone: input.timezone,
            schedule: localSchedule(routine.schedule),
          },
          { recordConversationEvent: false },
        );
        createdRoutineIds.push(created.id);
      }
      if (existing) {
        agent = await this.agents.updateAgent({
          agentId: agent.id,
          name: detail.name,
          title: detail.title,
          description: detail.description,
          avatarSeed: detail.avatarSeed,
          avatarHue: detail.avatarHue,
        });
      }
      agent = await this.agents.setAvatar(agent.id, avatar);
      const nextSkillIds = new Set(detail.skills.map((skill) => skill.skillId));
      for (const skillId of existing?.marketplaceSource?.skillIds ?? []) {
        if (!nextSkillIds.has(skillId)) await this.skills.uninstall({ agentId: agent.id, skillId });
      }
      agent = this.agents.setMarketplaceSource(agent.id, {
        listingId: detail.id,
        versionId: detail.versionId,
        version: detail.version,
        skillIds: [...nextSkillIds],
        routineIds: createdRoutineIds,
      });
      for (const routineId of existing?.marketplaceSource?.routineIds ?? []) {
        await this.agents
          .deleteRoutine({ agentId: agent.id, routineId }, { recordConversationEvent: false })
          .catch(() => undefined);
      }
    } catch (error) {
      if (existing) {
        await Promise.all(
          createdRoutineIds.map((routineId) =>
            this.agents
              .deleteRoutine({ agentId: agent.id, routineId }, { recordConversationEvent: false })
              .catch(() => undefined),
          ),
        );
      } else {
        await this.agents.deleteAgent(agent.id).catch(() => undefined);
      }
      throw error;
    }
    if (!existing) {
      await this.auth.requestAuthorized(
        `/v1/marketplace/agents/${encodeURIComponent(detail.id)}/install`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ receiptId: input.receiptId }),
        },
        decodeInstallReceipt,
      );
    }
    return { agent: agent };
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
    !value.agents.every(isMarketplaceAgentSummary) ||
    (value.nextCursor !== null && !isString(value.nextCursor))
  )
    throw new Error("Invalid agent marketplace response.");
  return { agents: value.agents, nextCursor: value.nextCursor };
}

function decodeAgentDetail(value: unknown): MarketplaceAgentDetail {
  if (!isMarketplaceAgentSummary(value)) throw new Error("Invalid marketplace agent detail.");
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
  if (!Array.isArray(value) || !value.every(isAgentSubmissionWire)) throw new Error("Invalid agent submissions.");
  return value.map(toCurrentSubmission);
}

function decodeAgentSubmission(value: unknown): AgentSubmission {
  if (!isAgentSubmissionWire(value)) throw new Error("Invalid agent submission.");
  return toCurrentSubmission(value);
}

function toCurrentSubmission({ agentId, ...rest }: AgentSubmissionWire): AgentSubmission {
  return { ...rest, listingId: agentId };
}

function decodeInstallReceipt(value: unknown): { installed: true } {
  if (!isDynamicRecord(value) || value.installed !== true) throw new Error("Invalid agent install receipt.");
  return { installed: true };
}

/**
 * The published snapshot and the submission the account Worker returns still spell the two ids the way
 * the deployed Worker does: `agentId` for the local agent inside a snapshot, `agentId` for the
 * marketplace listing. A Worker deploy can land either side of a desktop release, so the two
 * converters here are the only place the desktop's `agentId`/`listingId` vocabulary meets that wire.
 */
type AgentSubmissionWire = Omit<AgentSubmission, "listingId"> & { agentId: string };

type MarketplaceSnapshotWire = Omit<AgentPublicationPreview, "agentId"> & { botId: string };

function toMarketplaceSnapshotWire({ agentId, ...rest }: AgentPublicationPreview): MarketplaceSnapshotWire {
  return { ...rest, botId: agentId, avatarUrl: null };
}

function isMarketplaceAgentSummary(value: unknown): value is MarketplaceAgentSummary {
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

function isAgentSubmissionWire(value: unknown): value is AgentSubmissionWire {
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
