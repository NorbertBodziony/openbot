import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { buildProductionCatalog } from "./build-production-catalog";

const logger = createOpenBotLogger("publish-production-catalog");

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const authApiRoot = join(projectRoot, "apps", "auth-api");
const wrangler = join(authApiRoot, "node_modules", ".bin", "wrangler");
const productionApiUrl = "https://api.openbot.run";
const productionDatabase = "openbot-auth";
const productionBucket = "openbot-skills";
const owner = {
  id: "openbot-production-catalog",
  identityKey: "openbot-production-catalog",
  email: "catalog@openbot.run",
  name: "OpenBot",
} as const;

interface PublishedSkill {
  id: string;
  versionId: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  version: number;
  bundle: string;
  bundleSha256: string;
  files: string[];
}

interface PublishedAgent {
  id: string;
  versionId: string;
  name: string;
  title: string;
  description: string;
  avatarSeed: string;
  avatarHue: number;
  version: number;
  skills: unknown[];
  routines: unknown[];
}

export interface Publication {
  catalogVersion: string;
  skills: PublishedSkill[];
  agents: PublishedAgent[];
}

export function createPublicationSql(publication: Publication, publishedAt: number): string {
  const statements = [
    "PRAGMA foreign_keys = ON;",
    `INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at) VALUES (${sql(owner.id)}, ${sql(owner.identityKey)}, ${sql(owner.email)}, ${sql(owner.name)}, NULL, ${publishedAt}, ${publishedAt}) ON CONFLICT(id) DO UPDATE SET identity_key = excluded.identity_key, email = excluded.email, name = excluded.name, updated_at = excluded.updated_at;`,
  ];

  for (const skill of publication.skills) {
    const bundleKey = remoteBundleKey(skill);
    statements.push(
      `INSERT INTO marketplace_skills(id, slug, owner_user_id, approved_version_id, installs, featured, created_at, updated_at) VALUES (${sql(skill.id)}, ${sql(skill.slug)}, ${sql(owner.id)}, NULL, 0, 0, ${publishedAt}, ${publishedAt}) ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, owner_user_id = excluded.owner_user_id, updated_at = excluded.updated_at;`,
      `INSERT INTO marketplace_skill_versions(id, skill_id, version, name, description, category, status, rejection_note, bundle_key, bundle_sha256, files_json, icon_key, created_at, reviewed_at) VALUES (${sql(skill.versionId)}, ${sql(skill.id)}, ${skill.version}, ${sql(skill.name)}, ${sql(skill.description)}, ${sql(skill.category)}, 'approved', NULL, ${sql(bundleKey)}, ${sql(skill.bundleSha256)}, ${sql(JSON.stringify(skill.files))}, NULL, ${publishedAt}, ${publishedAt}) ON CONFLICT(id) DO NOTHING;`,
      `UPDATE marketplace_skills SET approved_version_id = ${sql(skill.versionId)}, updated_at = ${publishedAt} WHERE id = ${sql(skill.id)};`,
    );
  }

  for (const agent of publication.agents) {
    statements.push(
      `INSERT INTO marketplace_agents(id, owner_user_id, approved_version_id, installs, featured, created_at, updated_at) VALUES (${sql(agent.id)}, ${sql(owner.id)}, NULL, 0, 0, ${publishedAt}, ${publishedAt}) ON CONFLICT(id) DO UPDATE SET owner_user_id = excluded.owner_user_id, updated_at = excluded.updated_at;`,
      `INSERT INTO marketplace_agent_versions(id, agent_id, version, name, title, description, avatar_seed, avatar_hue, avatar_key, skills_json, routines_json, status, rejection_note, created_at, reviewed_at) VALUES (${sql(agent.versionId)}, ${sql(agent.id)}, ${agent.version}, ${sql(agent.name)}, ${sql(agent.title)}, ${sql(agent.description)}, ${sql(agent.avatarSeed)}, ${agent.avatarHue}, NULL, ${sql(JSON.stringify(agent.skills))}, ${sql(JSON.stringify(agent.routines))}, 'approved', NULL, ${publishedAt}, ${publishedAt}) ON CONFLICT(id) DO NOTHING;`,
      `UPDATE marketplace_agents SET approved_version_id = ${sql(agent.versionId)}, updated_at = ${publishedAt} WHERE id = ${sql(agent.id)};`,
    );
  }

  return `${statements.join("\n")}\n`;
}

export async function publishProductionCatalog(apply: boolean): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-production-publish-"));
  try {
    const artifactRoot = join(temporaryRoot, "artifacts");
    await buildProductionCatalog(artifactRoot);
    const publication = await readPublication(artifactRoot);
    if (!apply) {
      process.stdout.write(
        `Dry run: ${publication.skills.length} skills and ${publication.agents.length} agents from ${publication.catalogVersion} are ready for production under owner ${owner.name}.\n`,
      );
      process.stdout.write("No production resources were changed. Add --apply --confirm-production to publish.\n");
      return;
    }

    const token = process.env.SKILLS_ADMIN_TOKEN;
    if (!token) throw new Error("SKILLS_ADMIN_TOKEN is required for production publication.");
    await verifyProductionAdmin(token);

    for (const skill of publication.skills) {
      await run(wrangler, [
        "r2",
        "object",
        "put",
        `${productionBucket}/${remoteBundleKey(skill)}`,
        "--remote",
        "--file",
        join(artifactRoot, skill.bundle),
        "--content-type",
        "application/zip",
        "--force",
      ]);
    }

    const sqlPath = join(temporaryRoot, "publish.sql");
    await writeFile(sqlPath, createPublicationSql(publication, Date.now()));
    await run(wrangler, ["d1", "execute", productionDatabase, "--remote", "--file", sqlPath, "--yes"]);
    process.stdout.write(
      `Published ${publication.skills.length} skills and ${publication.agents.length} agents to production under owner ${owner.name}.\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyProductionAdmin(token: string): Promise<void> {
  const response = await fetch(new URL("/v1/skills/admin/submissions", productionApiUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Production admin verification failed with HTTP ${response.status}.`);
  }
}

async function readPublication(root: string): Promise<Publication> {
  const [catalogText, agentText] = await Promise.all([
    readFile(join(root, "catalog.json"), "utf8"),
    readFile(join(root, "agents.json"), "utf8"),
  ]);
  const catalogValue = JSON.parse(catalogText);
  const agentValue = JSON.parse(agentText);
  if (!isDynamicRecord(catalogValue) || !isString(catalogValue.catalogVersion) || !Array.isArray(catalogValue.skills)) {
    throw new Error("Generated production skill catalog is invalid.");
  }
  if (
    !isDynamicRecord(agentValue) ||
    agentValue.catalogVersion !== catalogValue.catalogVersion ||
    !Array.isArray(agentValue.agents)
  ) {
    throw new Error("Generated production agent catalog is invalid.");
  }
  return {
    catalogVersion: catalogValue.catalogVersion,
    skills: catalogValue.skills.map(parseSkill),
    agents: agentValue.agents.map(parseAgent),
  };
}

function parseSkill(value: unknown): PublishedSkill {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.versionId) ||
    !isString(value.slug) ||
    !isString(value.name) ||
    !isString(value.description) ||
    !isString(value.category) ||
    !isNumber(value.version) ||
    !isString(value.bundle) ||
    !isString(value.bundleSha256) ||
    !Array.isArray(value.files) ||
    !value.files.every(isString)
  ) {
    throw new Error("Generated production catalog contains an invalid skill.");
  }
  return {
    id: value.id,
    versionId: value.versionId,
    slug: value.slug,
    name: value.name,
    description: value.description,
    category: value.category,
    version: value.version,
    bundle: value.bundle,
    bundleSha256: value.bundleSha256,
    files: value.files,
  };
}

function parseAgent(value: unknown): PublishedAgent {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.versionId) ||
    !isString(value.name) ||
    !isString(value.title) ||
    !isString(value.description) ||
    !isString(value.avatarSeed) ||
    !isNumber(value.avatarHue) ||
    !isNumber(value.version) ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.routines)
  ) {
    throw new Error("Generated production catalog contains an invalid agent.");
  }
  return {
    id: value.id,
    versionId: value.versionId,
    name: value.name,
    title: value.title,
    description: value.description,
    avatarSeed: value.avatarSeed,
    avatarHue: value.avatarHue,
    version: value.version,
    skills: value.skills,
    routines: value.routines,
  };
}

function remoteBundleKey(skill: PublishedSkill): string {
  return `skills/${skill.id}/versions/${skill.versionId}.zip`;
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: authApiRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}.`),
        );
    });
  });
}

function parseArguments(args: string[]): boolean {
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: bun run marketplace:publish:production -- [--apply --confirm-production]\n\nWithout flags, the command performs an offline dry run. Production writes require both flags and SKILLS_ADMIN_TOKEN.\n",
    );
    process.exit(0);
  }
  if (args.length === 0) return false;
  if (args.length === 2 && args.includes("--apply") && args.includes("--confirm-production")) return true;
  throw new Error("Production publication requires both --apply and --confirm-production.");
}

if (import.meta.main) {
  publishProductionCatalog(parseArguments(process.argv.slice(2))).catch((error) => {
    logger.error("Production catalog publication failed.", toLogValue(error));
    process.exitCode = 1;
  });
}
