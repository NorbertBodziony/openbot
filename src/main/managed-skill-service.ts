import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  const targets = [
    join(workspacePath, ".agents", "skills", MANAGED_SKILL_SLUG, "SKILL.md"),
    join(workspacePath, ".claude", "skills", MANAGED_SKILL_SLUG, "SKILL.md"),
  ];
  const results = await Promise.allSettled(targets.map((target) => syncTarget(target, content)));
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
