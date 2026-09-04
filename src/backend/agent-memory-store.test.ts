// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMemoryStore } from "./agent-memory-store";
import { AgentStore } from "./agent-store";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentMemoryStore", () => {
  it("creates, updates, and merges exact duplicates", async () => {
    const { database, memories } = await setup();
    const created = memories.createManual("chief", "The user prefers concise status updates.");

    expect(memories.list("chief")).toEqual([created]);
    expect(memories.createManual("chief", "  The user prefers concise status updates.  ")).toEqual(created);
    expect(memories.list("chief")).toHaveLength(1);

    const updated = memories.updateManual("chief", created.id, "The user prefers one-line status updates.");
    expect(updated).toMatchObject({ id: created.id, origin: "manual", sourceTurnId: null });
    expect(memories.list("chief").map((memory) => memory.text)).toEqual(["The user prefers one-line status updates."]);
    database.close();
  });

  it("does not merge texts that differ after input trimming", async () => {
    const { database, memories } = await setup();
    memories.createManual("chief", "The user prefers concise status updates.");
    memories.createManual("chief", "The user prefers concise  status updates.");

    expect(memories.list("chief")).toHaveLength(2);
    database.close();
  });

  it("does not overwrite a manual edit with a stale automatic mutation", async () => {
    const { database, memories } = await setup();
    const created = memories.createManual("chief", "Use Bun for package scripts.");
    const expectedUpdatedAt = created.updatedAt;
    const edited = memories.updateManual("chief", created.id, "Use Bun 1.3 for package scripts.");

    expect(
      memories.saveAutomatic({
        agentId: "chief",
        memoryId: created.id,
        text: "Use npm for package scripts.",
        sourceTurnId: "turn-1",
        expectedUpdatedAt,
      }),
    ).toBeNull();
    expect(memories.get("chief", created.id)).toEqual(edited);
    database.close();
  });

  it("updates a corrected memory without creating a conflicting entry", async () => {
    const { database, memories } = await setup();
    const created = memories.createManual("chief", "The subscription costs $200.");
    const corrected = memories.saveAutomatic({
      agentId: "chief",
      memoryId: created.id,
      text: "The subscription costs $300.",
      sourceTurnId: "turn-correction",
      expectedUpdatedAt: created.updatedAt,
    });

    expect(corrected).toMatchObject({ id: created.id, text: "The subscription costs $300." });
    expect(memories.list("chief")).toHaveLength(1);
    database.close();
  });

  it("keeps memories after the database restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-memory-restart-"));
    roots.push(root);
    const database = new OpenBotDatabase(root);
    await database.initialize();
    new AgentMemoryStore(database).createManual("chief", "Use metric units.");
    database.close();

    const reopened = new OpenBotDatabase(root);
    await reopened.initialize();
    expect(new AgentMemoryStore(reopened).list("chief").map((memory) => memory.text)).toEqual(["Use metric units."]);
    reopened.close();
  });

  it("enforces the per-agent memory limit", async () => {
    const { database, memories } = await setup();
    for (let index = 0; index < INPUT_LIMITS.agentMemories; index += 1) {
      memories.createManual("chief", `Stable memory ${index + 1}`);
    }

    expect(() => memories.createManual("chief", "One memory too many")).toThrow(
      `An agent can have up to ${INPUT_LIMITS.agentMemories} memories.`,
    );
    expect(memories.list("chief")).toHaveLength(INPUT_LIMITS.agentMemories);
    database.close();
  });

  it("hard-deletes memory text from projections and the event log", async () => {
    const { database, memories } = await setup();
    const secretText = "A unique saved memory value";
    const created = memories.createManual("chief", secretText);

    expect(memories.delete("chief", created.id)).toBe(true);
    expect(memories.list("chief")).toEqual([]);
    const eventPayloads = database.connection
      .prepare("SELECT payload_json FROM orchestration_events WHERE aggregate_id = ?")
      .all(created.id);
    expect(JSON.stringify(eventPayloads)).not.toContain(secretText);
    database.close();
  });

  it("atomically clears one agent without retaining memory text", async () => {
    const { database, memories } = await setup();
    const first = memories.createManual("chief", "First private memory value");
    const second = memories.createManual("chief", "Second private memory value");
    const other = memories.createManual("research", "Research memory stays");

    expect(memories.clear("chief")).toBe(2);
    expect(memories.clear("chief")).toBe(0);
    expect(memories.list("chief")).toEqual([]);
    expect(memories.list("research")).toEqual([other]);

    for (const memory of [first, second]) {
      const eventPayloads = database.connection
        .prepare("SELECT payload_json FROM orchestration_events WHERE aggregate_id = ?")
        .all(memory.id);
      expect(JSON.stringify(eventPayloads)).not.toContain(memory.text);
      expect(eventPayloads).toHaveLength(1);
    }
    database.close();
  });

  it("removes every memory and memory event when its agent is deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-memory-delete-agent-"));
    roots.push(root);
    const agentStore = new AgentStore(join(root, "data"), join(root, "home"));
    await agentStore.initialize();
    const agent = await agentStore.getOrCreate("chief");
    const memories = new AgentMemoryStore(agentStore.database);
    const created = memories.createManual(agent.id, "Remove this with the agent.");

    await agentStore.deleteAgent(agent.id);

    expect(memories.list(agent.id)).toEqual([]);
    expect(
      agentStore.database.connection
        .prepare("SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_id = ?")
        .get(created.id),
    ).toMatchObject({ count: 0 });
    agentStore.database.close();
  });
});

async function setup(): Promise<{ database: OpenBotDatabase; memories: AgentMemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "openbot-memory-store-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await database.initialize();
  return { database, memories: new AgentMemoryStore(database) };
}
