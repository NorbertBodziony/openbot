// @vitest-environment node

import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentReferenceIds } from "@openbot/contracts/attachment-references";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMemoryStore } from "../src/backend/agent-memory-store";
import { AgentRoutineStore } from "../src/backend/agent-routine-store";
import { BotStore } from "../src/backend/bot-store";
import { MailboxStore } from "../src/backend/mailbox-store";
import { TeamChatStore } from "../src/backend/team-chat-store";
import { developmentUserDataName } from "../src/main/development-profile";
import { readSetupState } from "../src/main/setup-store";
import { TeamStore } from "../src/main/team-store";
import { cleanupSeedOwnedTransfers, DEVELOPMENT_SEED_MANIFEST_FILE, seedDevelopmentState } from "./seed-dev-state";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("development state seed", () => {
  it("creates a durable showcase through the public stores", async () => {
    const { appDataRoot, homeDirectory } = await createRoots();
    const productionSentinel = join(appDataRoot, "OpenBot", "production.txt");
    const testClientSentinel = join(appDataRoot, developmentUserDataName("test-client"), "test-client.txt");
    await Promise.all([
      writeSentinel(productionSentinel, "production"),
      writeSentinel(testClientSentinel, "test client"),
    ]);

    const result = await seedDevelopmentState({ appDataRoot, homeDirectory });
    const profilePath = join(appDataRoot, developmentUserDataName("app"));

    expect(result).toMatchObject({
      targetProfile: profilePath,
      dryRun: false,
      agents: 4,
      conversations: 4,
      attachments: 4,
      teamMembers: 4,
      activeInvites: 1,
      sessions: 4,
      directThreads: 3,
      queuedDeliveries: 0,
      memories: 7,
      routines: 5,
      routineRuns: 3,
    });
    await expect(readSetupState(join(profilePath, "openbot-setup-v2.json"))).resolves.toEqual({
      completed: true,
      preferredProvider: "codex",
    });

    const bots = new BotStore(profilePath, homeDirectory);
    await bots.initialize();
    const mailbox = new MailboxStore(profilePath, bots.sharedRoot, bots.database);
    await mailbox.initialize();
    const summaries = bots.list();
    expect(summaries).toHaveLength(4);
    expect(summaries.every((bot) => bot.threadId !== null)).toBe(true);
    expect(summaries.every((bot) => bot.model === "gpt-5.6-luna" && bot.reasoningEffort === "low")).toBe(true);

    const persistedMessages = summaries.flatMap((bot) => bots.database.readConversation(bot.id, bot.threadId).messages);
    expect(persistedMessages.some((message) => message.status === "failed")).toBe(true);
    expect(persistedMessages.some((message) => message.status === "interrupted")).toBe(true);
    expect(
      persistedMessages.some(
        (message) =>
          message.itemType === "image_generation" && message.status === "completed" && message.attachments?.length,
      ),
    ).toBe(true);
    expect(
      persistedMessages.some(
        (message) =>
          message.itemType === "image_generation" && message.status === "failed" && message.imageGeneration?.error,
      ),
    ).toBe(true);
    expect(persistedMessages.some((message) => message.replyToMessageId !== undefined)).toBe(true);
    expect(mailbox.reactionFor("chief", "chief-assistant-plan")).toBe("🎉");
    expect(mailbox.reactionFor("research", "research-assistant")).toBe("✅");

    const attachments = new Map(
      persistedMessages
        .flatMap((message) => message.attachments ?? [])
        .map((attachment) => [attachment.id, attachment]),
    );
    expect(attachments.size).toBe(4);
    for (const attachment of attachments.values()) {
      const resolved = await mailbox.resolveAttachment(attachment.id);
      expect(resolved).not.toBeNull();
      await expect(stat(resolved?.path ?? "")).resolves.toBeDefined();
    }
    const referencedIds = new Set(persistedMessages.flatMap((message) => [...attachmentReferenceIds(message.text)]));
    expect(referencedIds).toEqual(new Set(attachments.keys()));

    const exchanges = summaries.flatMap((bot) => mailbox.conversationMessages(bot.id));
    expect(
      exchanges.some(
        (message) =>
          message.exchange?.direction === "outgoing" &&
          message.exchange.deliveries.every((delivery) => delivery.status === "completed"),
      ),
    ).toBe(true);
    expect(
      exchanges.some(
        (message) =>
          message.exchange?.direction === "outgoing" &&
          message.exchange.deliveries.some((delivery) => delivery.status === "failed"),
      ),
    ).toBe(true);
    expect(
      summaries
        .flatMap((bot) => mailbox.listQueue(bot.id).deliveries)
        .filter((delivery) => delivery.status === "queued"),
    ).toHaveLength(0);

    const memoryStore = new AgentMemoryStore(bots.database);
    const memories = summaries.flatMap((bot) => memoryStore.list(bot.id));
    expect(memories).toHaveLength(7);
    expect(memories.some((memory) => memory.origin === "manual")).toBe(true);
    const automaticMemories = memories.filter((memory) => memory.origin === "automatic");
    expect(automaticMemories).not.toHaveLength(0);
    const conversationTurnIds = new Set(persistedMessages.map((message) => message.turnId).filter(Boolean));
    expect(automaticMemories.every((memory) => conversationTurnIds.has(memory.sourceTurnId ?? undefined))).toBe(true);

    const routineStore = new AgentRoutineStore(bots.database);
    const routines = summaries.flatMap((bot) => routineStore.list(bot.id));
    expect(routines).toHaveLength(5);
    expect(routines.some((routine) => routine.active)).toBe(true);
    expect(routines.some((routine) => !routine.active)).toBe(true);
    const runs = routines.flatMap((routine) => routineStore.listRuns(routine.botId, routine.id, 10));
    expect(runs).toHaveLength(3);
    expect(runs.map((run) => run.status)).toEqual(expect.arrayContaining(["succeeded", "failed"]));
    for (const run of runs) {
      expect(run.deliveryId).not.toBeNull();
      expect(mailbox.conversationMessages(run.botId)).toContainEqual(
        expect.objectContaining({
          id: run.deliveryId,
          source: "routine",
          routine: expect.objectContaining({ routineId: run.routineId, runId: run.id }),
        }),
      );
      expect(persistedMessages).toContainEqual(
        expect.objectContaining({
          id: run.deliveryId,
          source: "routine",
          routine: expect.objectContaining({ routineId: run.routineId, runId: run.id }),
        }),
      );
    }

    const team = new TeamStore(
      join(profilePath, "openbot-team-server-v2.json"),
      join(profilePath, "openbot-team-server-v1.json"),
    );
    await team.initialize();
    const members = team.listMembers();
    const owner = members.find((member) => member.role === "owner");
    expect(owner?.email).toBe("openbot-dev-host@example.com");
    expect(members).toHaveLength(4);
    expect(team.listInvites().filter((invite) => invite.usedAt === null)).toHaveLength(1);
    expect(team.listSessions()).toHaveLength(4);
    const chat = new TeamChatStore(bots.database);
    const directThreads = chat.listThreads(owner?.id ?? "");
    expect(directThreads).toHaveLength(3);
    expect(directThreads.reduce((total, thread) => total + thread.unreadCount, 0)).toBeGreaterThan(0);
    bots.database.close();

    await expect(readFile(productionSentinel, "utf8")).resolves.toBe("production");
    await expect(readFile(testClientSentinel, "utf8")).resolves.toBe("test client");
  });

  it("replaces the app profile and removes only files from the previous seed", async () => {
    const { appDataRoot, homeDirectory } = await createRoots();
    await seedDevelopmentState({ appDataRoot, homeDirectory });
    const generatedRoot = join(homeDirectory, "OpenBot", "Shared", "Transfers", "generated");
    const firstDirectories = await readdir(generatedRoot);
    expect(firstDirectories).toHaveLength(4);

    await seedDevelopmentState({ appDataRoot, homeDirectory });

    const secondDirectories = await readdir(generatedRoot);
    expect(secondDirectories).toHaveLength(4);
    expect(secondDirectories.every((directory) => !firstDirectories.includes(directory))).toBe(true);
    for (const directory of firstDirectories) {
      await expect(stat(join(generatedRoot, directory))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("blocks a live profile before it removes existing state", async () => {
    const { appDataRoot, homeDirectory } = await createRoots();
    const profilePath = join(appDataRoot, developmentUserDataName("app"));
    const sentinel = join(profilePath, "keep.txt");
    await writeSentinel(sentinel, "keep");
    await symlink(`test-host-${process.pid}`, join(profilePath, "SingletonLock"));

    await expect(seedDevelopmentState({ appDataRoot, homeDirectory })).rejects.toThrow("Quit the OpenBot dev app");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
  });

  it("reports a dry run without changing the target profile", async () => {
    const { appDataRoot, homeDirectory } = await createRoots();
    const profilePath = join(appDataRoot, developmentUserDataName("app"));
    const sentinel = join(profilePath, "keep.txt");
    await writeSentinel(sentinel, "keep");

    await expect(seedDevelopmentState({ appDataRoot, homeDirectory, dryRun: true })).resolves.toMatchObject({
      dryRun: true,
      targetProfile: profilePath,
    });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep");
  });

  it("seeds an isolated development instance without changing the default profile", async () => {
    const { appDataRoot, homeDirectory } = await createRoots();
    const defaultSentinel = join(appDataRoot, developmentUserDataName("app"), "keep.txt");
    await writeSentinel(defaultSentinel, "keep");

    const result = await seedDevelopmentState({ appDataRoot, homeDirectory, instanceId: "5197" });

    expect(result.targetProfile).toBe(join(appDataRoot, developmentUserDataName("app", "5197")));
    await expect(readFile(defaultSentinel, "utf8")).resolves.toBe("keep");
  });

  it("ignores unsafe paths in a malformed seed manifest", async () => {
    const { appDataRoot, homeDirectory } = await createRoots();
    const profilePath = join(appDataRoot, developmentUserDataName("app"));
    const outsidePath = join(homeDirectory, "outside.txt");
    await Promise.all([
      writeSentinel(outsidePath, "keep"),
      writeSentinel(
        join(profilePath, DEVELOPMENT_SEED_MANIFEST_FILE),
        JSON.stringify({
          version: 1,
          createdAt: "2026-08-21T10:00:00.000Z",
          transferDirectories: ["../../outside.txt", "generated/not-a-uuid"],
        }),
      ),
    ]);

    await expect(cleanupSeedOwnedTransfers(profilePath, homeDirectory)).resolves.toEqual([]);
    await expect(readFile(outsidePath, "utf8")).resolves.toBe("keep");
  });
});

async function createRoots(): Promise<{ appDataRoot: string; homeDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), "openbot-dev-seed-test-"));
  temporaryDirectories.push(root);
  const appDataRoot = join(root, "app-data");
  const homeDirectory = join(root, "home");
  await Promise.all([mkdir(appDataRoot, { recursive: true }), mkdir(homeDirectory, { recursive: true })]);
  return { appDataRoot, homeDirectory };
}

async function writeSentinel(path: string, value: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, value);
}
