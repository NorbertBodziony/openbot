// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotStore } from "./bot-store";

const temporaryRoots: string[] = [];

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
          role: "Coordinator",
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
    await expect(
      readFile(join(userData, "legacy-backup-v1", "bots.json"), "utf8"),
    ).resolves.toContain('"version": 1');
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
          role: "Writing",
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

    expect(store.list()).toMatchObject([
      { id: "writer", model: "claude-sonnet-5", threadId: null, avatarHue: 215 },
    ]);
    await expect(readFile(statePath, "utf8")).resolves.toBe(source);
    await expect(readFile(join(userData, "legacy-backup-v1", "bots.json"), "utf8")).resolves.toBe(
      source,
    );
  });

  it("creates unique new agents at the top of the persistent list", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const store = new BotStore(userData, join(root, "home"));
    await store.initialize();

    const first = await store.createBot();
    const second = await store.createBot();

    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe("New agent");
    expect(second.name).toBe("New agent");
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
      role: "Operations lead",
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
      role: "Operations lead",
      description: "Keeps the team aligned",
      notifications: false,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      avatarSeed: "chief:avatar:2:4",
      avatarHue: 215,
    });
  });

  it("keeps the OpenBot thread when the model changes provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");
    const threadId = await store.ensureThreadId("chief");

    const claude = await store.updateBot({ botId: "chief", model: "claude-sonnet-5" });
    expect(claude.threadId).toBe(threadId);

    const opus = await store.updateBot({ botId: "chief", model: "claude-opus-5" });
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

    await store.updateBot({ botId: "chief", model: "claude-sonnet-5" });
    store.bindProviderSession("chief", "claude-native-1");
    store.database.deactivateProviderSessions(publicThreadId);
    await store.updateBot({ botId: "chief", model: "gpt-5.6-sol" });
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

    await store.createBot();
    for (const bot of store.list()) await store.deleteBot(bot.id);
    expect(store.list()).toEqual([]);

    const restored = new BotStore(userData, home);
    await restored.initialize();
    expect(restored.list()).toEqual([]);
  });
});
