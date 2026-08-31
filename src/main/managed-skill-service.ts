import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotSummary } from "@openbot/contracts/ipc";

const MANAGED_SKILL_SLUG = "openbot-site-hosting";

export class ManagedSkillService {
  #content: string | null = null;

  constructor(private readonly sourcePath: string) {}

  async syncAll(bots: BotSummary[]): Promise<void> {
    const content = await this.content();
    await Promise.all(bots.map((bot) => syncTargets(bot.workspacePath, content)));
  }

  async syncBot(bot: BotSummary): Promise<void> {
    await syncTargets(bot.workspacePath, await this.content());
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

async function syncTargets(workspacePath: string, content: string): Promise<void> {
  await Promise.all(
    [
      join(workspacePath, ".agents", "skills", MANAGED_SKILL_SLUG, "SKILL.md"),
      join(workspacePath, ".claude", "skills", MANAGED_SKILL_SLUG, "SKILL.md"),
    ].map((target) => atomicWrite(target, content)),
  );
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}
