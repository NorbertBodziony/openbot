import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarLayoutStore } from "./sidebar-layout-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(): Promise<{ root: string; path: string; store: SidebarLayoutStore }> {
  const root = await mkdtemp(join(tmpdir(), "openbot-sidebar-layout-"));
  roots.push(root);
  const path = join(root, "sidebar-layout.json");
  const store = new SidebarLayoutStore(path);
  await store.initialize();
  return { root, path, store };
}

describe("SidebarLayoutStore", () => {
  it("persists shared sections, assignments, names, and the complete order", async () => {
    const { path, store } = await createStore();
    const agents = new Set(["chief", "research"]);

    const created = await store.mutate({ type: "create", name: "Demo", agentId: "chief" }, agents);
    const section = created.sections[0];
    expect(section).toBeDefined();
    expect(created.order).toEqual([SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID, section?.id]);
    expect(created.agentAssignments).toEqual({ chief: section?.id });

    await store.mutate({ type: "rename", sectionId: section?.id ?? "", name: "Core" }, agents);
    await store.mutate({ type: "move", sectionId: section?.id ?? "", direction: "up" }, agents);
    await store.mutate({ type: "assign", agentId: "research", sectionId: section?.id ?? "" }, agents);

    const restored = new SidebarLayoutStore(path);
    await restored.initialize();
    expect(restored.getSnapshot()).toMatchObject({
      revision: 4,
      sections: [{ id: section?.id, name: "Core" }],
      order: [SIDEBAR_PEOPLE_SECTION_ID, section?.id, SIDEBAR_UNASSIGNED_SECTION_ID],
      agentAssignments: { chief: section?.id, research: section?.id },
      agentOrder: [],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 2, revision: 4 });
  });

  it("persists agent order inside a section", async () => {
    const { path, store } = await createStore();
    const agents = new Set(["chief", "research", "sales"]);
    const created = await store.mutate({ type: "create", name: "Demo", agentId: "chief" }, agents);
    const sectionId = created.sections[0]?.id ?? "";
    await store.mutate({ type: "assign", agentId: "research", sectionId }, agents);

    const moved = await store.mutate(
      { type: "move-agent", agentId: "research", sectionId, beforeAgentId: "chief" },
      agents,
    );
    expect(moved.agentOrder).toEqual(["research", "chief", "sales"]);

    const restored = new SidebarLayoutStore(path);
    await restored.initialize();
    expect(restored.getSnapshot().agentOrder).toEqual(["research", "chief", "sales"]);
  });

  it("places a duplicate after its source in the same section", async () => {
    const { store } = await createStore();
    const agents = new Set(["chief", "chief-copy", "research", "sales"]);
    const created = await store.mutate({ type: "create", name: "Core", agentId: "chief" }, agents);
    const sectionId = created.sections[0]?.id ?? "";
    await store.mutate({ type: "assign", agentId: "research", sectionId }, agents);
    await store.mutate({ type: "move-agent", agentId: "sales", sectionId: null, beforeAgentId: null }, agents);

    const duplicated = await store.placeDuplicateAfter("chief", "chief-copy", [
      "chief",
      "chief-copy",
      "research",
      "sales",
    ]);

    expect(duplicated.agentAssignments).toMatchObject({ chief: sectionId, "chief-copy": sectionId });
    expect(duplicated.agentOrder.filter((agentId) => agentId !== "sales")).toEqual(["chief", "chief-copy", "research"]);
  });

  it("loads a version 1 layout with an empty agent order", async () => {
    const { path } = await createStore();
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        revision: 2,
        sections: [{ id: "11111111-1111-4111-8111-111111111111", name: "Demo" }],
        order: [SIDEBAR_PEOPLE_SECTION_ID, "11111111-1111-4111-8111-111111111111", SIDEBAR_UNASSIGNED_SECTION_ID],
        agentAssignments: { chief: "11111111-1111-4111-8111-111111111111" },
      })}\n`,
    );

    const restored = new SidebarLayoutStore(path);
    await restored.initialize();
    expect(restored.getSnapshot().agentOrder).toEqual([]);
    expect(restored.getSnapshot().agentAssignments).toEqual({
      chief: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("keeps names unique and validates agents", async () => {
    const { store } = await createStore();
    const agents = new Set(["chief"]);
    await store.mutate({ type: "create", name: "Demo" }, agents);

    await expect(store.mutate({ type: "create", name: " demo " }, agents)).rejects.toThrow(
      "Section names must be unique",
    );
    await expect(store.mutate({ type: "create", name: "Other", agentId: "missing" }, agents)).rejects.toThrow(
      "Unknown agent",
    );
    await expect(store.mutate({ type: "assign", agentId: "missing", sectionId: null }, agents)).rejects.toThrow(
      "Unknown agent",
    );
  });

  it("moves a section across multiple order positions in one revision", async () => {
    const { store } = await createStore();
    const agents = new Set<string>();
    await store.mutate({ type: "create", name: "One" }, agents);
    const created = await store.mutate({ type: "create", name: "Two" }, agents);
    const firstId = created.sections[0]?.id ?? "";
    const secondId = created.sections[1]?.id ?? "";

    const moved = await store.mutate({ type: "move", sectionId: secondId, direction: "up", steps: 2 }, agents);

    expect(moved.revision).toBe(3);
    expect(moved.order).toEqual([SIDEBAR_PEOPLE_SECTION_ID, secondId, SIDEBAR_UNASSIGNED_SECTION_ID, firstId]);
  });

  it("deletes only the section and returns its agents to Unassigned", async () => {
    const { store } = await createStore();
    const agents = new Set(["chief"]);
    const created = await store.mutate({ type: "create", name: "Demo", agentId: "chief" }, agents);
    const sectionId = created.sections[0]?.id ?? "";

    const deleted = await store.mutate({ type: "delete", sectionId }, agents);
    expect(deleted.sections).toEqual([]);
    expect(deleted.order).toEqual([SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID]);
    expect(deleted.agentAssignments).toEqual({});
  });

  it("serializes concurrent mutations and removes assignments for deleted agents", async () => {
    const { store } = await createStore();
    const agents = new Set(["chief", "research"]);
    const [first, second] = await Promise.all([
      store.mutate({ type: "create", name: "One", agentId: "chief" }, agents),
      store.mutate({ type: "create", name: "Two", agentId: "research" }, agents),
    ]);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    const cleaned = await store.removeAgent("chief");
    expect(cleaned.revision).toBe(3);
    expect(cleaned.agentAssignments).not.toHaveProperty("chief");
    expect(cleaned.agentAssignments).toHaveProperty("research");
  });

  it("refiles an agent migration v13 renamed instead of unfiling it", async () => {
    const { store } = await createStore();
    const legacyId = "bot-6d3e8b17-9c04-4f21-8a55-1b2c3d4e5f60";
    const currentId = "agent-6d3e8b17-9c04-4f21-8a55-1b2c3d4e5f60";
    const created = await store.mutate(
      { type: "create", name: "Research", agentId: legacyId },
      new Set([legacyId, "chief"]),
    );
    const sectionId = created.agentAssignments[legacyId];
    const ordered = await store.mutate(
      { type: "move-agent", agentId: legacyId, sectionId: sectionId ?? null, beforeAgentId: null },
      new Set([legacyId, "chief"]),
    );
    expect(ordered.agentOrder).toContain(legacyId);

    // This layout is a JSON file outside the database, so v13 renamed the agent in SQLite and left the
    // sidebar filing it under the old id. Reading that as "the agent is gone" throws away the group the
    // user put it in and its position, with nothing to undo it.
    const reconciled = await store.reconcileAgents(new Set([currentId, "chief"]));

    expect(reconciled.agentAssignments[currentId]).toBe(sectionId);
    expect(reconciled.agentOrder).toContain(currentId);

    // v13 declines to rename onto an id that is taken, so both agents can be in the roster at once -- and
    // then the old spelling belongs to the agent that still answers to it, not to its twin.
    const collided = await createStore();
    await collided.store.mutate({ type: "create", name: "Research", agentId: legacyId }, new Set([legacyId]));
    const kept = await collided.store.reconcileAgents(new Set([currentId, legacyId]));

    expect(kept.agentAssignments).toHaveProperty(legacyId);
    expect(kept.agentAssignments).not.toHaveProperty(currentId);
  });

  it("backs up corrupt state and starts with the safe default", async () => {
    const { root, path } = await createStore();
    await writeFile(path, '{"version":1,"revision":"bad"}\n');

    const restored = new SidebarLayoutStore(path);
    await restored.initialize();

    expect(restored.getSnapshot()).toEqual({
      revision: 0,
      sections: [],
      order: [SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID],
      agentAssignments: {},
      agentOrder: [],
    });
    expect((await readdir(root)).some((name) => name.startsWith("sidebar-layout.json.corrupt-"))).toBe(true);
  });
});
