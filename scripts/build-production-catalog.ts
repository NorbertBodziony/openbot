import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BotAvatarHue, isAvatarHue, isSkillCategory, type SkillCategory } from "@openbot/contracts/ipc";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { unzipSync, zipSync } from "fflate";
import { parse as parseYaml } from "yaml";

const logger = createOpenBotLogger("build-production-catalog");

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptRoot, "..");
const sourceRoot = join(projectRoot, "marketplace", "production-catalog");
const defaultOutput = join(projectRoot, "out", "marketplace-production", "v1");
const zipTimestamp = new Date("1980-01-01T00:00:00.000Z");
const dependencyPattern =
  /(?:\bMCP\b|\bconnectors?\b|https?:\/\/|\b(?:npm|pnpm|yarn|bun|pipx?|uv|brew|apt(?:-get)?|cargo)\s+(?:add|install)\b)/iu;

interface UpstreamSource {
  repository: string;
  commit: string;
}

interface SkillSpec {
  slug: string;
  category: SkillCategory;
  source: "openai" | "anthropic";
  upstreamSkill: string;
}

interface AgentSpec {
  slug: string;
  name: string;
  title: string;
  description: string;
  avatarHue: BotAvatarHue;
  skills: string[];
}

interface CatalogSpec {
  schemaVersion: number;
  catalogVersion: string;
  sources: Record<SkillSpec["source"], UpstreamSource>;
  skills: SkillSpec[];
  agents: AgentSpec[];
}

interface BuiltSkill {
  id: string;
  versionId: string;
  slug: string;
  name: string;
  description: string;
  category: SkillCategory;
  version: number;
  bundle: string;
  bundleSha256: string;
  files: string[];
  license: "Apache-2.0";
  source: {
    provider: SkillSpec["source"];
    upstreamSkill: string;
    repository: string;
    commit: string;
    url: string;
  };
}

export async function buildProductionCatalog(outputArgument = defaultOutput): Promise<string> {
  const output = resolve(outputArgument);
  validateOutputTarget(output);
  const spec = await loadCatalogSpec();
  const version = catalogVersionNumber(spec.catalogVersion);
  const license = await readFile(join(sourceRoot, "licenses", "APACHE-2.0.txt"), "utf8");
  const staging = await mkdtemp(join(tmpdir(), "openbot-production-catalog-"));

  try {
    const skillOutput = join(staging, "skills");
    await mkdir(skillOutput, { recursive: true });
    const builtSkills: BuiltSkill[] = [];

    for (const skill of spec.skills) {
      const markdown = await readFile(join(sourceRoot, "skills", skill.slug, "SKILL.md"), "utf8");
      validateSkillMarkdown(skill.slug, markdown);
      const upstream = spec.sources[skill.source];
      const notice = createSkillNotice(skill, upstream);
      const archive = zipSync(
        {
          "LICENSE.txt": [utf8Bytes(license), { mtime: zipTimestamp }],
          "NOTICE.txt": [utf8Bytes(notice), { mtime: zipTimestamp }],
          "SKILL.md": [utf8Bytes(markdown), { mtime: zipTimestamp }],
        },
        { level: 9 },
      );
      const preview = inspectGeneratedArchive(archive);
      if (preview.slug !== skill.slug) {
        throw new Error(`Skill folder ${skill.slug} does not match its SKILL.md name (${preview.slug}).`);
      }
      const bundle = `skills/${skill.slug}.zip`;
      await writeFile(join(staging, bundle), archive);
      const bundleSha256 = sha256(archive);
      builtSkills.push({
        id: skillId(skill.slug),
        versionId: skillVersionId(skill.slug, version, bundleSha256),
        slug: skill.slug,
        name: preview.name,
        description: preview.description,
        category: skill.category,
        version,
        bundle,
        bundleSha256,
        files: preview.files,
        license: "Apache-2.0",
        source: {
          provider: skill.source,
          upstreamSkill: skill.upstreamSkill,
          repository: upstream.repository,
          commit: upstream.commit,
          url: upstreamSkillUrl(skill, upstream),
        },
      });
    }

    const catalog = {
      schemaVersion: spec.schemaVersion,
      catalogVersion: spec.catalogVersion,
      sources: spec.sources,
      skills: builtSkills,
    };
    const agents = {
      schemaVersion: spec.schemaVersion,
      catalogVersion: spec.catalogVersion,
      agents: spec.agents.map((agent) => buildAgent(agent, builtSkills, version)),
    };
    const notices = createUpstreamNotices(spec, builtSkills);
    await writeFile(join(staging, "catalog.json"), stableJson(catalog));
    await writeFile(join(staging, "agents.json"), stableJson(agents));
    await writeFile(join(staging, "UPSTREAM_NOTICES.md"), notices);

    const checksumPaths = (await listRelativeFiles(staging)).filter((path) => path !== "SHA256SUMS");
    const checksums = await Promise.all(
      checksumPaths.map(async (path) => `${sha256(await readFile(join(staging, path)))}  ${path}`),
    );
    await writeFile(join(staging, "SHA256SUMS"), `${checksums.join("\n")}\n`);
    await publishStaging(staging, output);
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function validateSkillMarkdown(slug: string, markdown: string): void {
  if (!markdown.startsWith("---\n")) throw new Error(`${slug}/SKILL.md must start with YAML frontmatter.`);
  if (dependencyPattern.test(markdown)) {
    throw new Error(`${slug}/SKILL.md requires a forbidden external dependency or network resource.`);
  }
}

function inspectGeneratedArchive(archive: Uint8Array) {
  if (archive.byteLength === 0 || archive.byteLength > 10 * 1024 * 1024) {
    throw new Error("Generated skill archive exceeds the marketplace size limit.");
  }
  const entries = unzipSync(archive);
  const files = Object.keys(entries).sort();
  if (files.join("\n") !== "LICENSE.txt\nNOTICE.txt\nSKILL.md") {
    throw new Error(
      `Generated skill archive contains ${files.length} unexpected files: ${files.slice(0, 10).join(", ")}.`,
    );
  }
  const skillFile = entries["SKILL.md"];
  if (!skillFile) throw new Error("Generated skill archive is missing SKILL.md.");
  const markdown = new TextDecoder("utf-8", { fatal: true }).decode(skillFile);
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) throw new Error("Generated SKILL.md has invalid frontmatter.");
  const metadata = parseYaml(match[1] ?? "");
  if (!isDynamicRecord(metadata)) throw new Error("Generated SKILL.md metadata is invalid.");
  const name = isString(metadata.name) ? metadata.name.trim() : "";
  const description = isString(metadata.description) ? metadata.description.trim() : "";
  if (!name || name.length > 80 || !description || description.length > 500) {
    throw new Error("Generated SKILL.md exceeds marketplace metadata limits.");
  }
  return { name, description, slug: slugify(name), files };
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 64);
  if (!slug) throw new Error("Generated skill name cannot form a valid slug.");
  return slug;
}

function buildAgent(agent: AgentSpec, skills: BuiltSkill[], version: number) {
  const selected = agent.skills.map((slug) => {
    const skill = skills.find((candidate) => candidate.slug === slug);
    if (!skill) throw new Error(`Agent ${agent.slug} references unknown skill ${slug}.`);
    return {
      skillId: skill.id,
      versionId: skill.versionId,
      slug: skill.slug,
      name: skill.name,
      version: skill.version,
    };
  });
  const snapshot = {
    id: `openbot-curated-agent-${agent.slug}`,
    slug: agent.slug,
    name: agent.name,
    title: agent.title,
    description: agent.description,
    avatarSeed: `openbot-curated-agent-${agent.slug}`,
    avatarHue: agent.avatarHue,
    version,
    skills: selected,
    routines: [],
  };
  const snapshotHash = sha256(JSON.stringify(snapshot));
  return {
    ...snapshot,
    versionId: `openbot-curated-agent-version-${agent.slug}-v${version}-${snapshotHash.slice(0, 16)}`,
  };
}

async function loadCatalogSpec(): Promise<CatalogSpec> {
  const raw = JSON.parse(await readFile(join(sourceRoot, "catalog.json"), "utf8"));
  if (!isDynamicRecord(raw) || raw.schemaVersion !== 1 || !isString(raw.catalogVersion)) {
    throw new Error("Production catalog metadata is invalid.");
  }
  const sources = parseSources(raw.sources);
  if (!Array.isArray(raw.skills) || !Array.isArray(raw.agents)) {
    throw new Error("Production catalog skills and agents must be arrays.");
  }
  const skills = raw.skills.map(parseSkillSpec);
  const duplicateSkill = skills.find((skill, index) => skills.findIndex((item) => item.slug === skill.slug) !== index);
  if (duplicateSkill) throw new Error(`Duplicate production skill slug: ${duplicateSkill.slug}.`);
  return {
    schemaVersion: raw.schemaVersion,
    catalogVersion: raw.catalogVersion,
    sources,
    skills,
    agents: raw.agents.map(parseAgentSpec),
  };
}

function parseSources(value: unknown): CatalogSpec["sources"] {
  if (!isDynamicRecord(value)) throw new Error("Production catalog sources are invalid.");
  return {
    openai: parseSource(value.openai, "openai"),
    anthropic: parseSource(value.anthropic, "anthropic"),
  };
}

function parseSource(value: unknown, name: string): UpstreamSource {
  if (
    !isDynamicRecord(value) ||
    !isString(value.repository) ||
    !isString(value.commit) ||
    !/^[a-f0-9]{40}$/u.test(value.commit)
  ) {
    throw new Error(`Production catalog source ${name} is invalid.`);
  }
  return { repository: value.repository, commit: value.commit };
}

function parseSkillSpec(value: unknown): SkillSpec {
  if (
    !isDynamicRecord(value) ||
    !isString(value.slug) ||
    !isSkillCategory(value.category) ||
    (value.source !== "openai" && value.source !== "anthropic") ||
    !isString(value.upstreamSkill)
  ) {
    throw new Error("Production catalog contains an invalid skill.");
  }
  return { slug: value.slug, category: value.category, source: value.source, upstreamSkill: value.upstreamSkill };
}

function parseAgentSpec(value: unknown): AgentSpec {
  if (
    !isDynamicRecord(value) ||
    !isString(value.slug) ||
    !isString(value.name) ||
    !isString(value.title) ||
    !isString(value.description) ||
    !isNumber(value.avatarHue) ||
    !isAvatarHue(value.avatarHue) ||
    !Array.isArray(value.skills) ||
    !value.skills.every(isString)
  ) {
    throw new Error("Production catalog contains an invalid agent.");
  }
  return {
    slug: value.slug,
    name: value.name,
    title: value.title,
    description: value.description,
    avatarHue: value.avatarHue,
    skills: value.skills,
  };
}

function createSkillNotice(skill: SkillSpec, upstream: UpstreamSource): string {
  return `OpenBot production catalog\n\nThis skill is an OpenBot-authored derivative of ${skill.upstreamSkill}\nfrom ${upstream.repository} at commit ${upstream.commit}.\n\nThe instructions were modified for brand-neutral use, reduced to prompt-only content,\nand stripped of external service, connector, executable, and package requirements.\n\nUpstream source: ${upstreamSkillUrl(skill, upstream)}\nLicense: Apache License 2.0 (included as LICENSE.txt)\n`;
}

function createUpstreamNotices(spec: CatalogSpec, skills: BuiltSkill[]): string {
  const entries = skills.map(
    (skill) =>
      `- **${skill.slug}** — derivative of [${skill.source.upstreamSkill}](${skill.source.url}) from ${skill.source.provider} commit \`${skill.source.commit}\`.`,
  );
  return `# Upstream Notices\n\nThis catalog contains OpenBot-authored derivatives of skills from the pinned OpenAI and Anthropic repositories. Each generated bundle includes the Apache License 2.0 and a modification notice.\n\n${entries.join("\n")}\n\nCatalog version: \`${spec.catalogVersion}\`\n`;
}

function upstreamSkillUrl(skill: SkillSpec, upstream: UpstreamSource): string {
  const segment = skill.source === "openai" ? "skills/.curated" : "skills";
  return `${upstream.repository}/tree/${upstream.commit}/${segment}/${skill.upstreamSkill}`;
}

function skillId(slug: string): string {
  return `openbot-curated-skill-${slug}`;
}

function skillVersionId(slug: string, version: number, bundleSha256: string): string {
  return `openbot-curated-version-${slug}-v${version}-${bundleSha256.slice(0, 16)}`;
}

function catalogVersionNumber(value: string): number {
  const match = /^v([1-9]\d*)$/u.exec(value);
  if (!match?.[1]) throw new Error("Production catalog version must use the form v1, v2, and so on.");
  return Number.parseInt(match[1], 10);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateOutputTarget(output: string): void {
  const filesystemRoot = parse(output).root;
  const forbidden = new Set([filesystemRoot, resolve(homedir()), projectRoot, sourceRoot]);
  if (forbidden.has(output)) throw new Error(`Refusing to use unsafe output directory: ${output}`);
}

async function publishStaging(staging: string, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  if (!(await pathExists(output))) {
    await rename(staging, output);
    return;
  }
  const [stagedFiles, outputFiles] = await Promise.all([listRelativeFiles(staging), listRelativeFiles(output)]);
  if (stagedFiles.length !== outputFiles.length || stagedFiles.some((file, index) => file !== outputFiles[index])) {
    throw new Error(`Output directory already exists with different contents: ${output}`);
  }
  for (const file of stagedFiles) {
    const [staged, existing] = await Promise.all([readFile(join(staging, file)), readFile(join(output, file))]);
    if (!staged.equals(existing)) throw new Error(`Output directory already exists with different contents: ${output}`);
  }
}

async function listRelativeFiles(root: string, relative = ""): Promise<string[]> {
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(root, child)));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Catalog output contains an unsupported filesystem entry: ${child}`);
  }
  return files.sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isDynamicRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function parseArguments(args: string[]): string {
  if (args.includes("--help")) {
    process.stdout.write("Usage: bun run marketplace:build -- [--output <directory>]\n");
    process.exit(0);
  }
  if (args.length === 0) return defaultOutput;
  if (args.length === 2 && args[0] === "--output" && args[1]) return args[1];
  throw new Error("Usage: bun run marketplace:build -- [--output <directory>]");
}

if (import.meta.main) {
  buildProductionCatalog(parseArguments(process.argv.slice(2)))
    .then((output) => process.stdout.write(`Built production marketplace artifacts at ${output}.\n`))
    .catch((error) => {
      logger.error("Production catalog generation failed.", toLogValue(error));
      process.exitCode = 1;
    });
}
