import { AGENT_RUNTIME_TEXT_LIMIT, type AgentEvent, isAgentEvent } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProvider } from "./agent-client";
import { AgentService } from "./agent-service";
import {
  FakeAgentClient,
  fakeBrowser,
  startAgentTestFixture,
  stopAgentTestFixture,
  stores,
  waitFor,
} from "./agent-service-test-harness";

let root: string;
let service: AgentService | null = null;

beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
});

afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});

describe.sequential("AgentService: approvals", () => {
  it("surfaces Codex approvals without auto-accepting and maps one-shot decisions", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser(), 30_000, "codex", (provider) => {
      const client = new FakeAgentClient(provider);
      clients.set(provider, client);
      return client;
    });
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Need an approval" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    if (!client) throw new Error("Codex client was not created.");
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!turnId) throw new Error("Turn did not start.");
    const externalId = store.activeProviderSession("chief")?.externalSessionId;
    if (!externalId) throw new Error("External thread did not start.");

    client.emit("request", {
      method: "item/commandExecution/requestApproval",
      id: "approval-command",
      params: {
        threadId: externalId,
        turnId,
        command: ["npm", "test"],
        cwd: "/tmp/openbot",
        reason: "r".repeat(1_000),
      },
    });
    await waitFor(() => events.some((event) => event.type === "approval"));
    expect(client.responses).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval",
        approval: expect.objectContaining({
          requestId: "approval-command",
          botId: "chief",
          kind: "command",
          command: "npm test",
          cwd: "/tmp/openbot",
        }),
      }),
    );
    expect(isAgentEvent({ type: "runtime-snapshot", snapshot: service.getRuntimeSnapshot() })).toBe(true);
    expect(service.getRuntimeSnapshot().pendingApprovals[0]?.reason).toHaveLength(AGENT_RUNTIME_TEXT_LIMIT);
    expect(service.getRuntimeSnapshot().pendingApprovals[0]?.truncated).toBe(true);

    await service.respondToApproval({ requestId: "approval-command", decision: "accept" });
    expect(client.responses).toEqual([{ id: "approval-command", result: { decision: "accept" } }]);
    expect(events).toContainEqual({
      type: "agent-input-resolved",
      kind: "approval",
      requestId: "approval-command",
      botId: "chief",
    });
    expect(events.findLast((event) => event.type === "runtime-snapshot")).toMatchObject({
      snapshot: { pendingApprovals: [] },
    });

    client.emit("request", {
      method: "item/permissions/requestApproval",
      id: "approval-permissions",
      params: {
        threadId: externalId,
        turnId,
        permissions: {
          fileSystem: { read: ["/tmp/openbot"], write: ["/tmp/openbot/out"] },
          network: { enabled: true },
        },
      },
    });
    await waitFor(() => events.filter((event) => event.type === "approval").length === 2);
    await service.respondToApproval({ requestId: "approval-permissions", decision: "decline" });
    expect(client.responses.at(-1)).toEqual({
      id: "approval-permissions",
      result: { permissions: {}, scope: "turn" },
    });
  });
});
