// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotStore } from "./bot-store";

const temporaryRoots: string[] = [];
const BOT_PROFILE_INPUT = {
  name: "Planning Bot",
  description: "Builds clear plans for everyday tasks.",
  avatarSeed: "setup:planning",
  avatarHue: 215,
} as const;
const EMPTY_LAYOUT = {
  revision: 0,
  sections: [],
  order: ["people", "unassigned"],
  agentAssignments: {},
  agentOrder: [],
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("BotStore", () => {
  it("starts a new user with no agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "user-data"), join(root, "home"));

    await store.initialize();

    expect(store.list()).toEqual([]);
  });

  it("creates separate bot workspaces and a shared directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new BotStore(userData, home);

    await store.initialize();
    const chief = await store.getOrCreate("chief");
    const sales = await store.getOrCreate("sales-outbound");

    expect(chief.workspacePath).toBe(join(home, "OpenBot", "Bots", "chief"));
    expect(chief.description).toBe("");
    expect(chief.preview).toBe("No messages yet");
    expect(chief.model).toBe("gpt-5.6-luna");
    expect(chief.reasoningEffort).toBe("medium");
    expect(sales.workspacePath).toBe(join(home, "OpenBot", "Bots", "sales-outbound"));
    expect(store.sharedRoot).toBe(join(home, "OpenBot", "Shared"));
    expect(chief.workspacePath).not.toBe(sales.workspacePath);
  });

  it("persists stable OpenBot thread ids in SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const store = new BotStore(userData, join(root, "home"));
    await store.initialize();

    await store.getOrCreate("chief");
    const threadId = await store.ensureThreadId("chief");
    const restored = new BotStore(userData, join(root, "home"));
    await restored.initialize();
    expect(restored.list().find((bot) => bot.id === "chief")?.threadId).toBe(threadId);
    await expect(readFile(join(userData, "bots.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists marketplace installation versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new BotStore(userData, home);
    await store.initialize();
    const bot = await store.createBot(BOT_PROFILE_INPUT);

    store.setMarketplaceSource(bot.id, {
      agentId: "market-planner",
      versionId: "market-planner-v2",
      version: 2,
      skillIds: ["planning"],
      routineIds: ["routine-marketplace"],
    });

    const restored = new BotStore(userData, home);
    await restored.initialize();
    expect(restored.list().find((candidate) => candidate.id === bot.id)?.marketplaceSource).toEqual({
      agentId: "market-planner",
      versionId: "market-planner-v2",
      version: 2,
      skillIds: ["planning"],
      routineIds: ["routine-marketplace"],
    });
  });

  it("migrates version 1 avatars to stable id seeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const statePath = join(userData, "bots.json");
    await mkdir(userData, { recursive: true });
    const legacy = {
      version: 1,
      examplesInitialized: true,
      bots: [
        {
          id: "chief",
          name: "Chief",
          title: "Coordinator",
          description: "",
          notifications: true,
          model: "gpt-5.6-luna",
          reasoningEffort: "medium",
          threadId: "native-codex-thread",
          workspacePath: join(root, "home", "OpenBot", "Bots", "chief"),
          preview: "Hello",
          updatedAt: "2026-01-01T00:00:00.000Z",
          avatarShape: "cloud",
          avatarColor: "violet",
        },
      ],
    };
    await writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`);

    const restored = new BotStore(userData, join(root, "home"));
    await restored.initialize();

    expect(restored.list().find((bot) => bot.id === "chief")).toMatchObject({
      avatarSeed: "chief",
      avatarHue: null,
    });
    expect(restored.list()[0]?.threadId).toBe("openbot-thread-chief");
    expect(restored.activeProviderSession("chief")?.externalSessionId).toBe("native-codex-thread");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"version": 1');
    await expect(readFile(join(userData, "legacy-backup-v1", "bots.json"), "utf8")).resolves.toContain('"version": 1');
  });

  it("imports a version 2 agent file without changing the legacy source", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const statePath = join(userData, "bots.json");
    await mkdir(userData, { recursive: true });
    const legacy = {
      version: 2,
      examplesInitialized: true,
      bots: [
        {
          id: "writer",
          name: "Writer",
          title: "Writing",
          description: "Writes concise copy",
          notifications: false,
          model: "claude-sonnet-5",
          reasoningEffort: "high",
          threadId: null,
          workspacePath: join(root, "home", "OpenBot", "Bots", "writer"),
          preview: "No messages yet",
          updatedAt: null,
          avatarSeed: "writer",
          avatarHue: 215,
        },
      ],
    };
    const source = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(statePath, source);
    const store = new BotStore(userData, join(root, "home"));
    await store.initialize();

    expect(store.list()).toMatchObject([{ id: "writer", model: "claude-sonnet-5", threadId: null, avatarHue: 215 }]);
    await expect(readFile(statePath, "utf8")).resolves.toBe(source);
    await expect(readFile(join(userData, "legacy-backup-v1", "bots.json"), "utf8")).resolves.toBe(source);
  });

  it("rejects old role-based profiles without overwriting the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-old-role-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const statePath = join(userData, "bots.json");
    await mkdir(userData, { recursive: true });
    const source = `${JSON.stringify(
      {
        version: 2,
        examplesInitialized: true,
        bots: [{ id: "chief", role: "Coordinator" }],
      },
      null,
      2,
    )}\n`;
    await writeFile(statePath, source);

    const store = new BotStore(userData, join(root, "home"));
    await expect(store.initialize()).rejects.toThrow("old role field");
    await expect(readFile(statePath, "utf8")).resolves.toBe(source);
  });

  it("creates unique new agents at the top of the persistent list", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const store = new BotStore(userData, join(root, "home"));
    await store.initialize();

    const first = await store.createBot({ ...BOT_PROFILE_INPUT, name: "First Bot", avatarSeed: "setup:first" });
    const second = await store.createBot({ ...BOT_PROFILE_INPUT, name: "Second Bot", avatarSeed: "setup:second" });

    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe("First Bot");
    expect(second.name).toBe("Second Bot");
    expect(first.title).toBe("");
    expect(second.title).toBe("");
    expect(
      store
        .list()
        .slice(0, 2)
        .map((bot) => bot.id),
    ).toEqual([second.id, first.id]);

    const reloaded = new BotStore(userData, join(root, "home"));
    await reloaded.initialize();
    expect(
      reloaded
        .list()
        .slice(0, 2)
        .map((bot) => bot.id),
    ).toEqual([second.id, first.id]);
  });

  it("duplicates the profile, avatar, workspace, and symbolic links into an independent agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new BotStore(userData, home);
    await store.initialize();
    const source = await store.getOrCreate("chief", "Research", "Research lead");
    await store.updateBot({
      botId: source.id,
      description: "Finds primary sources.",
      notifications: false,
      provider: "claude",
      model: "claude-opus-5",
      reasoningEffort: "high",
      avatarSeed: "research:avatar",
      avatarHue: 215,
    });
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await store.setAvatar(source.id, { mimeType: "image/png", bytes: image });
    await mkdir(join(source.workspacePath, "skills", "research"), { recursive: true });
    await writeFile(join(source.workspacePath, "skills", "research", "SKILL.md"), "Use primary sources.\n");
    await writeFile(join(source.workspacePath, "skills.lock"), "research@1\n");
    await mkdir(join(source.workspacePath, "links"));
    await symlink(join(source.workspacePath, "skills.lock"), join(source.workspacePath, "internal-absolute"));
    await symlink("../skills.lock", join(source.workspacePath, "links", "internal-relative"));
    await writeFile(join(root, "outside.txt"), "outside\n");
    await symlink(join(root, "outside.txt"), join(source.workspacePath, "outside-link"));

    const firstOperationId = randomUUID();
    const secondOperationId = randomUUID();
    const duplicate = await store.duplicateBot(source.id, firstOperationId);
    const secondDuplicate = await store.duplicateBot(source.id, secondOperationId);
    await store.commitBotDuplication(duplicate.id, firstOperationId, source.id, EMPTY_LAYOUT);
    await store.commitBotDuplication(secondDuplicate.id, secondOperationId, source.id, EMPTY_LAYOUT);

    expect(duplicate).toMatchObject({
      name: "Research copy",
      title: "Research lead",
      description: "Finds primary sources.",
      notifications: false,
      provider: "claude",
      model: "claude-opus-5",
      reasoningEffort: "high",
      threadId: null,
      preview: "No messages yet",
      updatedAt: null,
      avatarSeed: "research:avatar",
      avatarHue: 215,
    });
    expect(secondDuplicate.name).toBe("Research copy 2");
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.workspacePath).not.toBe(source.workspacePath);
    await expect(readFile(join(duplicate.workspacePath, "skills", "research", "SKILL.md"), "utf8")).resolves.toBe(
      "Use primary sources.\n",
    );
    await expect(readFile(join(duplicate.workspacePath, "skills.lock"), "utf8")).resolves.toBe("research@1\n");
    await expect(readlink(join(duplicate.workspacePath, "internal-absolute"))).resolves.toBe(
      join(duplicate.workspacePath, "skills.lock"),
    );
    await expect(readlink(join(duplicate.workspacePath, "links", "internal-relative"))).resolves.toBe("../skills.lock");
    await expect(readlink(join(duplicate.workspacePath, "outside-link"))).resolves.toBe(join(root, "outside.txt"));
    await expect(readFile(store.resolveAvatar(duplicate.id)?.path ?? "")).resolves.toEqual(Buffer.from(image));

    await writeFile(join(duplicate.workspacePath, "internal-absolute"), "research@2\n");
    await expect(readFile(join(duplicate.workspacePath, "links", "internal-relative"), "utf8")).resolves.toBe(
      "research@2\n",
    );
    await expect(readFile(join(source.workspacePath, "skills.lock"), "utf8")).resolves.toBe("research@1\n");

    const reloaded = new BotStore(userData, home);
    await reloaded.initialize();
    expect(reloaded.list().map((bot) => bot.id)).toEqual(
      expect.arrayContaining([source.id, duplicate.id, secondDuplicate.id]),
    );
  });

  it("removes a durable pending duplicate during restart recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-recovery-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new BotStore(userData, home);
    await store.initialize();
    const source = await store.getOrCreate("chief");
    await writeFile(join(source.workspacePath, "note.txt"), "source\n");
    const duplicate = await store.duplicateBot(source.id);

    const recovered = new BotStore(userData, home);
    await recovered.initialize();

    expect(recovered.list().map((bot) => bot.id)).toEqual([source.id]);
    await expect(readFile(join(duplicate.workspacePath, "note.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(source.workspacePath, "note.txt"), "utf8")).resolves.toBe("source\n");
  });

  it("returns the committed duplicate for the same operation after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-idempotency-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const operationId = randomUUID();
    const store = new BotStore(userData, home);
    await store.initialize();
    const source = await store.getOrCreate("chief");
    const duplicate = await store.duplicateBot(source.id, operationId);
    const committed = await store.commitBotDuplication(duplicate.id, operationId, source.id, EMPTY_LAYOUT);

    const restored = new BotStore(userData, home);
    await restored.initialize();

    expect(restored.committedBotDuplication(operationId, source.id)).toEqual(committed);
    expect(restored.list().filter((bot) => bot.name === duplicate.name)).toHaveLength(1);
  });

  it("removes a partial duplicate when profile persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-rollback-"));
    temporaryRoots.push(root);
    const home = join(root, "home");
    const store = new BotStore(join(root, "user-data"), home);
    await store.initialize();
    const source = await store.getOrCreate("chief");
    await writeFile(join(source.workspacePath, "note.txt"), "keep\n");
    vi.spyOn(store.database, "replaceAgents").mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });

    await expect(store.duplicateBot(source.id)).rejects.toThrow("database unavailable");

    expect(store.list().map((bot) => bot.id)).toEqual([source.id]);
    expect(await readdir(join(home, "OpenBot", "Bots"))).toEqual([source.id]);
    await expect(readFile(join(source.workspacePath, "note.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("rejects duplication after the host reaches its agent limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-limit-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    const source = await store.getOrCreate("agent-0");
    for (let index = 1; index < INPUT_LIMITS.agents; index += 1) {
      await store.getOrCreate(`agent-${index}`);
    }

    await expect(store.duplicateBot(source.id)).rejects.toThrow(`up to ${INPUT_LIMITS.agents} agents`);
    expect(store.list()).toHaveLength(INPUT_LIMITS.agents);
  });

  it("validates the complete Bot profile before it writes data", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();

    await expect(store.createBot({ ...BOT_PROFILE_INPUT, name: " " })).rejects.toThrow("Agent name is required.");
    await expect(store.createBot({ ...BOT_PROFILE_INPUT, description: " " })).rejects.toThrow(
      "Agent description is required.",
    );
    await expect(store.createBot({ ...BOT_PROFILE_INPUT, avatarSeed: "" })).rejects.toThrow("Invalid avatar seed.");
    expect(store.list()).toEqual([]);
  });

  it("rejects path traversal bot ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "data"), join(root, "home"));
    await store.initialize();

    await expect(store.getOrCreate("../outside")).rejects.toThrow("Invalid bot id");
  });

  it("fails closed instead of overwriting agent state from a newer version", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const statePath = join(userData, "bots.json");
    const unsupported = '{"version":999,"examplesInitialized":true,"bots":[]}\n';
    await mkdir(userData, { recursive: true });
    await writeFile(statePath, unsupported);

    const store = new BotStore(userData, join(root, "home"));
    await expect(store.initialize()).rejects.toThrow("refusing to overwrite");
    await expect(readFile(statePath, "utf8")).resolves.toBe(unsupported);
  });

  it("persists editable agent settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const store = new BotStore(userData, join(root, "home"));
    await store.initialize();

    await store.getOrCreate("chief");
    await store.updateBot({
      botId: "chief",
      name: "Coordinator",
      title: "Operations lead",
      description: "Keeps the team aligned",
      notifications: false,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      avatarSeed: "chief:avatar:2:4",
      avatarHue: 215,
    });
    const restored = new BotStore(userData, join(root, "home"));
    await restored.initialize();
    expect(restored.list().find((bot) => bot.id === "chief")).toMatchObject({
      name: "Coordinator",
      title: "Operations lead",
      description: "Keeps the team aligned",
      notifications: false,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      avatarSeed: "chief:avatar:2:4",
      avatarHue: 215,
    });
  });

  it("stores, restores, and removes managed agent avatar files", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const store = new BotStore(userData, join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const updated = await store.setAvatar("chief", { mimeType: "image/png", bytes: image });
    expect(updated.avatarUrl).toMatch(/^openbot-avatar:\/\/agent\/chief\?v=/u);
    const storedAvatar = store.resolveAvatar("chief");
    expect(storedAvatar?.mimeType).toBe("image/png");
    await expect(readFile(storedAvatar?.path ?? "")).resolves.toEqual(Buffer.from(image));

    const restored = new BotStore(userData, join(root, "home"));
    await restored.initialize();
    expect(restored.list().find((bot) => bot.id === "chief")?.avatarUrl).toBe(updated.avatarUrl);
    const restoredPath = restored.resolveAvatar("chief")?.path ?? "";
    await restored.setAvatar("chief", null);
    expect(restored.list().find((bot) => bot.id === "chief")?.avatarUrl).toBeNull();
    await expect(readFile(restoredPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the previous avatar when SQLite persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const original = await store.setAvatar("chief", { mimeType: "image/png", bytes: image });
    const originalAvatar = store.resolveAvatar("chief");
    vi.spyOn(store.database, "replaceAgents").mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(store.setAvatar("chief", { mimeType: "image/png", bytes: image })).rejects.toThrow(
      "database unavailable",
    );
    expect(store.list().find((bot) => bot.id === "chief")).toMatchObject({
      avatarUrl: original.avatarUrl,
      updatedAt: original.updatedAt,
    });
    await expect(readFile(originalAvatar?.path ?? "")).resolves.toEqual(Buffer.from(image));

    await expect(store.setAvatar("chief", null)).rejects.toThrow("database unavailable");
    expect(store.list().find((bot) => bot.id === "chief")?.avatarUrl).toBe(original.avatarUrl);
    await expect(readFile(originalAvatar?.path ?? "")).resolves.toEqual(Buffer.from(image));
  });

  it("rejects agent fields above their limits without truncating stored values", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");

    await expect(store.updateBot({ botId: "chief", name: "x".repeat(INPUT_LIMITS.agentName + 1) })).rejects.toThrow(
      "Agent name is too long",
    );
    await expect(
      store.updateBot({
        botId: "chief",
        description: "x".repeat(INPUT_LIMITS.agentDescription + 1),
      }),
    ).rejects.toThrow("Agent description is too long");
    expect(store.list().find((bot) => bot.id === "chief")).toMatchObject({
      name: "Chief",
      description: "",
    });
  });

  it("keeps the OpenBot thread when the model changes provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");
    const threadId = await store.ensureThreadId("chief");

    const claude = await store.updateBot({ botId: "chief", provider: "claude", model: "claude-sonnet-5" });
    expect(claude.threadId).toBe(threadId);

    const opus = await store.updateBot({ botId: "chief", provider: "claude", model: "claude-opus-5" });
    expect(opus.threadId).toBe(threadId);
  });

  it("keeps provider sessions private and creates a new session when returning", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");
    const publicThreadId = await store.ensureThreadId("chief");
    store.bindProviderSession("chief", "codex-native-1");
    store.database.deactivateProviderSessions(publicThreadId);

    await store.updateBot({ botId: "chief", provider: "claude", model: "claude-sonnet-5" });
    store.bindProviderSession("chief", "claude-native-1");
    store.database.deactivateProviderSessions(publicThreadId);
    await store.updateBot({ botId: "chief", provider: "codex", model: "gpt-5.6-sol" });
    expect(store.activeProviderSession("chief")).toBeNull();
    store.bindProviderSession("chief", "codex-native-2");

    expect(store.list()[0]?.threadId).toBe(publicThreadId);
    expect(store.activeProviderSession("chief")?.externalSessionId).toBe("codex-native-2");
    expect(store.database.listProviderSessions(publicThreadId)).toMatchObject([
      { provider: "codex", externalSessionId: "codex-native-1", state: "inactive" },
      { provider: "claude", externalSessionId: "claude-native-1", state: "inactive" },
      { provider: "codex", externalSessionId: "codex-native-2", state: "active" },
    ]);
  });

  it("deletes agents persistently without reseeding examples", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new BotStore(userData, home);
    await store.initialize();

    const bot = await store.createBot(BOT_PROFILE_INPUT);
    await writeFile(join(bot.workspacePath, "generated.txt"), "workspace data");
    await store.deleteBot(bot.id);
    expect(store.list()).toEqual([]);
    await expect(readFile(join(bot.workspacePath, "generated.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const restored = new BotStore(userData, home);
    await restored.initialize();
    expect(restored.list()).toEqual([]);
  });
});
