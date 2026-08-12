// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotStore } from "./bot-store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("BotStore", () => {
  it("creates separate bot workspaces and a shared directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "infeld-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new BotStore(userData, home);

    await store.initialize();
    const chief = await store.getOrCreate("chief");
    const sales = await store.getOrCreate("sales-outbound");

    expect(chief.workspacePath).toBe(join(home, "Infeld", "Bots", "chief"));
    expect(sales.workspacePath).toBe(join(home, "Infeld", "Bots", "sales-outbound"));
    expect(store.sharedRoot).toBe(join(home, "Infeld", "Shared"));
    expect(chief.workspacePath).not.toBe(sales.workspacePath);
  });

  it("persists thread ids with a complete JSON state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "infeld-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const store = new BotStore(userData, join(root, "home"));
    await store.initialize();

    await store.setThreadId("chief", "thread-123");
    const parsed = JSON.parse(await readFile(join(userData, "agent-state.json"), "utf8"));

    expect(parsed.version).toBe(1);
    expect(parsed.bots.find((bot: { id: string }) => bot.id === "chief").threadId).toBe(
      "thread-123",
    );
  });

  it("creates unique new agents at the top of the persistent list", async () => {
    const root = await mkdtemp(join(tmpdir(), "infeld-store-"));
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
    const root = await mkdtemp(join(tmpdir(), "infeld-store-"));
    temporaryRoots.push(root);
    const store = new BotStore(join(root, "data"), join(root, "home"));
    await store.initialize();

    await expect(store.getOrCreate("../outside")).rejects.toThrow("Invalid bot id");
  });
});
