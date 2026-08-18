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

  it("persists thread ids with a complete JSON state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const store = new BotStore(userData, join(root, "home"));
    await store.initialize();

    await store.getOrCreate("chief");
    await store.setThreadId("chief", "thread-123");
    const parsed = JSON.parse(await readFile(join(userData, "bots.json"), "utf8"));

    expect(parsed.version).toBe(2);
    expect(parsed.bots.find((bot: { id: string }) => bot.id === "chief").threadId).toBe(
      "thread-123",
    );
  });

  it("migrates version 1 avatars to stable id seeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const statePath = join(userData, "bots.json");
    const store = new BotStore(userData, join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");

    const current = JSON.parse(await readFile(statePath, "utf8"));
    current.version = 1;
    current.bots = current.bots.map(
      ({ avatarSeed: _avatarSeed, avatarHue: _avatarHue, ...bot }: Record<string, unknown>) => ({
        ...bot,
        avatarShape: "cloud",
        avatarColor: "violet",
      }),
    );
    await writeFile(statePath, `${JSON.stringify(current, null, 2)}\n`);

    const restored = new BotStore(userData, join(root, "home"));
    await restored.initialize();

    expect(restored.list().find((bot) => bot.id === "chief")).toMatchObject({
      avatarSeed: "chief",
      avatarHue: null,
    });
    const migrated = JSON.parse(await readFile(statePath, "utf8"));
    expect(migrated.version).toBe(2);
    expect(migrated.bots[0]).not.toHaveProperty("avatarShape");
    expect(migrated.bots[0]).not.toHaveProperty("avatarColor");
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

  it("starts a new thread when the model changes provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");
    await store.setThreadId("chief", "codex-thread");

    const claude = await store.updateBot({ botId: "chief", model: "claude-sonnet-5" });
    expect(claude.threadId).toBeNull();
    await store.setThreadId("chief", "claude-thread");

    const opus = await store.updateBot({ botId: "chief", model: "claude-opus-5" });
    expect(opus.threadId).toBe("claude-thread");
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
