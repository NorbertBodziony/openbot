import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotSummary } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedSkillService } from "./managed-skill-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed site hosting skill", () => {
  it("synchronizes the managed skill for Codex, Grok, and Claude locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-managed-skill-"));
    roots.push(root);
    const source = join(root, "SKILL.md");
    const content = "---\nname: openbot-site-hosting\ndescription: Host static sites.\n---\n\nRules\n";
    await writeFile(source, content);
    const workspacePath = join(root, "workspace");
    const bot: BotSummary = {
      id: "bot-1",
      provider: "codex",
      name: "Builder",
      title: "Site builder",
      description: "Builds static sites.",
      notifications: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: "thread-1",
      workspacePath,
      preview: "",
      updatedAt: null,
      avatarSeed: "bot-1",
      avatarHue: null,
      avatarUrl: null,
    };

    await new ManagedSkillService(source).syncBot(bot);

    await expect(
      readFile(join(workspacePath, ".agents", "skills", "openbot-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    await expect(
      readFile(join(workspacePath, ".claude", "skills", "openbot-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
  });
});
