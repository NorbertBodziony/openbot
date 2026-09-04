// @vitest-environment node
import type { AgentEvent } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProvider } from "../agent-client";
import { AgentService } from "../agent-service";
import {
  FakeAgentClient,
  fakeBrowser,
  notification,
  startAgentTestFixture,
  stopAgentTestFixture,
  stores,
  waitFor,
} from "../agent-service-test-harness";

let root: string;
let service: AgentService | null = null;

beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
});

afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});

describe.sequential("AgentMemories: staging, epochs and turn commitment", () => {
  it("commits an automatic memory only after a successful turn and refreshes the next turn context", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "DONE", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "I prefer concise status updates." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The memory test turn did not start.");
    const startRequest = client.requests.find((request) => request.method === "thread/start");
    expect(JSON.stringify(startRequest?.params)).toContain('"name":"remember"');
    expect(JSON.stringify(startRequest?.params)).toContain('"name":"forget_memory"');

    client.emit("request", {
      method: "item/tool/call",
      id: "remember-request",
      params: {
        threadId,
        turnId,
        callId: "remember-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { text: "The user prefers concise status updates." },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "remember-request"));
    expect(service.listMemories("chief")).toEqual([]);

    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } }),
    );
    await waitFor(() => service?.listMemories("chief").length === 1);
    expect(events).toContainEqual({ type: "memories-changed", botId: "chief" });

    await service.sendMessage({ botId: "chief", text: "Prepare an update." });
    await waitFor(() => client.requests.filter((request) => request.method === "thread/resume").length > 0);
    const resume = client.requests.findLast((request) => request.method === "thread/resume");
    expect(JSON.stringify(resume?.params)).toContain("The user prefers concise status updates.");
  });

  it("discards staged memories after a failed turn and preserves a concurrent manual edit", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider, "DONE", false);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await store.getOrCreate("chief");
    const manual = service.createMemory({ botId: "chief", text: "Use Bun for scripts." });
    await store.getOrCreate("research");
    const otherMemory = service.createMemory({ botId: "research", text: "Research-only memory." });
    await service.sendMessage({ botId: "chief", text: "Change my package manager preference." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The memory conflict turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "foreign-memory-request",
      params: {
        threadId,
        turnId,
        callId: "foreign-memory-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { memoryId: otherMemory.id, text: "Changed by another agent." },
      },
    });
    await waitFor(() => client.errors.some((response) => response.id === "foreign-memory-request"));
    expect(service.listMemories("research").map((memory) => memory.text)).toEqual(["Research-only memory."]);

    client.emit("request", {
      method: "item/tool/call",
      id: "update-memory-request",
      params: {
        threadId,
        turnId,
        callId: "update-memory-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { memoryId: manual.id, text: "Use npm for scripts." },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "update-memory-request"));
    service.updateMemory({ botId: "chief", memoryId: manual.id, text: "Use Bun 1.3 for scripts." });
    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } }),
    );
    await waitFor(() => events.some((event) => event.type === "turn-completed"));
    expect(service.listMemories("chief").map((memory) => memory.text)).toEqual(["Use Bun 1.3 for scripts."]);

    await service.sendMessage({ botId: "chief", text: "Remember one temporary value." });
    await waitFor(() => events.filter((event) => event.type === "turn-started").length === 2);
    const failedTurnId = events.filter((event) => event.type === "turn-started")[1]?.turnId;
    if (!failedTurnId) throw new Error("The failed memory turn did not start.");
    client.emit("request", {
      method: "item/tool/call",
      id: "failed-memory-request",
      params: {
        threadId,
        turnId: failedTurnId,
        callId: "failed-memory-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { text: "This must not persist." },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "failed-memory-request"));
    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: failedTurnId, status: "failed" } }),
    );
    await waitFor(() => events.filter((event) => event.type === "turn-completed").length === 2);
    expect(service.listMemories("chief").map((memory) => memory.text)).toEqual(["Use Bun 1.3 for scripts."]);

    await service.sendMessage({ botId: "chief", text: "Remember a value, then stop." });
    await waitFor(() => events.filter((event) => event.type === "turn-started").length === 3);
    const interruptedTurnId = events.filter((event) => event.type === "turn-started")[2]?.turnId;
    if (!interruptedTurnId) throw new Error("The interrupted memory turn did not start.");
    client.emit("request", {
      method: "item/tool/call",
      id: "interrupted-memory-request",
      params: {
        threadId,
        turnId: interruptedTurnId,
        callId: "interrupted-memory-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { text: "This interrupted value must not persist." },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "interrupted-memory-request"));
    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: interruptedTurnId, status: "interrupted" } }),
    );
    await waitFor(() => events.filter((event) => event.type === "turn-completed").length === 3);
    expect(service.listMemories("chief").map((memory) => memory.text)).toEqual(["Use Bun 1.3 for scripts."]);

    await service.sendMessage({ botId: "chief", text: "Remember a value while I clear memory." });
    await waitFor(() => events.filter((event) => event.type === "turn-started").length === 4);
    const clearedTurnId = events.filter((event) => event.type === "turn-started")[3]?.turnId;
    if (!clearedTurnId) throw new Error("The clear-memory turn did not start.");
    client.emit("request", {
      method: "item/tool/call",
      id: "cleared-memory-request",
      params: {
        threadId,
        turnId: clearedTurnId,
        callId: "cleared-memory-call",
        namespace: "openbot",
        tool: "remember",
        arguments: { text: "This staged value must not return after clear." },
      },
    });
    await waitFor(() => client.responses.some((response) => response.id === "cleared-memory-request"));
    const memoryEventCount = events.filter((event) => event.type === "memories-changed").length;
    service.clearMemories("chief");
    expect(service.listMemories("chief")).toEqual([]);
    expect(events.filter((event) => event.type === "memories-changed")).toHaveLength(memoryEventCount + 1);
    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: clearedTurnId, status: "completed" } }),
    );
    await waitFor(() => events.filter((event) => event.type === "turn-completed").length === 4);
    expect(service.listMemories("chief")).toEqual([]);
    expect(events.filter((event) => event.type === "memories-changed")).toHaveLength(memoryEventCount + 1);
  });
});
