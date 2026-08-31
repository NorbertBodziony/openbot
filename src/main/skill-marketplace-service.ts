import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type {
  BotSummary,
  InstalledSkill,
  InstallSkillInput,
  MarketplaceAgentSkill,
  MarketplaceSkillDetail,
  MarketplaceSkillPage,
  MarketplaceSkillQuery,
  MarketplaceSkillSummary,
  SkillPackagePreview,
  SkillSubmission,
  SubmitSkillInput,
  UninstallSkillInput,
} from "@openbot/contracts/ipc";
import { isSkillCategory } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { unzipSync, zipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import type { CentralAuthManager } from "./central-auth-manager";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;
const DRAFT_LIFETIME_MS = 30 * 60 * 1000;

interface Draft {
  bytes: Uint8Array;
  preview: SkillPackagePreview;
  createdAt: number;
}
interface LockEntry {
  skillId: string;
  versionId?: string;
  slug: string;
  name: string;
  version: number;
  bundleSha256: string;
  receiptId: string;
  files: Record<string, string>;
}
interface SkillsLock {
  version: 1;
  skills: Record<string, LockEntry>;
}

export class SkillMarketplaceService {
  readonly #drafts = new Map<string, Draft>();

  constructor(
    private readonly auth: CentralAuthManager,
    private readonly listBots: () => BotSummary[],
    private readonly refreshBotRuntime: (botId: string) => Promise<void> = async () => undefined,
  ) {}

  async list(query: MarketplaceSkillQuery = {}): Promise<MarketplaceSkillPage> {
    const params = new URLSearchParams();
    if (query.query) params.set("query", query.query);
    if (query.category) params.set("category", query.category);
    if (query.featured) params.set("featured", "true");
    if (query.sort) params.set("sort", query.sort);
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit) params.set("limit", String(query.limit));
    const page = await this.auth.requestAuthorized(`/v1/skills/?${params}`, { method: "GET" }, decodeSkillPage);
    return { ...page, skills: page.skills.map((skill) => ({ ...skill, iconUrl: this.absoluteUrl(skill.iconUrl) })) };
  }

  async get(skillId: string): Promise<MarketplaceSkillDetail> {
    const detail = await this.auth.requestAuthorized(
      `/v1/skills/${encodeURIComponent(skillId)}`,
      { method: "GET" },
      decodeSkillDetail,
    );
    return { ...detail, iconUrl: this.absoluteUrl(detail.iconUrl) };
  }

  async listMine(): Promise<SkillSubmission[]> {
    const submissions = await this.auth.requestAuthorized("/v1/skills/mine", { method: "GET" }, decodeSubmissions);
    return submissions.map((item) => ({ ...item, iconUrl: this.absoluteUrl(item.iconUrl) }));
  }

  async stage(path: string): Promise<SkillPackagePreview> {
    this.expireDrafts();
    const stats = await lstat(path);
    const bytes = stats.isDirectory() ? await archiveDirectory(path) : new Uint8Array(await readFile(path));
    const inspected = inspectArchive(bytes);
    const draftId = randomUUID();
    const preview = { draftId, ...inspected, size: bytes.byteLength };
    this.#drafts.set(draftId, { bytes, preview, createdAt: Date.now() });
    return preview;
  }

  async submit(input: SubmitSkillInput): Promise<SkillSubmission> {
    if (!isSkillCategory(input.category)) throw new Error("Unknown skill category.");
    const draft = this.#drafts.get(input.draftId);
    if (!draft || Date.now() - draft.createdAt > DRAFT_LIFETIME_MS)
      throw new Error("The selected skill package expired. Choose it again.");
    const form = new FormData();
    form.set("category", input.category);
    if (input.skillId) form.set("skillId", input.skillId);
    form.set(
      "bundle",
      new Blob([toArrayBuffer(draft.bytes)], { type: "application/zip" }),
      `${draft.preview.slug}.zip`,
    );
    if (input.icon)
      form.set("icon", new Blob([toArrayBuffer(input.icon.bytes)], { type: input.icon.mimeType }), "icon");
    const submission = await this.auth.requestAuthorized(
      "/v1/skills/",
      { method: "POST", body: form },
      decodeSubmission,
      30_000,
    );
    this.#drafts.delete(input.draftId);
    return { ...submission, iconUrl: this.absoluteUrl(submission.iconUrl) };
  }

  async listInstalled(botId: string): Promise<InstalledSkill[]> {
    const bot = this.requireBot(botId);
    const lock = await readLock(bot.workspacePath);
    const installed: InstalledSkill[] = [];
    for (const entry of Object.values(lock.skills)) {
      let availableVersion = entry.version;
      try {
        availableVersion = (await this.get(entry.skillId)).version;
      } catch {
        /* Keep local state usable offline. */
      }
      const state = await installedState(bot.workspacePath, entry);
      installed.push({
        skillId: entry.skillId,
        slug: entry.slug,
        name: entry.name,
        installedVersion: entry.version,
        availableVersion,
        state: state === "installed" && availableVersion > entry.version ? "update-available" : state,
      });
    }
    return installed.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listInstalledForChatTags(botId: string): Promise<InstalledSkill[]> {
    const bot = this.requireBot(botId);
    const lock = await readLock(bot.workspacePath);
    const installed: InstalledSkill[] = [];
    for (const entry of Object.values(lock.skills)) {
      installed.push({
        skillId: entry.skillId,
        slug: entry.slug,
        name: entry.name,
        installedVersion: entry.version,
        availableVersion: entry.version,
        state: await chatTagInstalledState(bot.workspacePath, entry),
      });
    }
    return installed.sort((a, b) => a.name.localeCompare(b.name));
  }

  async install(input: InstallSkillInput): Promise<InstalledSkill> {
    const bot = this.requireBot(input.botId);
    const detail = await this.get(input.skillId);
    const bundle = await this.auth.downloadAuthorized(`/v1/skills/${encodeURIComponent(input.skillId)}/content`);
    return this.installResolved(bot, detail, bundle, input.replaceModified);
  }

  async installVersion(input: {
    botId: string;
    skillId: string;
    versionId: string;
    replaceModified?: boolean;
  }): Promise<InstalledSkill> {
    const bot = this.requireBot(input.botId);
    const detail = await this.auth.requestAuthorized(
      `/v1/skills/${encodeURIComponent(input.skillId)}/versions/${encodeURIComponent(input.versionId)}`,
      { method: "GET" },
      decodeSkillDetail,
    );
    const bundle = await this.auth.downloadAuthorized(
      `/v1/skills/${encodeURIComponent(input.skillId)}/versions/${encodeURIComponent(input.versionId)}/content`,
    );
    return this.installResolved(bot, detail, bundle, input.replaceModified);
  }

  async listPublishable(botId: string): Promise<MarketplaceAgentSkill[]> {
    const bot = this.requireBot(botId);
    const lock = await readLock(bot.workspacePath);
    const result: MarketplaceAgentSkill[] = [];
    for (const entry of Object.values(lock.skills)) {
      const state = await installedState(bot.workspacePath, entry);
      if (state !== "installed") throw new Error(`${entry.name} has local changes or needs repair before publishing.`);
      let versionId = entry.versionId;
      if (!versionId) {
        const detail = await this.get(entry.skillId);
        if (detail.version !== entry.version)
          throw new Error(
            `${entry.name} was installed before exact-version tracking. Update or repair it before publishing.`,
          );
        versionId = detail.versionId;
      }
      result.push({
        skillId: entry.skillId,
        versionId,
        slug: entry.slug,
        name: entry.name,
        version: entry.version,
      });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async installResolved(
    bot: BotSummary,
    detail: MarketplaceSkillDetail,
    bundle: Uint8Array,
    replaceModified = false,
  ): Promise<InstalledSkill> {
    if (sha256(bundle) !== detail.bundleSha256)
      throw new Error("The downloaded skill did not match its signed catalog record.");
    const archive = inspectArchive(bundle);
    if (archive.slug !== detail.slug) throw new Error("The downloaded skill metadata does not match the catalog.");
    const files = normalizedFiles(bundle);
    const lock = await readLock(bot.workspacePath);
    const existing = lock.skills[detail.id];
    if (existing) {
      const state = await installedState(bot.workspacePath, existing);
      if (state === "modified" && !replaceModified)
        throw new Error("This skill has local changes. Confirm replacement to continue.");
    }
    for (const target of targetDirectories(bot.workspacePath, detail.slug)) {
      const owner = Object.values(lock.skills).find(
        (entry) => target.endsWith(`/${entry.slug}`) || target.endsWith(`\\${entry.slug}`),
      );
      if (!owner && (await pathExists(target))) throw new Error(`An unmanaged skill already exists at ${target}.`);
    }
    const receiptId = existing?.receiptId ?? randomUUID();
    await replaceTargets(bot.workspacePath, detail.slug, files);
    const entry: LockEntry = {
      skillId: detail.id,
      versionId: detail.versionId,
      slug: detail.slug,
      name: detail.name,
      version: detail.version,
      bundleSha256: detail.bundleSha256,
      receiptId,
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
    };
    lock.skills[detail.id] = entry;
    await writeLock(bot.workspacePath, lock);
    await this.auth.requestAuthorized(
      `/v1/skills/${encodeURIComponent(detail.id)}/install`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ receiptId }) },
      decodeInstalledReceipt,
    );
    await this.refreshBotRuntime(bot.id);
    return {
      skillId: detail.id,
      slug: detail.slug,
      name: detail.name,
      installedVersion: detail.version,
      availableVersion: detail.version,
      state: "installed",
    };
  }

  async uninstall(input: UninstallSkillInput): Promise<void> {
    const bot = this.requireBot(input.botId);
    const lock = await readLock(bot.workspacePath);
    const entry = lock.skills[input.skillId];
    if (!entry) return;
    if ((await installedState(bot.workspacePath, entry)) === "modified" && !input.removeModified) {
      throw new Error("This skill has local changes. Confirm removal to delete them.");
    }
    for (const target of targetDirectories(bot.workspacePath, entry.slug))
      await rm(target, { recursive: true, force: true });
    delete lock.skills[input.skillId];
    await writeLock(bot.workspacePath, lock);
    await this.refreshBotRuntime(input.botId);
  }

  private requireBot(botId: string): BotSummary {
    const bot = this.listBots().find((candidate) => candidate.id === botId);
    if (!bot) throw new Error("Choose a local agent first.");
    return bot;
  }

  private absoluteUrl(value: string | null): string | null {
    return value ? this.auth.resolveApiUrl(value) : null;
  }
  private expireDrafts(): void {
    for (const [id, draft] of this.#drafts)
      if (Date.now() - draft.createdAt > DRAFT_LIFETIME_MS) this.#drafts.delete(id);
  }
}

async function archiveDirectory(root: string): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".DS_Store") continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Skill packages cannot contain symbolic links.");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const name = relative(root, path).replaceAll("\\", "/");
        files[name] = new Uint8Array(await readFile(path));
        if (Object.keys(files).length > MAX_FILES) throw new Error(`A skill can contain at most ${MAX_FILES} files.`);
      }
    }
  }
  await visit(root);
  const bytes = zipSync(files, { level: 6 });
  if (bytes.byteLength > MAX_BYTES) throw new Error("The skill package must be under 10 MB.");
  return bytes;
}

function inspectArchive(bytes: Uint8Array): Omit<SkillPackagePreview, "draftId" | "size"> {
  const files = normalizedFiles(bytes);
  const skillFile = files["SKILL.md"];
  if (!skillFile) throw new Error("The skill package must contain SKILL.md at its root.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(skillFile);
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) throw new Error("SKILL.md must begin with YAML frontmatter.");
  const metadata = parseYaml(match[1] ?? "");
  if (!isDynamicRecord(metadata)) throw new Error("SKILL.md metadata is invalid.");
  const name = isString(metadata.name) ? metadata.name.trim() : "";
  const description = isString(metadata.description) ? metadata.description.trim() : "";
  if (!name || name.length > 80 || !description || description.length > 500)
    throw new Error("SKILL.md needs a valid name and description.");
  return { name, description, slug: slugify(name), files: Object.keys(files).sort() };
}

function normalizedFiles(bytes: Uint8Array): Record<string, Uint8Array> {
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error("The skill package must be under 10 MB.");
  let raw: Record<string, Uint8Array>;
  try {
    let expandedSize = 0;
    let fileCount = 0;
    raw = unzipSync(bytes, {
      filter: (file) => {
        fileCount += 1;
        expandedSize += file.originalSize;
        if (fileCount > MAX_FILES || expandedSize > MAX_BYTES) throw new Error("Archive limits exceeded.");
        return true;
      },
    });
  } catch {
    throw new Error("The selected ZIP is invalid.");
  }
  const entries = Object.entries(raw).filter(([name]) => !name.endsWith("/"));
  if (!entries.length || entries.length > MAX_FILES)
    throw new Error("The skill package has an invalid number of files.");
  const roots = new Set(entries.map(([name]) => name.replaceAll("\\", "/").split("/")[0]));
  const wrapper = roots.size === 1 && entries.every(([name]) => name.includes("/")) ? [...roots][0] : null;
  const result: Record<string, Uint8Array> = {};
  let size = 0;
  for (const [rawName, data] of entries) {
    const name = (wrapper ? rawName.slice((wrapper?.length ?? 0) + 1) : rawName).replaceAll("\\", "/");
    const parts = name.split("/");
    const file = parts.at(-1)?.toLowerCase() ?? "";
    if (
      !name ||
      name.startsWith("/") ||
      parts.some((part) => !part || part === "." || part === "..") ||
      parts.includes(".git") ||
      parts.includes("node_modules") ||
      file.startsWith(".env") ||
      /private.*key/iu.test(file) ||
      /\.(?:zip|tar|tgz|gz|7z|rar)$/iu.test(file)
    ) {
      throw new Error(`The skill package contains an unsafe file: ${name}`);
    }
    size += data.byteLength;
    if (size > MAX_BYTES) throw new Error("The expanded skill must be under 10 MB.");
    result[name] = data;
  }
  return result;
}

function slugify(name: string): string {
  const value = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 64);
  if (!value) throw new Error("The skill name cannot form a valid slug.");
  return value;
}

function targetDirectories(workspace: string, slug: string): string[] {
  return [join(workspace, ".agents", "skills", slug), join(workspace, ".claude", "skills", slug)];
}

async function replaceTargets(workspace: string, slug: string, files: Record<string, Uint8Array>): Promise<void> {
  const completed: Array<{ target: string; backup: string | null }> = [];
  try {
    for (const target of targetDirectories(workspace, slug)) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const stage = `${target}.openbot-stage-${randomUUID()}`;
      const backup = (await pathExists(target)) ? `${target}.openbot-backup-${randomUUID()}` : null;
      await writeFiles(stage, files);
      if (backup) await rename(target, backup);
      try {
        await rename(stage, target);
      } catch (error) {
        if (backup) await rename(backup, target);
        throw error;
      }
      completed.push({ target, backup });
    }
  } catch (error) {
    for (const item of completed.reverse()) {
      await rm(item.target, { recursive: true, force: true });
      if (item.backup) await rename(item.backup, item.target).catch(() => undefined);
    }
    throw error;
  }
  await Promise.all(
    completed.flatMap((item) => (item.backup ? [rm(item.backup, { recursive: true, force: true })] : [])),
  );
}

async function writeFiles(root: string, files: Record<string, Uint8Array>): Promise<void> {
  for (const [name, bytes] of Object.entries(files)) {
    const path = resolve(root, name);
    if (!path.startsWith(`${resolve(root)}/`) && !path.startsWith(`${resolve(root)}\\`))
      throw new Error("Unsafe skill path.");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
  }
}

async function installedState(workspace: string, entry: LockEntry): Promise<"installed" | "modified" | "needs-repair"> {
  let complete = 0;
  for (const target of targetDirectories(workspace, entry.slug)) {
    if (!(await pathExists(target))) continue;
    complete += 1;
    for (const [name, hash] of Object.entries(entry.files)) {
      try {
        if (sha256(new Uint8Array(await readFile(join(target, name)))) !== hash) return "modified";
      } catch {
        return "needs-repair";
      }
    }
  }
  return complete === 2 ? "installed" : "needs-repair";
}

async function chatTagInstalledState(workspace: string, entry: LockEntry): Promise<"installed" | "needs-repair"> {
  for (const target of targetDirectories(workspace, entry.slug)) {
    if (!(await pathExists(join(target, "SKILL.md")))) return "needs-repair";
  }
  return "installed";
}

function lockPath(workspace: string): string {
  return join(workspace, ".openbot", "skills-lock.json");
}
async function readLock(workspace: string): Promise<SkillsLock> {
  try {
    const value = JSON.parse(await readFile(lockPath(workspace), "utf8"));
    return isSkillsLock(value) ? value : { version: 1, skills: {} };
  } catch {
    return { version: 1, skills: {} };
  }
}
async function writeLock(workspace: string, lock: SkillsLock): Promise<void> {
  const path = lockPath(workspace);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function decodeSkillPage(value: unknown): MarketplaceSkillPage {
  if (!isDynamicRecord(value) || !Array.isArray(value.skills) || !value.skills.every(isMarketplaceSkillSummary))
    throw new Error("Invalid skill marketplace response.");
  if (value.nextCursor !== null && !isString(value.nextCursor)) throw new Error("Invalid skill marketplace response.");
  return { skills: value.skills, nextCursor: value.nextCursor };
}
function decodeSkillDetail(value: unknown): MarketplaceSkillDetail {
  if (!isMarketplaceSkillDetail(value)) throw new Error("Invalid skill detail response.");
  return value;
}
function decodeSubmissions(value: unknown): SkillSubmission[] {
  if (!Array.isArray(value) || !value.every(isSkillSubmission)) throw new Error("Invalid skill submissions.");
  return value;
}
function decodeSubmission(value: unknown): SkillSubmission {
  if (!isSkillSubmission(value)) throw new Error("Invalid skill submission response.");
  return value;
}
function decodeInstalledReceipt(value: unknown): { installed: true } {
  if (!isDynamicRecord(value) || value.installed !== true) throw new Error("Invalid install receipt response.");
  return { installed: true };
}

function isMarketplaceSkillSummary(value: unknown): value is MarketplaceSkillSummary {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.slug) &&
    isString(value.name) &&
    isString(value.description) &&
    isSkillCategory(value.category) &&
    isString(value.creatorName) &&
    isNumber(value.version) &&
    isNumber(value.installs) &&
    isBoolean(value.featured) &&
    (value.iconUrl === null || isString(value.iconUrl)) &&
    isString(value.updatedAt)
  );
}

function isMarketplaceSkillDetail(value: unknown): value is MarketplaceSkillDetail {
  return (
    isDynamicRecord(value) &&
    isMarketplaceSkillSummary(value) &&
    isString(value.versionId) &&
    isString(value.bundleSha256) &&
    isString(value.instructions) &&
    Array.isArray(value.files) &&
    value.files.every(isString)
  );
}

function isSkillSubmission(value: unknown): value is SkillSubmission {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.skillId) &&
    isString(value.slug) &&
    isString(value.name) &&
    isString(value.description) &&
    isSkillCategory(value.category) &&
    isNumber(value.version) &&
    isOneOf(["pending", "approved", "rejected"], value.status) &&
    (value.rejectionNote === null || isString(value.rejectionNote)) &&
    (value.iconUrl === null || isString(value.iconUrl)) &&
    isString(value.createdAt)
  );
}

function isLockEntry(value: unknown): value is LockEntry {
  return (
    isDynamicRecord(value) &&
    isString(value.skillId) &&
    (value.versionId === undefined || isString(value.versionId)) &&
    isString(value.slug) &&
    isString(value.name) &&
    isNumber(value.version) &&
    isString(value.bundleSha256) &&
    isString(value.receiptId) &&
    isDynamicRecord(value.files) &&
    Object.values(value.files).every(isString)
  );
}

function isSkillsLock(value: unknown): value is SkillsLock {
  return (
    isDynamicRecord(value) &&
    value.version === 1 &&
    isDynamicRecord(value.skills) &&
    Object.values(value.skills).every(isLockEntry)
  );
}
