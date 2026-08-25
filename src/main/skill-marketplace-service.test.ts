// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotSummary } from "@openbot/contracts/ipc";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CentralAuthManager } from "./central-auth-manager";
import { SkillMarketplaceService } from "./skill-marketplace-service";

const encoder = new TextEncoder();
let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-skills-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("SkillMarketplaceService", () => {
  it("installs into both provider directories and protects modified files", async () => {
    const bundle = zipSync({
      "SKILL.md": encoder.encode("---\nname: Release Notes\ndescription: Writes release notes.\n---\n"),
      "references/template.md": encoder.encode("Template"),
    });
    const hash = createHash("sha256").update(bundle).digest("hex");
    const sessionPath = join(root, "session.bin");
    await writeFile(
      sessionPath,
      Buffer.from(JSON.stringify({ version: 2, sessionToken: "token", teamHostTokens: {} })).toString("base64"),
    );
    const requests: string[] = [];
    const auth = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: sessionPath,
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        requests.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/v1/me")
          return Response.json({ id: "user-1", email: "ada@example.com", name: "Ada", avatarUrl: null });
        if (path === "/v1/skills/skill-1")
          return Response.json({
            id: "skill-1",
            slug: "release-notes",
            name: "Release Notes",
            description: "Writes release notes.",
            category: "documents",
            creatorName: "Ada",
            version: 1,
            installs: 0,
            featured: true,
            iconUrl: null,
            updatedAt: "2026-08-25T00:00:00.000Z",
            versionId: "version-1",
            bundleSha256: hash,
            files: ["SKILL.md", "references/template.md"],
            instructions: "Writes release notes.",
          });
        if (path.endsWith("/content")) {
          return new Response(Uint8Array.from(bundle).buffer, {
            headers: { "Content-Type": "application/zip" },
          });
        }
        if (path.endsWith("/install")) return Response.json({ installed: true });
        return new Response(null, { status: 404 });
      },
    });
    await auth.initialize();
    const bot: BotSummary = {
      id: "writer",
      name: "Writer",
      title: "",
      description: "",
      notifications: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: null,
      workspacePath: join(root, "writer"),
      preview: "",
      updatedAt: null,
      avatarSeed: "writer",
      avatarHue: null,
      avatarUrl: null,
    };
    const refreshedBots: string[] = [];
    const service = new SkillMarketplaceService(
      auth,
      () => [bot],
      async (botId) => {
        refreshedBots.push(botId);
      },
    );

    await expect(service.install({ botId: bot.id, skillId: "skill-1" })).resolves.toMatchObject({ state: "installed" });
    await expect(
      readFile(join(bot.workspacePath, ".agents", "skills", "release-notes", "SKILL.md"), "utf8"),
    ).resolves.toContain("Release Notes");
    await expect(
      readFile(join(bot.workspacePath, ".claude", "skills", "release-notes", "SKILL.md"), "utf8"),
    ).resolves.toContain("Release Notes");
    expect(requests).toContain("POST /v1/skills/skill-1/install");
    expect(refreshedBots).toEqual([bot.id]);

    await writeFile(join(bot.workspacePath, ".agents", "skills", "release-notes", "SKILL.md"), "locally changed");
    await expect(service.listInstalled(bot.id)).resolves.toEqual([expect.objectContaining({ state: "modified" })]);
    await expect(service.uninstall({ botId: bot.id, skillId: "skill-1" })).rejects.toThrow("local changes");
    await expect(
      service.uninstall({ botId: bot.id, skillId: "skill-1", removeModified: true }),
    ).resolves.toBeUndefined();
    expect(refreshedBots).toEqual([bot.id, bot.id]);
  });
});
