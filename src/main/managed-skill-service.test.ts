import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    await mkdir(workspacePath);
    const managedBot = bot(workspacePath);

    await new ManagedSkillService(source).syncBot(managedBot);

    await expect(
      readFile(join(workspacePath, ".agents", "skills", "openbot-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    await expect(
      readFile(join(workspacePath, ".claude", "skills", "openbot-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);

    const updated = content.replace("Rules", "Updated rules");
    await writeFile(source, updated);
    await new ManagedSkillService(source).syncBot(managedBot);
    await expect(
      readFile(join(workspacePath, ".agents", "skills", "openbot-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(updated);
  });

  it("preserves and reports an unowned skill collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-managed-skill-"));
    roots.push(root);
    const source = join(root, "SKILL.md");
    const content = "---\nname: openbot-site-hosting\ndescription: Host static sites.\n---\n\nRules\n";
    const userContent = "---\nname: openbot-site-hosting\ndescription: User skill.\n---\n\nKeep this file.\n";
    await writeFile(source, content);
    const workspacePath = join(root, "workspace");
    const userTarget = join(workspacePath, ".agents", "skills", "openbot-site-hosting", "SKILL.md");
    await mkdir(join(workspacePath, ".agents", "skills", "openbot-site-hosting"), { recursive: true });
    await writeFile(userTarget, userContent);
    const collisions: string[] = [];

    await new ManagedSkillService(source, (target) => collisions.push(target)).syncBot(bot(workspacePath));

    await expect(readFile(userTarget, "utf8")).resolves.toBe(userContent);
    await expect(
      readFile(join(workspacePath, ".claude", "skills", "openbot-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    expect(collisions).toEqual([userTarget]);
  });

  it("continues synchronization when one workspace target is inaccessible", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-managed-skill-"));
    roots.push(root);
    const source = join(root, "SKILL.md");
    const content = "---\nname: openbot-site-hosting\ndescription: Host static sites.\n---\n\nRules\n";
    await writeFile(source, content);
    const blockedWorkspace = join(root, "blocked-workspace");
    const healthyWorkspace = join(root, "healthy-workspace");
    await mkdir(blockedWorkspace, { recursive: true });
    await mkdir(healthyWorkspace, { recursive: true });
    await writeFile(join(blockedWorkspace, ".agents"), "This path is not a directory.");
    const failures: string[] = [];
    const service = new ManagedSkillService(
      source,
      () => undefined,
      (target) => failures.push(target),
    );

    await expect(service.syncAll([bot(blockedWorkspace), bot(healthyWorkspace)])).resolves.toBeUndefined();

    await expect(
      readFile(join(blockedWorkspace, ".claude", "skills", "openbot-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    await expect(
      readFile(join(healthyWorkspace, ".agents", "skills", "openbot-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    await expect(
      readFile(join(healthyWorkspace, ".claude", "skills", "openbot-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    expect(failures).toEqual([join(blockedWorkspace, ".agents", "skills", "openbot-site-hosting", "SKILL.md")]);
  });

  it("rejects managed-skill directories that are symlinks outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-managed-skill-"));
    roots.push(root);
    const source = join(root, "SKILL.md");
    const content = "---\nname: openbot-site-hosting\ndescription: Host static sites.\n---\n\nRules\n";
    await writeFile(source, content);
    const workspacePath = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspacePath);
    await mkdir(outside);
    await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
    await symlink(outside, join(workspacePath, ".agents", "skills", "openbot-site-hosting"));
    const failures: string[] = [];

    await new ManagedSkillService(
      source,
      () => undefined,
      (target) => failures.push(target),
    ).syncBot(bot(workspacePath));

    await expect(readFile(join(outside, "SKILL.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(workspacePath, ".claude", "skills", "openbot-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    expect(failures).toEqual([join(workspacePath, ".agents", "skills", "openbot-site-hosting", "SKILL.md")]);
  });
});

function bot(workspacePath: string): BotSummary {
  return {
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
}
