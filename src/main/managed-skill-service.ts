import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotSummary } from "@openbot/contracts/ipc";

const MANAGED_SKILL_SLUG = "openbot-site-hosting";
const OWNERSHIP_MARKER = ".openbot-managed.json";
const OWNERSHIP_CONTENT = `${JSON.stringify({ managedBy: "openbot", slug: MANAGED_SKILL_SLUG, version: 1 })}\n`;

export class ManagedSkillService {
  #content: string | null = null;

  constructor(
    private readonly sourcePath: string,
    private readonly reportCollision: (target: string) => void = (target) => {
      console.warn(`OpenBot preserved an unowned managed-skill collision at ${target}.`);
    },
  ) {}

  async syncAll(bots: BotSummary[]): Promise<void> {
    const content = await this.content();
    const collisions = (await Promise.all(bots.map((bot) => syncTargets(bot.workspacePath, content)))).flat();
    for (const target of collisions) this.reportCollision(target);
  }

  async syncBot(bot: BotSummary): Promise<void> {
    const collisions = await syncTargets(bot.workspacePath, await this.content());
    for (const target of collisions) this.reportCollision(target);
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
}

async function syncTargets(workspacePath: string, content: string): Promise<string[]> {
  const targets = [
    join(workspacePath, ".agents", "skills", MANAGED_SKILL_SLUG, "SKILL.md"),
    join(workspacePath, ".claude", "skills", MANAGED_SKILL_SLUG, "SKILL.md"),
  ];
  const results = await Promise.all(targets.map((target) => syncTarget(target, content)));
  return targets.filter((_, index) => results[index] === "collision");
}

async function syncTarget(target: string, content: string): Promise<"synced" | "collision"> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const marker = join(dirname(target), OWNERSHIP_MARKER);
  if (await fileExists(target)) {
    if ((await optionalText(marker)) !== OWNERSHIP_CONTENT) return "collision";
    await atomicWrite(target, content);
    return "synced";
  }
  try {
    await writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (isFileExistsError(error)) return "collision";
    throw error;
  }
  try {
    await atomicWrite(marker, OWNERSHIP_CONTENT);
  } catch (error) {
    await unlink(target).catch(() => undefined);
    throw error;
  }
  return "synced";
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
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
