// @vitest-environment node

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../shared/ipc";
import { AgentService } from "./agent-service";
import { BotStore } from "./bot-store";
import type { BrowserHost } from "./browser-host";

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
  await rm(root, { recursive: true, force: true });
});

describe.sequential("AgentService", () => {
  it("creates independent persistent bots with full-access thread settings", async () => {
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    service = new AgentService(store, fakeBrowser(), () => ({
      screenRecording: true,
      accessibility: true,
    }));
    await service.initialize();

    expect(service.getStatus()).toMatchObject({
      phase: "ready",
      auth: { kind: "chatgpt" },
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
      fullAccess: true,
    });

    const first = await service.sendMessage({ botId: "chief", text: "First task" });
    const second = await service.sendMessage({ botId: "sales-outbound", text: "Second task" });
    expect(first.threadId).not.toBe(second.threadId);

    const requests = await protocolMessages();
    const starts = requests.filter((message) => message.method === "thread/start");
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      const params = start.params as Record<string, unknown>;
      expect(params).toMatchObject({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: false,
        serviceName: "infeld_bot",
      });
      expect(params).not.toHaveProperty("model");
      expect((params.dynamicTools as unknown[])[0]).toMatchObject({
        type: "namespace",
        name: "browser",
      });
      expect(params.runtimeWorkspaceRoots).toHaveLength(2);
    }

    expect((await store.getOrCreate("chief")).threadId).toBe(first.threadId);
    expect((await store.getOrCreate("sales-outbound")).threadId).toBe(second.threadId);
  });

  it("streams events, steers an active turn, interrupts, and handles prompts safely", async () => {
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    service = new AgentService(store, fakeBrowser());
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();

    const turn = await service.sendMessage({ botId: "chief", text: "Start" });
    await waitFor(() => events.some((event) => event.type === "assistant-delta"));
    const steer = await service.sendMessage({ botId: "chief", text: "Add this" });
    expect(steer.mode).toBe("steer");

    await waitFor(() => events.some((event) => event.type === "prompt"));
    const prompt = events.find((event) => event.type === "prompt");
    if (prompt?.type !== "prompt") throw new Error("Prompt was not emitted.");
    await service.respondToPrompt({
      requestId: prompt.requestId,
      answers: { choice: ["Proceed"] },
    });
    await service.interrupt("chief", turn.turnId);

    await waitFor(async () => {
      const messages = await protocolMessages();
      return messages.some((message) => message.id === "approval-1" && message.result);
    });
    const messages = await protocolMessages();
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "turn/steer" }),
        expect.objectContaining({ method: "turn/interrupt" }),
        expect.objectContaining({ id: "approval-1", result: { decision: "acceptForSession" } }),
        expect.objectContaining({
          id: "prompt-1",
          result: { answers: { choice: { answers: ["Proceed"] } } },
        }),
      ]),
    );
  });

  it("resumes a stored thread after a backend restart", async () => {
    const store = new BotStore(join(root, "user-data"), join(root, "home"));
    service = new AgentService(store, fakeBrowser());
    await service.initialize();
    const original = await service.sendMessage({ botId: "chief", text: "Remember this" });
    await service.stop();

    service = new AgentService(store, fakeBrowser());
    await service.initialize();
    const resumed = await service.sendMessage({ botId: "chief", text: "Continue" });

    expect(resumed.threadId).toBe(original.threadId);
    expect((await protocolMessages()).some((message) => message.method === "thread/resume")).toBe(
      true,
    );
  });
});

function fakeBrowser(): BrowserHost {
  return {
    onChanged: () => () => undefined,
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

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
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
      if (message.method === "plugin/list") write({ id: message.id, result: { marketplaces: [{ plugins: [{ id: "computer-use@openai-bundled", name: "computer-use", installed: true, enabled: true }] }] } });
      if (message.method === "thread/start") {
        const threadId = "thread-" + (++threadCounter);
        write({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
      }
      if (message.method === "thread/resume") write({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
      if (message.method === "thread/read") write({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
      if (message.method === "turn/start") {
        const turnId = "turn-" + (++turnCounter);
        write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        write({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId } } });
        write({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, itemId: "message-" + turnId, delta: "Streaming" } });
        if (turnCounter === 1) {
          write({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: message.params.threadId, turnId, itemId: "command-1" } });
          write({ id: "prompt-1", method: "item/tool/requestUserInput", params: { threadId: message.params.threadId, turnId, itemId: "question-1", questions: [{ id: "choice", header: "Choice", question: "Proceed?", isSecret: false, options: null }] } });
        }
      }
      if (message.method === "turn/steer") write({ id: message.id, result: { turnId: message.params.expectedTurnId } });
      if (message.method === "turn/interrupt") write({ id: message.id, result: {} });
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
