// @vitest-environment node

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../shared/ipc";
import { AgentService } from "./agent-service";
import { BotStore } from "./bot-store";
import type { BrowserHost } from "./browser-host";
import { MailboxStore } from "./mailbox-store";

let root: string;
let logPath: string;
let service: AgentService | null = null;
const originalCodexPath = process.env.INFELD_CODEX_PATH;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "infeld-agent-test-"));
  logPath = join(root, "protocol.jsonl");
  process.env.INFELD_FAKE_CODEX_LOG = logPath;
  process.env.INFELD_CODEX_PATH = await createFakeCodex(root);
});

afterEach(async () => {
  await service?.stop();
  service = null;
  if (originalCodexPath === undefined) delete process.env.INFELD_CODEX_PATH;
  else process.env.INFELD_CODEX_PATH = originalCodexPath;
  delete process.env.INFELD_FAKE_CODEX_LOG;
  delete process.env.INFELD_FAKE_AGENT_TOOL;
  delete process.env.INFELD_FAKE_THREAD_READ_DELAY;
  await rm(root, { recursive: true, force: true });
});

describe.sequential("AgentService", () => {
  it("creates independent full-access threads with browser and Infeld tools", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), () => ({
      screenRecording: true,
      accessibility: true,
    }));
    await service.initialize();

    expect(service.getStatus()).toMatchObject({
      phase: "ready",
      auth: { kind: "chatgpt" },
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
    });
    await service.sendMessage({ botId: "chief", text: "First task" });
    await service.sendMessage({ botId: "sales-outbound", text: "Second task" });
    await waitFor(
      async () =>
        (await protocolMessages()).filter((item) => item.method === "turn/start").length === 2,
    );

    const requests = await protocolMessages();
    const starts = requests.filter((message) => message.method === "thread/start");
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      const params = start.params as Record<string, unknown>;
      expect(params).toMatchObject({
        model: "gpt-5.6-luna",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: false,
        serviceName: "infeld_bot",
      });
      expect(params.dynamicTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "namespace", name: "infeld_browser" }),
          expect.objectContaining({ type: "namespace", name: "infeld" }),
        ]),
      );
    }
    for (const turn of requests.filter((message) => message.method === "turn/start")) {
      expect(turn.params).toMatchObject({ model: "gpt-5.6-luna", effort: "medium" });
    }
    expect((await store.getOrCreate("chief")).threadId).not.toBe(
      (await store.getOrCreate("sales-outbound")).threadId,
    );
  });

  it("starts a new thread with the persisted onboarding remit", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await service.updateBot({
      botId: "chief",
      role: "Research & writing",
      description: "Researches topics and turns findings into clear writing.",
    });

    await service.sendMessage({
      botId: "chief",
      text: "Focus on research and writing.",
    });
    await waitFor(async () =>
      (await protocolMessages()).some((message) => message.method === "thread/start"),
    );

    const start = (await protocolMessages()).find((message) => message.method === "thread/start");
    const instructions = String(
      (start?.params as Record<string, unknown> | undefined)?.developerInstructions ?? "",
    );
    expect(instructions).toContain('"title": "Research & writing"');
    expect(instructions).toContain(
      '"description": "Researches topics and turns findings into clear writing."',
    );
    expect(instructions).toContain("standing remit");
  });

  it("queues FIFO instead of steering and pause/resume controls draining", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "Start" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const active = events.find((event) => event.type === "turn-started");
    if (active?.type !== "turn-started") throw new Error("Turn did not start.");
    await service.sendMessage({ botId: "chief", text: "Run after the first task" });

    let queue = service.listQueue("chief");
    expect(queue.deliveries.map((item) => item.status)).toEqual(["running", "queued"]);
    expect((await protocolMessages()).some((message) => message.method === "turn/steer")).toBe(
      false,
    );

    await service.interrupt("chief", active.turnId);
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "interrupted");
    queue = service.listQueue("chief");
    expect(queue.paused).toBe(true);
    expect(queue.deliveries[1]?.status).toBe("queued");

    await service.setQueuePaused("chief", false);
    await waitFor(
      async () =>
        (await protocolMessages()).filter((item) => item.method === "turn/start").length === 2,
    );
    expect(service.listQueue("chief").deliveries[1]?.status).toBe("running");

    const conversationSignatures = events
      .filter((event) => event.type === "conversation" && event.snapshot.botId === "chief")
      .map((event) =>
        event.type === "conversation"
          ? JSON.stringify({
              threadId: event.snapshot.threadId,
              activeTurnId: event.snapshot.activeTurnId,
              messages: event.snapshot.messages,
            })
          : "",
      );
    for (let index = 1; index < conversationSignatures.length; index += 1) {
      expect(conversationSignatures[index]).not.toBe(conversationSignatures[index - 1]);
    }
  });

  it("fans out an idempotent agent tool message to other persistent bots", async () => {
    process.env.INFELD_FAKE_AGENT_TOOL = "1";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Coordinate the team" });

    await waitFor(async () => {
      const messages = await protocolMessages();
      return messages.some((message) => message.id === "agent-tool-1" && message.result);
    });
    await waitFor(() => service?.listQueue("sales-outbound").deliveries.length === 1);
    await waitFor(() => service?.listQueue("inbox-manager").deliveries.length === 1);

    const sales = service.listQueue("sales-outbound").deliveries[0];
    const inbox = service.listQueue("inbox-manager").deliveries[0];
    expect(sales.messageId).toBe(inbox.messageId);
    expect(sales.sender).toEqual({ kind: "bot", botId: "chief" });
    expect(sales.text).toBe("Please prepare your reports.");

    const chiefMessages = (await service.readConversation("chief")).messages;
    expect(chiefMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exchange: expect.objectContaining({ direction: "outgoing" }) }),
      ]),
    );
    expect(
      chiefMessages.findIndex((message) => message.exchange?.direction === "outgoing"),
    ).toBeLessThan(chiefMessages.findIndex((message) => message.author === "assistant"));
    expect((await service.readConversation("sales-outbound")).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          senderBotId: "chief",
          exchange: expect.objectContaining({ direction: "incoming" }),
        }),
      ]),
    );

    const starts = (await protocolMessages()).filter((message) => message.method === "turn/start");
    const salesStart = starts.find((message) =>
      String((message.params as Record<string, unknown>).cwd).endsWith("/sales-outbound"),
    );
    const salesInput = (salesStart?.params as Record<string, unknown> | undefined)?.input as
      | Array<Record<string, unknown>>
      | undefined;
    expect(salesInput?.[0]?.text).toContain(
      "After completing the request, send a concise result back to Chief",
    );
    expect(salesInput?.[0]?.text).toContain(`replyToMessageId "${sales.messageId}"`);
  });

  it("merges a late thread read with a newer active stream", async () => {
    process.env.INFELD_FAKE_THREAD_READ_DELAY = "80";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "First turn" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");
    const firstTurnId = service.listQueue("chief").deliveries[0]?.turnId;
    if (!firstTurnId) throw new Error("First turn did not start.");
    await service.interrupt("chief", firstTurnId);
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "interrupted");
    await service.setQueuePaused("chief", false);

    const readsBefore = (await protocolMessages()).filter(
      (message) => message.method === "thread/read",
    ).length;
    const refresh = service.readConversation("chief");
    await waitFor(
      async () =>
        (await protocolMessages()).filter((message) => message.method === "thread/read").length >
        readsBefore,
    );
    await service.sendMessage({ botId: "chief", text: "New live turn" });
    await waitFor(() => service?.listQueue("chief").deliveries[1]?.status === "running");

    const snapshot = await refresh;
    expect(snapshot.activeTurnId).toBe(service.listQueue("chief").deliveries[1]?.turnId);
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Streaming", status: "streaming" })]),
    );
  });

  it("resumes stored threads and does not replay an uncertain running delivery", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Remember this" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");
    const threadId = (await store.getOrCreate("chief")).threadId;
    await service.stop();

    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    expect(service.listQueue("chief").deliveries[0]?.status).toBe("interrupted");
    await service.sendMessage({ botId: "chief", text: "Continue" });
    await waitFor(async () =>
      (await protocolMessages()).some((message) => message.method === "thread/resume"),
    );
    const resume = (await protocolMessages()).find((message) => message.method === "thread/resume");
    expect(resume?.params).toMatchObject({
      dynamicTools: expect.arrayContaining([
        expect.objectContaining({ type: "namespace", name: "infeld_browser" }),
        expect.objectContaining({ type: "namespace", name: "infeld" }),
      ]),
    });
    expect((await store.getOrCreate("chief")).threadId).toBe(threadId);
  });

  it("deletes idle bots and refuses to orphan active work", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    await service.deleteBot("sales-outbound");
    expect(service.listBots().some((bot) => bot.id === "sales-outbound")).toBe(false);

    await service.sendMessage({ botId: "chief", text: "Keep working" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "running");
    await expect(service.deleteBot("chief")).rejects.toThrow(
      "Stop the agent and cancel its queued messages before deleting it.",
    );
    expect(service.listBots().some((bot) => bot.id === "chief")).toBe(true);
  });
});

function stores(): { store: BotStore; mailbox: MailboxStore } {
  const store = new BotStore(join(root, "user-data"), join(root, "home"));
  return { store, mailbox: new MailboxStore(join(root, "user-data"), store.sharedRoot) };
}

function fakeBrowser(): BrowserHost {
  return {
    onChanged: () => () => undefined,
    onControlChanged: () => () => undefined,
    clearControls: () => undefined,
    endControl: () => undefined,
    handleDynamicTool: async () => ({ success: true, contentItems: [] }),
  } as unknown as BrowserHost;
}

async function protocolMessages(): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(
  check: () => boolean | undefined | Promise<boolean | undefined>,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the fake App Server.");
}

async function createFakeCodex(directory: string): Promise<string> {
  const executable = join(directory, "codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.144.1\\n");
  process.exit(0);
}
const log = process.env.INFELD_FAKE_CODEX_LOG;
let buffer = "";
let threadCounter = 0;
let turnCounter = 0;
const turns = new Map();
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      fs.appendFileSync(log, JSON.stringify(message) + "\\n");
      if (message.method === "initialize") write({ id: message.id, result: {} });
      if (message.method === "account/read") write({ id: message.id, result: { account: { type: "chatgpt", planType: "pro" } } });
      if (message.method === "model/list") write({ id: message.id, result: { data: [
        { model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
        { model: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
        { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] }
      ] } });
      if (message.method === "plugin/list") write({ id: message.id, result: { marketplaces: [{ plugins: [{ id: "computer-use@openai-bundled", name: "computer-use", installed: true, enabled: true }] }] } });
      if (message.method === "thread/start") {
        const threadId = "thread-" + (++threadCounter);
        write({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
      }
      if (message.method === "thread/resume") write({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
      if (message.method === "thread/read") {
        const capturedTurns = JSON.parse(JSON.stringify([...turns.values()]));
        const respond = () => write({ id: message.id, result: { thread: { id: message.params.threadId, turns: capturedTurns } } });
        const delay = Number(process.env.INFELD_FAKE_THREAD_READ_DELAY || 0);
        if (delay > 0) setTimeout(respond, delay);
        else respond();
      }
      if (message.method === "turn/start") {
        const turnId = "turn-" + (++turnCounter);
        turns.set(turnId, { id: turnId, status: "inProgress", items: [] });
        write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        write({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId } } });
        write({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, itemId: "message-" + turnId, delta: "Streaming" } });
        if (process.env.INFELD_FAKE_AGENT_TOOL === "1" && turnCounter === 1) {
          setTimeout(() => write({ id: "agent-tool-1", method: "item/tool/call", params: { threadId: message.params.threadId, turnId, callId: "call-1", namespace: "infeld", tool: "send_message", arguments: { recipientBotIds: ["sales-outbound", "inbox-manager"], text: "Please prepare your reports." } } }), 30);
        }
      }
      if (message.method === "turn/interrupt") {
        write({ id: message.id, result: {} });
        const turn = turns.get(message.params.turnId);
        if (turn) turn.status = "interrupted";
        write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted" } } });
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return executable;
}
