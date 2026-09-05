// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "./agent-store";

const temporaryRoots: string[] = [];
const AGENT_PROFILE_INPUT = {
  name: "Planning Agent",
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

describe("AgentStore", () => {
  it("starts a new user with no agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new AgentStore(join(root, "user-data"), join(root, "home"));

    await store.initialize();

    expect(store.list()).toEqual([]);
  });

  it("creates separate agent workspaces and a shared directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new AgentStore(userData, home);

    await store.initialize();
    const chief = await store.getOrCreate("chief");
    const sales = await store.getOrCreate("sales-outbound");

    expect(chief.workspacePath).toBe(join(home, "OpenBot", "Agents", "chief"));
    expect(chief.description).toBe("");
    expect(chief.preview).toBe("No messages yet");
    expect(chief.model).toBe("gpt-5.6-luna");
    expect(chief.reasoningEffort).toBe("medium");
    expect(sales.workspacePath).toBe(join(home, "OpenBot", "Agents", "sales-outbound"));
    expect(store.sharedRoot).toBe(join(home, "OpenBot", "Shared"));
    expect(chief.workspacePath).not.toBe(sales.workspacePath);
  });

  it("moves a workspace left behind in the pre-rename directory without overwriting the new one", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new AgentStore(userData, home);
    await store.initialize();
    const agent = await store.createAgent(AGENT_PROFILE_INPUT);
    await writeFile(join(agent.workspacePath, "notes.md"), "kept");
    const chief = await store.getOrCreate("chief");
    await writeFile(join(chief.workspacePath, "notes.md"), "kept too");

    // The disk a pre-rename build left behind: the workspace under `OpenBot/Bots/bot-<uuid>`, beside an
    // unfinished copy from a duplication that crashed. Migration v13 has already pointed the stored path
    // at `OpenBot/Agents/agent-<uuid>`, which is why the files have to follow it.
    const legacyRoot = join(home, "OpenBot", "Bots");
    const legacyWorkspace = join(legacyRoot, `bot-${agent.id.slice("agent-".length)}`);
    await mkdir(legacyRoot, { recursive: true });
    await rename(agent.workspacePath, legacyWorkspace);
    await mkdir(`${legacyWorkspace}.openbot-stage`, { recursive: true });
    // An id the application never minted keeps its spelling across the rename, so migration v13 leaves its
    // stored path alone as well: after the upgrade this agent is still *recorded* under `Bots/chief`, and
    // that is the state the move has to start from. A reconciler that reads the destination out of the
    // stored path finds the workspace already there and leaves it in the old root forever, while
    // `PRIVACY.md` tells the user their files are under `Agents`.
    const legacyChiefWorkspace = join(legacyRoot, chief.id);
    await rename(chief.workspacePath, legacyChiefWorkspace);
    store.database.connection
      .prepare(
        "UPDATE projection_agents SET agent_json = json_set(agent_json, '$.workspacePath', ?) WHERE agent_id = ?",
      )
      .run(legacyChiefWorkspace, chief.id);

    // An uploaded avatar is stored under the agent id, and `avatarUrl` derives that directory from the id
    // migration v13 has just rewritten. Left behind, the file is on disk under one name and looked for
    // under another, so the upload silently falls back to a drawn face.
    const legacyAvatar = join(userData, "avatars", "agents", `bot-${agent.id.slice("agent-".length)}`);
    await mkdir(legacyAvatar, { recursive: true });
    await writeFile(join(legacyAvatar, "avatar.png"), "uploaded");

    const reconciled = new AgentStore(userData, home);
    await reconciled.initialize();

    expect(await readFile(join(agent.workspacePath, "notes.md"), "utf8")).toBe("kept");
    expect(await readFile(join(home, "OpenBot", "Agents", chief.id, "notes.md"), "utf8")).toBe("kept too");
    // Moving the files without recording where they went leaves every conversation and tool call pointing
    // at a directory that is no longer there.
    expect(reconciled.list().find((entry) => entry.id === chief.id)?.workspacePath).toBe(
      join(home, "OpenBot", "Agents", chief.id),
    );
    await expect(readFile(join(userData, "avatars", "agents", agent.id, "avatar.png"), "utf8")).resolves.toBe(
      "uploaded",
    );
    await expect(readdir(legacyRoot)).rejects.toMatchObject({ code: "ENOENT" });

    // A run interrupted after the move can leave a stale directory back at the old name. The stored path
    // is what the database and every open conversation point at, so the leftover never lands on top of it.
    await mkdir(legacyWorkspace, { recursive: true });
    await writeFile(join(legacyWorkspace, "notes.md"), "stale");
    await new AgentStore(userData, home).initialize();

    expect(await readFile(join(agent.workspacePath, "notes.md"), "utf8")).toBe("kept");

    // Two directories at once is not an interrupted move -- the move is a single atomic `rename`, so it
    // never leaves both behind -- and the record still names the one the agent has been reading. Adopting
    // the other would hand it files that were never its own and put its real workspace out of reach.
    await mkdir(legacyChiefWorkspace, { recursive: true });
    await writeFile(join(legacyChiefWorkspace, "notes.md"), "the real one");
    reconciled.database.connection
      .prepare(
        "UPDATE projection_agents SET agent_json = json_set(agent_json, '$.workspacePath', ?) WHERE agent_id = ?",
      )
      .run(legacyChiefWorkspace, chief.id);

    const ambiguous = new AgentStore(userData, home);
    await ambiguous.initialize();

    expect(ambiguous.list().find((entry) => entry.id === chief.id)?.workspacePath).toBe(legacyChiefWorkspace);

    // An avatar directory that already exists cannot be moved onto either, but abandoning the old one
    // strands the file `avatarUrl` names: `resolveAvatar` looks for it under the new id alone, so the upload
    // the user made falls back to a drawn face. The one file the URL names comes across on its own.
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await ambiguous.setAvatar(agent.id, { mimeType: "image/png", bytes: image });
    const uploadedPath = ambiguous.resolveAvatar(agent.id)?.path ?? "";
    await mkdir(legacyAvatar, { recursive: true });
    await rename(uploadedPath, join(legacyAvatar, basename(uploadedPath)));

    const adopted = new AgentStore(userData, home);
    await adopted.initialize();

    await expect(readFile(adopted.resolveAvatar(agent.id)?.path ?? "")).resolves.toEqual(Buffer.from(image));
  });

  it("persists stable OpenBot thread ids in SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const store = new AgentStore(userData, join(root, "home"));
    await store.initialize();

    await store.getOrCreate("chief");
    const threadId = await store.ensureThreadId("chief");
    const restored = new AgentStore(userData, join(root, "home"));
    await restored.initialize();
    expect(restored.list().find((agent) => agent.id === "chief")?.threadId).toBe(threadId);
    await expect(readFile(join(userData, "bots.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists marketplace installation versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new AgentStore(userData, home);
    await store.initialize();
    const agent = await store.createAgent(AGENT_PROFILE_INPUT);

    store.setMarketplaceSource(agent.id, {
      listingId: "market-planner",
      versionId: "market-planner-v2",
      version: 2,
      skillIds: ["planning"],
      routineIds: ["routine-marketplace"],
    });

    const restored = new AgentStore(userData, home);
    await restored.initialize();
    expect(restored.list().find((candidate) => candidate.id === agent.id)?.marketplaceSource).toEqual({
      listingId: "market-planner",
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
      // The key a released `bots.json` used. Reading a different one discards every agent in the file.
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

    const restored = new AgentStore(userData, join(root, "home"));
    await restored.initialize();

    expect(restored.list().find((agent) => agent.id === "chief")).toMatchObject({
      avatarSeed: "chief",
      avatarHue: null,
    });
    expect(restored.list()[0]?.threadId).toBe("openbot-thread-chief");
    // Imported and kept, but not resumable: the tool parameters were renamed in the same upgrade, and this
    // session arrives after the migration that retires every other one for exactly that reason.
    expect(restored.activeProviderSession("chief")).toBeNull();
    expect(restored.database.listProviderSessions("openbot-thread-chief")).toMatchObject([
      { externalSessionId: "native-codex-thread", state: "inactive" },
    ]);
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
      // The key a released `bots.json` used. Reading a different one discards every agent in the file.
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
    const store = new AgentStore(userData, join(root, "home"));
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

    const store = new AgentStore(userData, join(root, "home"));
    await expect(store.initialize()).rejects.toThrow("old role field");
    await expect(readFile(statePath, "utf8")).resolves.toBe(source);
  });

  it("creates unique new agents at the top of the persistent list", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const store = new AgentStore(userData, join(root, "home"));
    await store.initialize();

    const first = await store.createAgent({ ...AGENT_PROFILE_INPUT, name: "First Agent", avatarSeed: "setup:first" });
    const second = await store.createAgent({
      ...AGENT_PROFILE_INPUT,
      name: "Second Agent",
      avatarSeed: "setup:second",
    });

    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe("First Agent");
    expect(second.name).toBe("Second Agent");
    expect(first.title).toBe("");
    expect(second.title).toBe("");
    expect(
      store
        .list()
        .slice(0, 2)
        .map((agent) => agent.id),
    ).toEqual([second.id, first.id]);

    const reloaded = new AgentStore(userData, join(root, "home"));
    await reloaded.initialize();
    expect(
      reloaded
        .list()
        .slice(0, 2)
        .map((agent) => agent.id),
    ).toEqual([second.id, first.id]);
  });

  it("duplicates the profile, avatar, workspace, and symbolic links into an independent agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new AgentStore(userData, home);
    await store.initialize();
    const source = await store.getOrCreate("chief", "Research", "Research lead");
    await store.updateAgent({
      agentId: source.id,
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
    const sourceWorkspaceAlias = join(root, "source-workspace-alias");
    await symlink(source.workspacePath, sourceWorkspaceAlias);
    await symlink(join(sourceWorkspaceAlias, "skills.lock"), join(source.workspacePath, "aliased-internal"));
    await writeFile(join(root, "outside.txt"), "outside\n");
    await symlink(join(root, "outside.txt"), join(source.workspacePath, "outside-link"));

    const firstOperationId = randomUUID();
    const secondOperationId = randomUUID();
    const duplicate = await store.duplicateAgent(source.id, firstOperationId);
    const secondDuplicate = await store.duplicateAgent(source.id, secondOperationId);
    await store.commitAgentDuplication(duplicate.id, firstOperationId, source.id, EMPTY_LAYOUT);
    await store.commitAgentDuplication(secondDuplicate.id, secondOperationId, source.id, EMPTY_LAYOUT);

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
    await expect(readlink(join(duplicate.workspacePath, "aliased-internal"))).resolves.toBe(
      join(duplicate.workspacePath, "skills.lock"),
    );
    await expect(readlink(join(duplicate.workspacePath, "outside-link"))).resolves.toBe(join(root, "outside.txt"));
    await expect(readFile(store.resolveAvatar(duplicate.id)?.path ?? "")).resolves.toEqual(Buffer.from(image));

    await writeFile(join(duplicate.workspacePath, "internal-absolute"), "research@2\n");
    await expect(readFile(join(duplicate.workspacePath, "links", "internal-relative"), "utf8")).resolves.toBe(
      "research@2\n",
    );
    await writeFile(join(duplicate.workspacePath, "aliased-internal"), "research@3\n");
    await expect(readFile(join(duplicate.workspacePath, "skills.lock"), "utf8")).resolves.toBe("research@3\n");
    await expect(readFile(join(source.workspacePath, "skills.lock"), "utf8")).resolves.toBe("research@1\n");

    const reloaded = new AgentStore(userData, home);
    await reloaded.initialize();
    expect(reloaded.list().map((agent) => agent.id)).toEqual(
      expect.arrayContaining([source.id, duplicate.id, secondDuplicate.id]),
    );
  });

  it("removes a durable pending duplicate during restart recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-recovery-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new AgentStore(userData, home);
    await store.initialize();
    const source = await store.getOrCreate("chief");
    await writeFile(join(source.workspacePath, "note.txt"), "source\n");
    const duplicate = await store.duplicateAgent(source.id);

    const recovered = new AgentStore(userData, home);
    await recovered.initialize();

    expect(recovered.list().map((agent) => agent.id)).toEqual([source.id]);
    await expect(readFile(join(duplicate.workspacePath, "note.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(source.workspacePath, "note.txt"), "utf8")).resolves.toBe("source\n");
  });

  it("removes a pending duplicate a pre-rename release left half-copied", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-recovery-legacy-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const store = new AgentStore(userData, home);
    await store.initialize();
    const source = await store.getOrCreate("chief");
    const duplicate = await store.duplicateAgent(source.id);

    // The build that crashed mid-copy was a pre-rename one, so it named the marker after the duplicate's
    // old id and copied the workspace under the old root; migration v13 has since renamed the agent.
    // Recovery has to resolve the agent through both spellings and then address it by the id it has now,
    // or the half-made duplicate stays in the sidebar and its workspace stays on disk.
    const legacyId = `bot-${duplicate.id.slice("agent-".length)}`;
    const legacyWorkspace = join(home, "OpenBot", "Bots", legacyId);
    await mkdir(join(home, "OpenBot", "Bots"), { recursive: true });
    await rename(duplicate.workspacePath, legacyWorkspace);
    const duplications = join(userData, "agent-duplications");
    const pending = JSON.parse(await readFile(join(duplications, `${duplicate.id}.pending`), "utf8"));
    await rm(join(duplications, `${duplicate.id}.pending`), { force: true });
    await writeFile(
      join(duplications, `${legacyId}.pending`),
      `${JSON.stringify({ operationId: pending.operationId, sourceBotId: source.id })}\n`,
    );

    const recovered = new AgentStore(userData, home);
    await recovered.initialize();

    expect(recovered.list().map((agent) => agent.id)).toEqual([source.id]);
    await expect(readdir(legacyWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(duplications)).resolves.toEqual([]);
  });

  it("keeps a committed duplicate whose pending marker a pre-rename release wrote", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-recovery-legacy-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const operationId = randomUUID();
    const store = new AgentStore(userData, home);
    await store.initialize();
    const source = await store.createAgent(AGENT_PROFILE_INPUT);
    const duplicate = await store.duplicateAgent(source.id, operationId);
    await store.commitAgentDuplication(duplicate.id, operationId, source.id, EMPTY_LAYOUT);
    await writeFile(join(duplicate.workspacePath, "note.txt"), "duplicate\n");

    // The crash that stranded this marker happened before the rename, so every id in it is spelled the
    // old way: the file is named after the duplicate's old id and the source inside it is the source's.
    // Nothing rewrites a file outside the database, so migration v13 has moved the receipt on and left
    // the marker behind. Comparing the two raw throws out of recovery and the app never starts.
    const legacyId = (id: string) => `bot-${id.slice("agent-".length)}`;
    await writeFile(
      join(userData, "agent-duplications", `${legacyId(duplicate.id)}.pending`),
      `${JSON.stringify({ operationId, sourceBotId: legacyId(source.id) })}\n`,
    );

    const recovered = new AgentStore(userData, home);
    await recovered.initialize();

    expect(recovered.list().map((agent) => agent.id)).toEqual(expect.arrayContaining([source.id, duplicate.id]));
    await expect(readFile(join(duplicate.workspacePath, "note.txt"), "utf8")).resolves.toBe("duplicate\n");
    await expect(readdir(join(userData, "agent-duplications"))).resolves.toEqual([]);
  });

  it("returns the committed duplicate for the same operation after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-idempotency-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const home = join(root, "home");
    const operationId = randomUUID();
    const store = new AgentStore(userData, home);
    await store.initialize();
    const source = await store.getOrCreate("chief");
    const duplicate = await store.duplicateAgent(source.id, operationId);
    const committed = await store.commitAgentDuplication(duplicate.id, operationId, source.id, EMPTY_LAYOUT);
    const currentAgent = await store.updateAgent({ agentId: duplicate.id, title: "Current title" });

    // A receipt a released build stamped spells these two keys `sourceBotId` and `bot`; migration v13
    // rewrote id values but never key names, so the row survives the upgrade in this shape. Reading only
    // the current spelling would throw "The agent duplication receipt is invalid." on the first retry of
    // a duplication that had already committed, instead of handing back the copy the user has.
    store.database.connection
      .prepare("UPDATE orchestration_command_receipts SET result_json = ? WHERE command_id = ?")
      .run(
        JSON.stringify({ sourceBotId: source.id, result: { bot: committed.agent, layout: committed.layout } }),
        `agent-duplication:${operationId}`,
      );

    const restored = new AgentStore(userData, home);
    await restored.initialize();

    expect(restored.committedAgentDuplication(operationId, source.id)).toEqual({ ...committed, agent: currentAgent });
    expect(restored.list().filter((agent) => agent.name === duplicate.name)).toHaveLength(1);

    await restored.deleteAgent(duplicate.id);

    expect(restored.committedAgentDuplication(operationId, source.id)).toBeNull();
  });

  it("removes a partial duplicate when profile persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-rollback-"));
    temporaryRoots.push(root);
    const home = join(root, "home");
    const store = new AgentStore(join(root, "user-data"), home);
    await store.initialize();
    const source = await store.getOrCreate("chief");
    await writeFile(join(source.workspacePath, "note.txt"), "keep\n");
    vi.spyOn(store.database, "replaceAgents").mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });

    await expect(store.duplicateAgent(source.id)).rejects.toThrow("database unavailable");

    expect(store.list().map((agent) => agent.id)).toEqual([source.id]);
    expect(await readdir(join(home, "OpenBot", "Agents"))).toEqual([source.id]);
    await expect(readFile(join(source.workspacePath, "note.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("duplicates an agent whose preview moves while its workspace is being copied", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-preview-"));
    temporaryRoots.push(root);
    const store = new AgentStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    const source = await store.getOrCreate("chief", "Research", "Research lead");
    await writeFile(join(source.workspacePath, "note.txt"), "keep\n");
    const resolveAvatar = store.resolveAvatar.bind(store);
    vi.spyOn(store, "resolveAvatar").mockImplementationOnce((agentId) => {
      // A message landing mid-copy moves `preview`, `updatedAt` and `threadId`. Copying a real
      // workspace takes seconds, so this window is wide enough to hit in ordinary use.
      void store.updatePreview(source.id, "Where are we on the sources?");
      return resolveAvatar(agentId);
    });

    const duplicate = await store.duplicateAgent(source.id);

    expect(duplicate).toMatchObject({ name: "Research copy", preview: "No messages yet", threadId: null });
    await expect(readFile(join(duplicate.workspacePath, "note.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("removes the copy when a duplicated profile field changes while the workspace is being copied", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-profile-"));
    temporaryRoots.push(root);
    const home = join(root, "home");
    const store = new AgentStore(join(root, "user-data"), home);
    await store.initialize();
    const source = await store.getOrCreate("chief", "Research", "Research lead");
    const resolveAvatar = store.resolveAvatar.bind(store);
    vi.spyOn(store, "resolveAvatar").mockImplementationOnce((agentId) => {
      void store.updateAgent({ agentId: source.id, description: "Finds primary sources." });
      return resolveAvatar(agentId);
    });

    await expect(store.duplicateAgent(source.id)).rejects.toThrow("changed while it was being duplicated");

    expect(store.list().map((agent) => agent.id)).toEqual([source.id]);
    expect(await readdir(join(home, "OpenBot", "Agents"))).toEqual([source.id]);
  });

  it("rejects duplication after the host reaches its agent limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-duplicate-limit-"));
    temporaryRoots.push(root);
    const store = new AgentStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    const source = await store.getOrCreate("agent-0");
    for (let index = 1; index < INPUT_LIMITS.agents; index += 1) {
      await store.getOrCreate(`agent-${index}`);
    }

    await expect(store.duplicateAgent(source.id)).rejects.toThrow(`up to ${INPUT_LIMITS.agents} agents`);
    expect(store.list()).toHaveLength(INPUT_LIMITS.agents);
  });

  it("validates the complete Agent profile before it writes data", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new AgentStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();

    await expect(store.createAgent({ ...AGENT_PROFILE_INPUT, name: " " })).rejects.toThrow("Agent name is required.");
    await expect(store.createAgent({ ...AGENT_PROFILE_INPUT, description: " " })).rejects.toThrow(
      "Agent description is required.",
    );
    await expect(store.createAgent({ ...AGENT_PROFILE_INPUT, avatarSeed: "" })).rejects.toThrow("Invalid avatar seed.");
    expect(store.list()).toEqual([]);
  });

  it("rejects path traversal agent ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new AgentStore(join(root, "data"), join(root, "home"));
    await store.initialize();

    await expect(store.getOrCreate("../outside")).rejects.toThrow("Invalid agent id");
  });

  it("fails closed instead of overwriting agent state from a newer version", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const statePath = join(userData, "bots.json");
    const unsupported = '{"version":999,"examplesInitialized":true,"bots":[]}\n';
    await mkdir(userData, { recursive: true });
    await writeFile(statePath, unsupported);

    const store = new AgentStore(userData, join(root, "home"));
    await expect(store.initialize()).rejects.toThrow("refusing to overwrite");
    await expect(readFile(statePath, "utf8")).resolves.toBe(unsupported);
  });

  it("persists editable agent settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const userData = join(root, "user-data");
    const store = new AgentStore(userData, join(root, "home"));
    await store.initialize();

    await store.getOrCreate("chief");
    await store.updateAgent({
      agentId: "chief",
      name: "Coordinator",
      title: "Operations lead",
      description: "Keeps the team aligned",
      notifications: false,
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      avatarSeed: "chief:avatar:2:4",
      avatarHue: 215,
    });
    const restored = new AgentStore(userData, join(root, "home"));
    await restored.initialize();
    expect(restored.list().find((agent) => agent.id === "chief")).toMatchObject({
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
    const store = new AgentStore(userData, join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");
    const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const updated = await store.setAvatar("chief", { mimeType: "image/png", bytes: image });
    expect(updated.avatarUrl).toMatch(/^openbot-avatar:\/\/agent\/chief\?v=/u);
    const storedAvatar = store.resolveAvatar("chief");
    expect(storedAvatar?.mimeType).toBe("image/png");
    await expect(readFile(storedAvatar?.path ?? "")).resolves.toEqual(Buffer.from(image));

    const restored = new AgentStore(userData, join(root, "home"));
    await restored.initialize();
    expect(restored.list().find((agent) => agent.id === "chief")?.avatarUrl).toBe(updated.avatarUrl);
    const restoredPath = restored.resolveAvatar("chief")?.path ?? "";
    await restored.setAvatar("chief", null);
    expect(restored.list().find((agent) => agent.id === "chief")?.avatarUrl).toBeNull();
    await expect(readFile(restoredPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the previous avatar when SQLite persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new AgentStore(join(root, "user-data"), join(root, "home"));
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
    expect(store.list().find((agent) => agent.id === "chief")).toMatchObject({
      avatarUrl: original.avatarUrl,
      updatedAt: original.updatedAt,
    });
    await expect(readFile(originalAvatar?.path ?? "")).resolves.toEqual(Buffer.from(image));

    await expect(store.setAvatar("chief", null)).rejects.toThrow("database unavailable");
    expect(store.list().find((agent) => agent.id === "chief")?.avatarUrl).toBe(original.avatarUrl);
    await expect(readFile(originalAvatar?.path ?? "")).resolves.toEqual(Buffer.from(image));
  });

  it("rejects agent fields above their limits without truncating stored values", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new AgentStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");

    await expect(store.updateAgent({ agentId: "chief", name: "x".repeat(INPUT_LIMITS.agentName + 1) })).rejects.toThrow(
      "Agent name is too long",
    );
    await expect(
      store.updateAgent({
        agentId: "chief",
        description: "x".repeat(INPUT_LIMITS.agentDescription + 1),
      }),
    ).rejects.toThrow("Agent description is too long");
    expect(store.list().find((agent) => agent.id === "chief")).toMatchObject({
      name: "Chief",
      description: "",
    });
  });

  it("keeps the OpenBot thread when the model changes provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new AgentStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");
    const threadId = await store.ensureThreadId("chief");

    const claude = await store.updateAgent({ agentId: "chief", provider: "claude", model: "claude-sonnet-5" });
    expect(claude.threadId).toBe(threadId);

    const opus = await store.updateAgent({ agentId: "chief", provider: "claude", model: "claude-opus-5" });
    expect(opus.threadId).toBe(threadId);
  });

  it("keeps provider sessions private and creates a new session when returning", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-store-"));
    temporaryRoots.push(root);
    const store = new AgentStore(join(root, "user-data"), join(root, "home"));
    await store.initialize();
    await store.getOrCreate("chief");
    const publicThreadId = await store.ensureThreadId("chief");
    store.bindProviderSession("chief", "codex-native-1");
    store.database.deactivateProviderSessions(publicThreadId);

    await store.updateAgent({ agentId: "chief", provider: "claude", model: "claude-sonnet-5" });
    store.bindProviderSession("chief", "claude-native-1");
    store.database.deactivateProviderSessions(publicThreadId);
    await store.updateAgent({ agentId: "chief", provider: "codex", model: "gpt-5.6-sol" });
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
    const store = new AgentStore(userData, home);
    await store.initialize();

    const agent = await store.createAgent(AGENT_PROFILE_INPUT);
    await writeFile(join(agent.workspacePath, "generated.txt"), "workspace data");

    // Deleting an agent also clears the directories a pre-rename build would have given it, and that name
    // is derived from this id's own spelling. `bot-<uuid>` is a valid id in its own right, so a second
    // agent can be sitting under exactly that derived name -- and these are recursive deletes.
    const sibling = `bot-${agent.id.slice("agent-".length)}`;
    await store.getOrCreate(sibling);
    const siblingLegacyWorkspace = join(home, "OpenBot", "Bots", sibling);
    await mkdir(siblingLegacyWorkspace, { recursive: true });
    await writeFile(join(siblingLegacyWorkspace, "notes.md"), "sibling data");
    await mkdir(join(userData, "avatars", sibling), { recursive: true });
    await writeFile(join(userData, "avatars", sibling, "avatar.png"), "sibling face");

    await store.deleteAgent(agent.id);
    expect(store.list().map((entry) => entry.id)).toEqual([sibling]);
    await expect(readFile(join(agent.workspacePath, "generated.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(siblingLegacyWorkspace, "notes.md"), "utf8")).resolves.toBe("sibling data");
    await expect(readFile(join(userData, "avatars", sibling, "avatar.png"), "utf8")).resolves.toBe("sibling face");

    // A legacy import keeps the id it read and the `~/OpenBot/Bots/<id>` workspace that came with it, so
    // for that agent the pre-rename root is where its files actually are. Deleting only the derived
    // directory would report success and leave the workspace on disk.
    await store.deleteAgent(sibling);
    await expect(readFile(join(siblingLegacyWorkspace, "notes.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const restored = new AgentStore(userData, home);
    await restored.initialize();
    expect(restored.list()).toEqual([]);
  });
});
