import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BotSummary } from "@openbot/contracts/ipc";

const MANAGED_SKILL_SLUG = "openbot-site-hosting";
const OWNERSHIP_MARKER = ".openbot-managed.json";
const OWNERSHIP_CONTENT = `${JSON.stringify({ managedBy: "openbot", slug: MANAGED_SKILL_SLUG, version: 1 })}\n`;

interface SyncTargetsResult {
  collisions: string[];
  failures: { target: string; error: unknown }[];
}

export class ManagedSkillService {
  #content: string | null = null;

  constructor(
    private readonly sourcePath: string,
    private readonly reportCollision: (target: string) => void = (target) => {
      console.warn(`OpenBot preserved an unowned managed-skill collision at ${target}.`);
    },
    private readonly reportFailure: (target: string, error: unknown) => void = (target, error) => {
      console.error(`OpenBot could not synchronize the managed skill at ${target}.`, error);
    },
  ) {}

  async syncAll(bots: BotSummary[]): Promise<void> {
    let content: string;
    try {
      content = await this.content();
    } catch (error) {
      this.reportFailure(this.sourcePath, error);
      return;
    }
    const results = await Promise.allSettled(bots.map((bot) => syncTargets(bot.workspacePath, content)));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "fulfilled") {
        this.reportResult(result.value);
      } else {
        this.reportFailure(bots[index]?.workspacePath ?? "unknown workspace", result.reason);
      }
    }
  }

  async syncBot(bot: BotSummary): Promise<void> {
    try {
      this.reportResult(await syncTargets(bot.workspacePath, await this.content()));
    } catch (error) {
      this.reportFailure(bot.workspacePath, error);
    }
  }

  private async content(): Promise<string> {
    if (this.#content !== null) return this.#content;
    const content = await readFile(this.sourcePath, "utf8");
    if (!content.startsWith("---\nname: openbot-site-hosting\n")) {
      throw new Error("The managed site hosting skill is invalid.");
    }
    this.#content = content;
    return content;
  }

  private reportResult(result: SyncTargetsResult): void {
    for (const target of result.collisions) this.reportCollision(target);
    for (const failure of result.failures) this.reportFailure(failure.target, failure.error);
  }
}

async function syncTargets(workspacePath: string, content: string): Promise<SyncTargetsResult> {
  const workspaceRoot = await realpath(resolve(workspacePath));
  const targets = [
    join(workspacePath, ".agents", "skills", MANAGED_SKILL_SLUG, "SKILL.md"),
    join(workspacePath, ".claude", "skills", MANAGED_SKILL_SLUG, "SKILL.md"),
  ];
  const resolvedTargets = [
    join(workspaceRoot, ".agents", "skills", MANAGED_SKILL_SLUG, "SKILL.md"),
    join(workspaceRoot, ".claude", "skills", MANAGED_SKILL_SLUG, "SKILL.md"),
  ];
  const results = await Promise.allSettled(resolvedTargets.map((target) => syncTarget(workspaceRoot, target, content)));
  const collisions: string[] = [];
  const failures: SyncTargetsResult["failures"] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const target = targets[index];
    if (!result || !target) continue;
    if (result.status === "rejected") failures.push({ target, error: result.reason });
    else if (result.value === "collision") collisions.push(target);
  }
  return { collisions, failures };
}

async function syncTarget(workspaceRoot: string, target: string, content: string): Promise<"synced" | "collision"> {
  const parent = dirname(target);
  await ensureSafeDirectory(workspaceRoot, parent);
  const marker = join(parent, OWNERSHIP_MARKER);
  await rejectSymlink(target);
  await rejectSymlink(marker);
  if (await fileExists(target)) {
    if ((await optionalText(marker)) !== OWNERSHIP_CONTENT) return "collision";
    await atomicWrite(workspaceRoot, target, content);
    return "synced";
  }
  try {
    await verifySafeDirectory(workspaceRoot, parent);
    await writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (isFileExistsError(error)) return "collision";
    throw error;
  }
  try {
    await atomicWrite(workspaceRoot, marker, OWNERSHIP_CONTENT);
  } catch (error) {
    await verifySafeDirectory(workspaceRoot, parent)
      .then(() => unlink(target))
      .catch(() => undefined);
    throw error;
  }
  return "synced";
}

async function atomicWrite(workspaceRoot: string, target: string, content: string): Promise<void> {
  const parent = dirname(target);
  await verifySafeDirectory(workspaceRoot, parent);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  try {
    await verifySafeDirectory(workspaceRoot, parent);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function ensureSafeDirectory(workspaceRoot: string, directory: string): Promise<void> {
  const path = containedRelativePath(workspaceRoot, directory);
  let current = workspaceRoot;
  for (const segment of path.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
    }
    await requireRealDirectory(current);
  }
  await verifySafeDirectory(workspaceRoot, directory);
}

async function verifySafeDirectory(workspaceRoot: string, directory: string): Promise<void> {
  const path = containedRelativePath(workspaceRoot, directory);
  await requireRealDirectory(workspaceRoot);
  let current = workspaceRoot;
  for (const segment of path.split(sep).filter(Boolean)) {
    current = join(current, segment);
    await requireRealDirectory(current);
  }
  const resolvedDirectory = await realpath(directory);
  if (!isInside(workspaceRoot, resolvedDirectory)) {
    throw new Error(`Managed skill target escapes its workspace: ${directory}`);
  }
}

function containedRelativePath(workspaceRoot: string, candidate: string): string {
  const path = relative(workspaceRoot, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Managed skill target escapes its workspace: ${candidate}`);
  }
  return path;
}

async function requireRealDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Managed skill path must be a real directory: ${path}`);
  }
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Managed skill path cannot be a symlink: ${path}`);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
