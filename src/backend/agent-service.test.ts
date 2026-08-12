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
const originalCodexPath = process.env.OPENBOT_CODEX_PATH;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-agent-test-"));
  logPath = join(root, "protocol.jsonl");
  process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
  process.env.OPENBOT_CODEX_PATH = await createFakeCodex(root);
});

afterEach(async () => {
  await service?.stop();
  service = null;
  if (originalCodexPath === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = originalCodexPath;
  delete process.env.OPENBOT_FAKE_CODEX_LOG;
  delete process.env.OPENBOT_FAKE_AGENT_TOOL;
  delete process.env.OPENBOT_FAKE_AGENT_TOOL_PATHS;
  delete process.env.OPENBOT_FAKE_THREAD_READ_DELAY;
  delete process.env.OPENBOT_FAKE_AUTO_COMPLETE;
  delete process.env.OPENBOT_FAKE_CONTEXT_USAGE;
  delete process.env.OPENBOT_FAKE_COMPACTION_ERROR;
  await rm(root, { recursive: true, force: true });
});

describe.sequential("AgentService", () => {
  it("creates independent full-access threads with browser and OpenBot tools", async () => {
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser(), () => ({
      screenRecording: true,
      accessibility: true,
    }));
    await service.initialize();

    expect(service.getStatus()).toMatchObject({
      phase: "ready",
      auth: { kind: "chatgpt", email: "codex@example.com" },
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
    });
    await expect(service.getUsage()).resolves.toMatchObject({
      limits: [
        {
          id: "codex",
          primary: { usedPercent: 25, windowDurationMins: 300 },
          secondary: { usedPercent: 40, windowDurationMins: 10_080 },
        },
      ],
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
        serviceName: "openbot",
      });
      expect(params.dynamicTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "namespace", name: "openbot_browser" }),
          expect.objectContaining({ type: "namespace", name: "openbot" }),
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

  it("compacts a pressured agent context before draining its next queued message", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "DONE";
    process.env.OPENBOT_FAKE_CONTEXT_USAGE = "82000";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "First large task" });
    await service.sendMessage({ botId: "chief", text: "Run after compaction" });
    await waitFor(async () => {
      const messages = await protocolMessages();
      return messages.filter((message) => message.method === "turn/start").length === 2;
    });

    const lifecycle = (await protocolMessages())
      .filter((message) => ["turn/start", "thread/compact/start"].includes(String(message.method)))
      .map((message) => message.method);
    expect(lifecycle.slice(0, 3)).toEqual(["turn/start", "thread/compact/start", "turn/start"]);
    expect(lifecycle.filter((method) => method === "thread/compact/start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn-started")).toHaveLength(2);
  });

  it("does not compact context below the safety threshold", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "DONE";
    process.env.OPENBOT_FAKE_CONTEXT_USAGE = "79000";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    await service.sendMessage({ botId: "chief", text: "Normal task" });
    await waitFor(() => service?.listQueue("chief").deliveries[0]?.status === "completed");

    expect(
      (await protocolMessages()).some((message) => message.method === "thread/compact/start"),
    ).toBe(false);
  });

  it("continues queued work when context compaction is unavailable", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "DONE";
    process.env.OPENBOT_FAKE_CONTEXT_USAGE = "82000";
    process.env.OPENBOT_FAKE_COMPACTION_ERROR = "1";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();

    await service.sendMessage({ botId: "chief", text: "First task" });
    await service.sendMessage({ botId: "chief", text: "Must still run" });
    await waitFor(async () => {
      const messages = await protocolMessages();
      return messages.filter((message) => message.method === "turn/start").length === 2;
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", code: "context_compaction_failed" }),
      ]),
    );
  });

  it("fans out an idempotent agent tool message with referenced files", async () => {
    process.env.OPENBOT_FAKE_AGENT_TOOL = "1";
    const notePath = join(root, "generated-note.txt");
    const imagePath = join(root, "generated-image.png");
    await Promise.all([
      writeFile(notePath, "OPENBOT_SHARED_FILE_OK\n"),
      writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    ]);
    process.env.OPENBOT_FAKE_AGENT_TOOL_PATHS = JSON.stringify([notePath, imagePath]);
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
    expect(sales.attachments.map((item) => item.name)).toEqual([
      "generated-note.txt",
      "generated-image.png",
    ]);
    const managedNote = await mailbox.resolveAttachment(sales.attachments[0]?.id ?? "");
    const managedImage = await mailbox.resolveAttachment(sales.attachments[1]?.id ?? "");
    expect(managedNote?.path).not.toBe(notePath);
    expect(managedImage?.path).not.toBe(imagePath);
    await expect(readFile(managedNote?.path ?? "", "utf8")).resolves.toBe(
      "OPENBOT_SHARED_FILE_OK\n",
    );

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
    expect(salesInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "mention",
          name: "generated-note.txt",
          path: expect.stringContaining("generated-note.txt"),
        }),
        expect.objectContaining({
          type: "localImage",
          path: expect.stringContaining("generated-image.png"),
        }),
      ]),
    );
  });

  it("reliably relays a completed teammate result back through a reply chain without loops", async () => {
    process.env.OPENBOT_FAKE_AUTO_COMPLETE = "AUTO_WEATHER_RESULT";
    const { store, mailbox } = stores();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    const rootMessage = await mailbox.enqueue({
      sender: { kind: "bot", botId: "chief" },
      recipientBotIds: ["sales-outbound"],
      text: "Check the weather.",
    });
    const clarification = await mailbox.enqueue({
      sender: { kind: "bot", botId: "sales-outbound" },
      recipientBotIds: ["chief"],
      text: "Which city?",
      replyToMessageId: rootMessage.messageId,
    });
    const location = await mailbox.enqueue({
      sender: { kind: "bot", botId: "chief" },
      recipientBotIds: ["sales-outbound"],
      text: "Kraków.",
      replyToMessageId: clarification.messageId,
    });

    await service.setQueuePaused("sales-outbound", false);
    await waitFor(() =>
      service
        ?.listQueue("chief")
        .deliveries.some(
          (delivery) =>
            delivery.sender.kind === "bot" &&
            delivery.sender.botId === "sales-outbound" &&
            delivery.replyToMessageId === location.messageId,
        ),
    );
    await waitFor(() =>
      (service?.listQueue("chief").deliveries ?? []).every(
        (delivery) => delivery.status === "completed",
      ),
    );

    expect(await service.readConversation("chief")).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          author: "agent",
          senderBotId: "sales-outbound",
          text: "AUTO_WEATHER_RESULT",
          replyToMessageId: location.messageId,
        }),
      ]),
    });
    expect(service.listQueue("sales-outbound").deliveries).toHaveLength(2);
    expect(service.listQueue("chief").deliveries).toHaveLength(2);
  });

  it("merges a late thread read with a newer active stream", async () => {
    process.env.OPENBOT_FAKE_THREAD_READ_DELAY = "80";
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
        expect.objectContaining({ type: "namespace", name: "openbot_browser" }),
        expect.objectContaining({ type: "namespace", name: "openbot" }),
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
const log = process.env.OPENBOT_FAKE_CODEX_LOG;
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
      if (message.method === "account/read") write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
      if (message.method === "account/rateLimits/read") write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1786563600 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1787040000 } }, rateLimitsByLimitId: null } });
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
        const delay = Number(process.env.OPENBOT_FAKE_THREAD_READ_DELAY || 0);
        if (delay > 0) setTimeout(respond, delay);
        else respond();
      }
      if (message.method === "turn/start") {
        const turnId = "turn-" + (++turnCounter);
        turns.set(turnId, { id: turnId, status: "inProgress", items: [] });
        write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        write({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId } } });
        if (process.env.OPENBOT_FAKE_CONTEXT_USAGE) {
          const totalTokens = Number(process.env.OPENBOT_FAKE_CONTEXT_USAGE);
          write({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId, tokenUsage: { total: { totalTokens }, last: { totalTokens }, modelContextWindow: 100000 } } });
        }
        write({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, itemId: "message-" + turnId, delta: "Streaming" } });
        if (process.env.OPENBOT_FAKE_AGENT_TOOL === "1" && turnCounter === 1) {
          setTimeout(() => write({ id: "agent-tool-1", method: "item/tool/call", params: { threadId: message.params.threadId, turnId, callId: "call-1", namespace: "openbot", tool: "send_message", arguments: { recipientBotIds: ["sales-outbound", "inbox-manager"], text: "Please prepare your reports.", paths: JSON.parse(process.env.OPENBOT_FAKE_AGENT_TOOL_PATHS || "[]") } } }), 30);
        }
        if (process.env.OPENBOT_FAKE_AUTO_COMPLETE) {
          setTimeout(() => {
            const text = process.env.OPENBOT_FAKE_AUTO_COMPLETE;
            const item = { type: "agentMessage", id: "message-" + turnId, text, phase: "final_answer" };
            const turn = turns.get(turnId);
            if (turn) {
              turn.status = "completed";
              turn.items = [item];
            }
            write({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
            write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
          }, 20);
        }
      }
      if (message.method === "thread/compact/start") {
        if (process.env.OPENBOT_FAKE_COMPACTION_ERROR === "1") {
          write({ id: message.id, error: { code: -32601, message: "Compaction unavailable" } });
          newline = buffer.indexOf("\\n");
          continue;
        }
        const turnId = "compact-turn-" + (++turnCounter);
        const item = { type: "contextCompaction", id: "compact-item-" + turnId };
        write({ id: message.id, result: {} });
        write({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId } } });
        write({ method: "item/started", params: { threadId: message.params.threadId, turnId, item } });
        write({ method: "item/completed", params: { threadId: message.params.threadId, turnId, item } });
        write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
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
