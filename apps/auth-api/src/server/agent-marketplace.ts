import { isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentPublicationPreview,
  type AgentSubmission,
  isAvatarHue,
  isAvatarSeed,
  isRoutineSchedule,
  type MarketplaceAgentDetail,
  type MarketplaceAgentPage,
  type MarketplaceAgentQuery,
  type MarketplaceAgentRoutine,
  type MarketplaceAgentSkill,
  type MarketplaceAgentSummary,
} from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";
import type { AuthUser, WorkerBindings } from "./types";

const MAX_AGENTS_PER_USER = 5;
const MAX_VERSIONS_PER_AGENT = 5;
const MAX_SUBMISSIONS_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

interface AgentRow {
  id: string;
  agent_id?: string;
  version_id?: string;
  version: number;
  name: string;
  title: string;
  description: string;
  avatar_seed: string;
  avatar_hue: number | null;
  avatar_key: string | null;
  skills_json: string;
  routines_json: string;
  creator_name: string | null;
  creator_email: string;
  installs: number;
  featured: number;
  updated_at: number;
  created_at: number;
  status?: string;
  rejection_note?: string | null;
}

export class AgentMarketplaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class AgentMarketplace {
  constructor(private readonly bindings: WorkerBindings) {}

  async list(input: MarketplaceAgentQuery = {}): Promise<MarketplaceAgentPage> {
    const limit = Math.max(1, Math.min(50, input.limit ?? 24));
    const clauses = ["agents.approved_version_id = versions.id"];
    const values: Array<string | number> = [];
    if (input.query?.trim()) {
      clauses.push(
        "(versions.name LIKE ? OR versions.title LIKE ? OR versions.description LIKE ? OR users.name LIKE ?)",
      );
      const query = `%${input.query.trim()}%`;
      values.push(query, query, query, query);
    }
    if (input.featured) clauses.push("agents.featured = 1");
    if (input.cursor) {
      const cursor = Number(input.cursor);
      if (!Number.isFinite(cursor)) throw new AgentMarketplaceError(400, "invalid_cursor", "Invalid cursor.");
      clauses.push("agents.updated_at < ?");
      values.push(cursor);
    }
    const order =
      input.sort === "installs"
        ? "agents.installs DESC, agents.updated_at DESC"
        : "agents.featured DESC, agents.updated_at DESC";
    const result = await this.bindings.DB.prepare(
      `SELECT agents.id, agents.installs, agents.featured, agents.updated_at,
              versions.id AS version_id, versions.version, versions.name, versions.title, versions.description,
              versions.avatar_seed, versions.avatar_hue, versions.avatar_key,
              versions.skills_json, versions.routines_json, users.name AS creator_name, users.email AS creator_email
       FROM marketplace_agents agents
       JOIN marketplace_agent_versions versions ON ${clauses.join(" AND ")}
       JOIN users ON users.id = agents.owner_user_id
       ORDER BY ${order} LIMIT ?`,
    )
      .bind(...values, limit + 1)
      .all<AgentRow>();
    const rows = result.results ?? [];
    const page = rows.slice(0, limit);
    return {
      agents: page.map((row) => publicSummary(row)),
      nextCursor: rows.length > limit ? String(page.at(-1)?.updated_at ?? "") : null,
    };
  }

  async get(agentId: string): Promise<MarketplaceAgentDetail> {
    const row = await this.approvedRow(agentId);
    if (!row) throw new AgentMarketplaceError(404, "agent_not_found", "The agent was not found.");
    return publicDetail(row);
  }

  async listMine(userId: string): Promise<AgentSubmission[]> {
    const result = await this.bindings.DB.prepare(
      `SELECT versions.id, versions.agent_id, versions.version, versions.name, versions.title, versions.description,
              versions.avatar_seed, versions.avatar_hue, versions.avatar_key, versions.skills_json,
              versions.routines_json, versions.status, versions.rejection_note, versions.created_at,
              agents.installs, agents.featured, agents.updated_at, users.name AS creator_name, users.email AS creator_email
       FROM marketplace_agent_versions versions
       JOIN marketplace_agents agents ON agents.id = versions.agent_id
       JOIN users ON users.id = agents.owner_user_id
       WHERE agents.owner_user_id = ? ORDER BY versions.created_at DESC`,
    )
      .bind(userId)
      .all<AgentRow>();
    return (result.results ?? []).map(submission);
  }

  async submit(input: {
    user: AuthUser;
    snapshot: unknown;
    avatar: { bytes: Uint8Array; mimeType: string } | null;
    agentId?: string;
  }): Promise<AgentSubmission> {
    const snapshot = validateSnapshot(input.snapshot);
    const recent = await this.bindings.DB.prepare(
      `SELECT count(*) AS count FROM marketplace_agent_versions versions
       JOIN marketplace_agents agents ON agents.id = versions.agent_id
       WHERE agents.owner_user_id = ? AND versions.created_at >= ?`,
    )
      .bind(input.user.id, Date.now() - DAY_MS)
      .first<{ count: number }>();
    if ((recent?.count ?? 0) >= MAX_SUBMISSIONS_PER_DAY)
      throw new AgentMarketplaceError(429, "submission_limit", "You can submit up to 10 agent versions per day.");

    const agentId = input.agentId ?? crypto.randomUUID();
    let version = 1;
    if (input.agentId) {
      const owned = await this.bindings.DB.prepare(
        "SELECT id FROM marketplace_agents WHERE id = ? AND owner_user_id = ?",
      )
        .bind(input.agentId, input.user.id)
        .first();
      if (!owned) throw new AgentMarketplaceError(404, "agent_not_found", "The owned agent was not found.");
      const latest = await this.bindings.DB.prepare(
        "SELECT max(version) AS version FROM marketplace_agent_versions WHERE agent_id = ?",
      )
        .bind(agentId)
        .first<{ version: number | null }>();
      version = (latest?.version ?? 0) + 1;
      if (version > MAX_VERSIONS_PER_AGENT)
        throw new AgentMarketplaceError(409, "agent_version_limit", "Each agent can have up to 5 submitted versions.");
    } else {
      const count = await this.bindings.DB.prepare(
        "SELECT count(*) AS count FROM marketplace_agents WHERE owner_user_id = ?",
      )
        .bind(input.user.id)
        .first<{ count: number }>();
      if ((count?.count ?? 0) >= MAX_AGENTS_PER_USER)
        throw new AgentMarketplaceError(409, "agent_limit", "You can submit up to 5 agents.");
    }

    await this.validateSkills(snapshot.skills);
    const versionId = crypto.randomUUID();
    const now = Date.now();
    let avatarKey: string | null = null;
    if (input.avatar) {
      if (!isValidAvatarImage(input.avatar.mimeType, input.avatar.bytes))
        throw new AgentMarketplaceError(400, "invalid_avatar", "Choose a valid PNG, JPEG, or WebP avatar.");
      avatarKey = `agents/${agentId}/versions/${versionId}.avatar`;
      await this.bindings.SKILLS.put(avatarKey, input.avatar.bytes, {
        httpMetadata: { contentType: input.avatar.mimeType },
      });
    }
    try {
      if (!input.agentId) {
        await this.bindings.DB.prepare(
          "INSERT INTO marketplace_agents(id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
          .bind(agentId, input.user.id, now, now)
          .run();
      }
      await this.bindings.DB.prepare(
        `INSERT INTO marketplace_agent_versions(
           id, agent_id, version, name, title, description, avatar_seed, avatar_hue, avatar_key,
           skills_json, routines_json, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
        .bind(
          versionId,
          agentId,
          version,
          snapshot.name,
          snapshot.title,
          snapshot.description,
          snapshot.avatarSeed,
          snapshot.avatarHue,
          avatarKey,
          JSON.stringify(snapshot.skills),
          JSON.stringify(snapshot.routines),
          now,
        )
        .run();
      await this.bindings.DB.prepare("UPDATE marketplace_agents SET updated_at = ? WHERE id = ?")
        .bind(now, agentId)
        .run();
    } catch (error) {
      if (avatarKey) await this.bindings.SKILLS.delete(avatarKey);
      if (!input.agentId)
        await this.bindings.DB.prepare("DELETE FROM marketplace_agents WHERE id = ? AND approved_version_id IS NULL")
          .bind(agentId)
          .run();
      throw error;
    }
    const row = await this.versionRow(versionId);
    if (!row) throw new AgentMarketplaceError(500, "submission_failed", "The agent submission could not be read.");
    return submission(row);
  }

  async avatar(agentId: string) {
    const row = await this.approvedRow(agentId);
    if (!row?.avatar_key) throw new AgentMarketplaceError(404, "avatar_not_found", "The avatar was not found.");
    const object = await this.bindings.SKILLS.get(row.avatar_key);
    if (!object) throw new AgentMarketplaceError(404, "avatar_not_found", "The avatar was not found.");
    return object;
  }

  async recordInstall(agentId: string, userId: string, receiptId: string): Promise<void> {
    if (!(await this.approvedRow(agentId)))
      throw new AgentMarketplaceError(404, "agent_not_found", "The agent was not found.");
    const result = await this.bindings.DB.prepare(
      "INSERT OR IGNORE INTO marketplace_agent_install_receipts(receipt_id, agent_id, user_id, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(receiptId, agentId, userId, Date.now())
      .run();
    if (result.meta.changes === 1)
      await this.bindings.DB.prepare("UPDATE marketplace_agents SET installs = installs + 1 WHERE id = ?")
        .bind(agentId)
        .run();
  }

  async listPending(): Promise<AgentSubmission[]> {
    const result = await this.bindings.DB.prepare(
      `SELECT versions.id, versions.agent_id, versions.version, versions.name, versions.title, versions.description,
              versions.avatar_seed, versions.avatar_hue, versions.avatar_key, versions.skills_json,
              versions.routines_json, versions.status, versions.rejection_note, versions.created_at,
              agents.installs, agents.featured, agents.updated_at, users.name AS creator_name, users.email AS creator_email
       FROM marketplace_agent_versions versions JOIN marketplace_agents agents ON agents.id = versions.agent_id
       JOIN users ON users.id = agents.owner_user_id WHERE versions.status = 'pending' ORDER BY versions.created_at`,
    ).all<AgentRow>();
    return (result.results ?? []).map(submission);
  }

  async review(versionId: string, status: "approved" | "rejected", note: string | null): Promise<void> {
    const row = await this.bindings.DB.prepare("SELECT agent_id, status FROM marketplace_agent_versions WHERE id = ?")
      .bind(versionId)
      .first<{ agent_id: string; status: string }>();
    if (!row) throw new AgentMarketplaceError(404, "submission_not_found", "The submission was not found.");
    if (row.status !== "pending")
      throw new AgentMarketplaceError(409, "already_reviewed", "The submission was already reviewed.");
    const now = Date.now();
    await this.bindings.DB.prepare(
      "UPDATE marketplace_agent_versions SET status = ?, rejection_note = ?, reviewed_at = ? WHERE id = ?",
    )
      .bind(status, status === "rejected" ? note : null, now, versionId)
      .run();
    if (status === "approved")
      await this.bindings.DB.prepare(
        "UPDATE marketplace_agents SET approved_version_id = ?, updated_at = ? WHERE id = ?",
      )
        .bind(versionId, now, row.agent_id)
        .run();
  }

  async setFeatured(agentId: string, featured: boolean): Promise<void> {
    const result = await this.bindings.DB.prepare(
      "UPDATE marketplace_agents SET featured = ?, updated_at = ? WHERE id = ? AND approved_version_id IS NOT NULL",
    )
      .bind(featured ? 1 : 0, Date.now(), agentId)
      .run();
    if (result.meta.changes !== 1) throw new AgentMarketplaceError(404, "agent_not_found", "The agent was not found.");
  }

  private async validateSkills(skills: MarketplaceAgentSkill[]): Promise<void> {
    for (const skill of skills) {
      const row = await this.bindings.DB.prepare(
        `SELECT versions.id, versions.skill_id, versions.version, skills.slug, versions.name
         FROM marketplace_skill_versions versions JOIN marketplace_skills skills ON skills.id = versions.skill_id
         WHERE versions.id = ? AND versions.skill_id = ? AND versions.status = 'approved'`,
      )
        .bind(skill.versionId, skill.skillId)
        .first<{ id: string; skill_id: string; version: number; slug: string; name: string }>();
      if (!row || row.version !== skill.version || row.slug !== skill.slug || row.name !== skill.name)
        throw new AgentMarketplaceError(400, "invalid_skill", `The skill ${skill.name} is not an approved version.`);
    }
  }

  private approvedRow(agentId: string) {
    return this.bindings.DB.prepare(
      `SELECT agents.id, agents.installs, agents.featured, agents.updated_at,
              versions.id AS version_id, versions.version, versions.name, versions.title, versions.description,
              versions.avatar_seed, versions.avatar_hue, versions.avatar_key, versions.skills_json,
              versions.routines_json, users.name AS creator_name, users.email AS creator_email
       FROM marketplace_agents agents JOIN marketplace_agent_versions versions ON versions.id = agents.approved_version_id
       JOIN users ON users.id = agents.owner_user_id WHERE agents.id = ?`,
    )
      .bind(agentId)
      .first<AgentRow>();
  }

  private versionRow(versionId: string) {
    return this.bindings.DB.prepare(
      `SELECT versions.id, versions.agent_id, versions.version, versions.name, versions.title, versions.description,
              versions.avatar_seed, versions.avatar_hue, versions.avatar_key, versions.skills_json,
              versions.routines_json, versions.status, versions.rejection_note, versions.created_at,
              agents.installs, agents.featured, agents.updated_at, users.name AS creator_name, users.email AS creator_email
       FROM marketplace_agent_versions versions JOIN marketplace_agents agents ON agents.id = versions.agent_id
       JOIN users ON users.id = agents.owner_user_id WHERE versions.id = ?`,
    )
      .bind(versionId)
      .first<AgentRow>();
  }
}

function validateSnapshot(value: unknown): AgentPublicationPreview {
  if (!isDynamicRecord(value)) throw new AgentMarketplaceError(400, "invalid_agent", "Invalid agent snapshot.");
  const name = text(value.name, "name", INPUT_LIMITS.agentName, true);
  const title = text(value.title, "title", INPUT_LIMITS.agentTitle, false);
  const description = text(value.description, "description", INPUT_LIMITS.agentDescription, true);
  if (
    !isString(value.botId) ||
    !isAvatarSeed(value.avatarSeed) ||
    (value.avatarHue !== null && !isAvatarHue(value.avatarHue))
  )
    throw new AgentMarketplaceError(400, "invalid_agent", "Invalid agent profile.");
  if (!Array.isArray(value.skills) || value.skills.length > INPUT_LIMITS.agents || !value.skills.every(isSkill))
    throw new AgentMarketplaceError(400, "invalid_agent", "Invalid agent skills.");
  if (
    !Array.isArray(value.routines) ||
    value.routines.length > INPUT_LIMITS.agentRoutines ||
    !value.routines.every(isRoutine)
  )
    throw new AgentMarketplaceError(400, "invalid_agent", "Invalid agent routines.");
  return {
    botId: value.botId,
    name,
    title,
    description,
    avatarSeed: value.avatarSeed,
    avatarHue: value.avatarHue,
    avatarUrl: null,
    skills: value.skills,
    routines: value.routines,
  };
}

function text(value: unknown, field: string, limit: number, required: boolean): string {
  if (!isString(value)) throw new AgentMarketplaceError(400, "invalid_agent", `Invalid agent ${field}.`);
  const result = value.trim();
  if ((required && !result) || result.length > limit)
    throw new AgentMarketplaceError(400, "invalid_agent", `Invalid agent ${field}.`);
  return result;
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
    value.name.trim().length > 0 &&
    value.name.length <= INPUT_LIMITS.routineName &&
    isString(value.instruction) &&
    value.instruction.trim().length > 0 &&
    value.instruction.length <= INPUT_LIMITS.routineInstruction &&
    isBoolean(value.active) &&
    isRoutineSchedule(value.schedule)
  );
}

function dependencies(row: AgentRow) {
  const skills = JSON.parse(row.skills_json);
  const routines = JSON.parse(row.routines_json);
  if (!Array.isArray(skills) || !skills.every(isSkill) || !Array.isArray(routines) || !routines.every(isRoutine))
    throw new AgentMarketplaceError(500, "invalid_snapshot", "The stored agent snapshot is invalid.");
  return { skills, routines };
}

function avatarUrl(row: AgentRow): string | null {
  const agentId = row.agent_id ?? row.id;
  const versionId = row.version_id ?? (row.agent_id ? row.id : undefined);
  return row.avatar_key ? `/v1/marketplace/agents/${agentId}/avatar${versionId ? `?v=${versionId}` : ""}` : null;
}

function publicSummary(row: AgentRow): MarketplaceAgentSummary {
  const { skills, routines } = dependencies(row);
  return {
    id: row.agent_id ?? row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    creatorName: row.creator_name?.trim() || row.creator_email,
    version: row.version,
    installs: row.installs,
    featured: row.featured === 1,
    avatarSeed: row.avatar_seed,
    avatarHue: row.avatar_hue !== null && isAvatarHue(row.avatar_hue) ? row.avatar_hue : null,
    avatarUrl: avatarUrl(row),
    skillCount: skills.length,
    routineCount: routines.length,
    activeRoutineCount: routines.filter((routine) => routine.active).length,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function publicDetail(row: AgentRow): MarketplaceAgentDetail {
  return { ...publicSummary(row), versionId: row.version_id ?? row.id, ...dependencies(row) };
}

function submission(row: AgentRow): AgentSubmission {
  const { skills, routines } = dependencies(row);
  if (!isOneOf(["pending", "approved", "rejected"], row.status))
    throw new AgentMarketplaceError(500, "invalid_submission", "The stored agent submission is invalid.");
  return {
    id: row.id,
    agentId: row.agent_id ?? row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    version: row.version,
    status: row.status,
    rejectionNote: row.rejection_note ?? null,
    avatarSeed: row.avatar_seed,
    avatarHue: row.avatar_hue !== null && isAvatarHue(row.avatar_hue) ? row.avatar_hue : null,
    avatarUrl: avatarUrl(row),
    skillCount: skills.length,
    routineCount: routines.length,
    activeRoutineCount: routines.filter((routine) => routine.active).length,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
