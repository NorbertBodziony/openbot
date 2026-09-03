// @vitest-environment node

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, BrowserControlState, BrowserTab } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { expect, vi } from "vitest";
import type { AgentClient, AgentProvider } from "./agent-client";
import type { AgentService } from "./agent-service";
import { BotStore } from "./bot-store";
import { MailboxStore } from "./mailbox-store";
import {
  type AppServerNotification,
  type DynamicToolCallParams,
  getString,
  type RequestId,
  type ResponseDecoder,
  type RpcError,
} from "./protocol";
import { HARNESS_WAIT_TIMEOUT_MS } from "./test-deadlines";

export const CREATE_BOT_INPUT = {
  name: "Planning Bot",
  description: "Builds clear plans for everyday tasks.",
  avatarSeed: "setup:planning",
  avatarHue: 215,
  initialMessage: "Help me make a practical plan.",
} as const;
export const EMPTY_LAYOUT = {
  revision: 0,
  sections: [],
  order: ["people", "unassigned"],
  agentAssignments: {},
  agentOrder: [],
};

const FAKE_RUNTIME_ENV_VARS = [
  "OPENBOT_FAKE_CODEX_LOG",
  "OPENBOT_FAKE_AGENT_TOOL",
  "OPENBOT_FAKE_AGENT_TOOL_PATHS",
  "OPENBOT_FAKE_AGENT_TOOL_CALLS",
  "OPENBOT_FAKE_THREAD_READ_DELAY",
  "OPENBOT_FAKE_AUTO_COMPLETE",
  "OPENBOT_FAKE_CONTEXT_USAGE",
  "OPENBOT_FAKE_COMPACTION_ERROR",
  "OPENBOT_FAKE_ARCHIVED_THREAD",
  "OPENBOT_FAKE_TURN_START_RESPONSE_DELAY",
  "OPENBOT_FAKE_WARNING",
  "OPENBOT_FAKE_CLAUDE_LOGIN_LOG",
] as const;

const PROVIDER_PATH_ENV_VARS = ["OPENBOT_CODEX_PATH", "OPENBOT_CLAUDE_PATH", "OPENBOT_GROK_PATH"] as const;

/** Provider paths as they were before any shard touched them. */
const originalProviderPaths = new Map(PROVIDER_PATH_ENV_VARS.map((name) => [name, process.env[name]]));

/**
 * Creates the temporary root for one AgentService test and points the provider
 * paths at a fresh fake Codex CLI. Every shard calls this from its beforeEach,
 * so the fake-runtime variables and the fixture layout live in one place.
 */
export async function startAgentTestFixture(): Promise<{ root: string; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "openbot-agent-test-"));
  const logPath = join(root, "protocol.jsonl");
  process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
  process.env.OPENBOT_CODEX_PATH = await createFakeCodex(root);
  process.env.OPENBOT_CLAUDE_PATH = join(root, "missing-claude");
  process.env.OPENBOT_GROK_PATH = join(root, "missing-grok");
  return { root, logPath };
}

/**
 * Reverses startAgentTestFixture: stops the service, restores real timers and
 * the original provider paths, clears every OPENBOT_FAKE_* variable a test may
 * have set, and removes the temporary root.
 */
export async function stopAgentTestFixture(root: string, service: AgentService | null): Promise<void> {
  await service?.stop();
  vi.useRealTimers();
  for (const [name, original] of originalProviderPaths) {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  for (const name of FAKE_RUNTIME_ENV_VARS) delete process.env[name];
  await rm(root, { recursive: true, force: true });
}

export class FakeAgentClient extends EventEmitter implements AgentClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: RequestId; result: unknown }> = [];
  readonly errors: Array<{ id: RequestId; error: RpcError }> = [];
  #threadCounter = 0;
  running = false;
  responseError: Error | null = null;

  constructor(
    readonly provider: AgentProvider,
    readonly output = provider === "codex" ? "CODEX_DONE" : provider === "grok" ? "GROK_DONE" : "CLAUDE_DONE",
    readonly autoComplete = true,
    private accountSignedIn = true,
    private readonly requestDelays: Readonly<Record<string, number>> = {},
    private readonly requestHook?: (method: string, provider: AgentProvider) => Promise<void>,
  ) {
    super();
  }

  start(): void {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>): Promise<T> {
    this.requests.push({ method, params: structuredClone(params) });
    await this.requestHook?.(method, this.provider);
    const delayMs = this.requestDelays[method] ?? 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let result: unknown;
    if (method === "initialize") result = {};
    if (method === "account/read") {
      result = {
        account: this.accountSignedIn
          ? {
              type: this.provider === "codex" ? "chatgpt" : this.provider,
              email: `${this.provider}@example.com`,
            }
          : null,
        requiresOpenaiAuth: false,
      };
    }
    if (method === "account/login/start") {
      result = { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.test/connect" };
    }
    if (method === "account/login/cancel") result = { status: "cancelled" };
    if (method === "account/rateLimits/read") {
      result = { rateLimits: null, rateLimitsByLimitId: null };
    }
    if (method === "model/list") {
      result = {
        data:
          this.provider === "codex"
            ? // The uncurated ids are advertised on purpose, the way the real CLI
              // does: CURATED_CODEX_MODEL_IDS has to drop them again.
              [
                "gpt-5.6-luna",
                "gpt-5.6-terra",
                "gpt-5.6-sol",
                "gpt-5.5",
                "gpt-5.4",
                "gpt-5.4-mini",
                "gpt-5.3-codex-spark",
              ].map((model) => ({ model }))
            : this.provider === "grok"
              ? ["grok-4.5", "grok-fast"].map((model) => ({ model }))
              : ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"].map((model) => ({ model })),
      };
    }
    if (method === "plugin/list") result = { marketplaces: [] };
    if (method === "thread/start") {
      this.#threadCounter += 1;
      result = { thread: { id: `${this.provider}-session-${this.#threadCounter}` } };
    }
    if (method === "thread/resume") {
      result = { thread: { id: stringParam(params, "threadId") } };
    }
    if (method === "thread/read") {
      result = { thread: { id: stringParam(params, "threadId"), turns: [] } };
    }
    if (method === "thread/compact/start" || method === "turn/interrupt") result = {};
    if (method === "turn/steer") {
      result = { turnId: stringParam(params, "expectedTurnId") };
    }
    if (method === "turn/start") {
      const threadId = stringParam(params, "threadId");
      const turnId = randomUUID();
      const itemId = `${turnId}:assistant`;
      const text = this.output;
      setTimeout(() => {
        if (!this.running) return;
        this.emit("notification", notification("turn/started", { threadId, turn: { id: turnId } }));
        if (!this.autoComplete) return;
        this.emit(
          "notification",
          notification("item/started", {
            threadId,
            turnId,
            item: { id: itemId, type: "agentMessage", text: "" },
          }),
        );
        this.emit("notification", notification("item/agentMessage/delta", { threadId, turnId, itemId, delta: text }));
        this.emit(
          "notification",
          notification("item/completed", {
            threadId,
            turnId,
            item: { id: itemId, type: "agentMessage", text },
          }),
        );
        this.emit(
          "notification",
          notification("turn/completed", {
            threadId,
            turn: { id: turnId, status: "completed" },
          }),
        );
      }, 0);
      result = { turn: { id: turnId, status: "inProgress", items: [] } };
    }
    if (result === undefined) throw new Error(`Fake client does not implement ${method}.`);
    return decoder(result);
  }

  notify(): void {}

  completeLogin(success: boolean): void {
    this.accountSignedIn = success;
    this.emit(
      "notification",
      notification("account/login/completed", { loginId: "login-1", success, error: success ? null : "denied" }),
    );
  }

  respond(id: RequestId, result: unknown): void {
    if (this.responseError) throw this.responseError;
    this.responses.push({ id, result: structuredClone(result) });
  }

  respondError(id: RequestId, error: RpcError): void {
    this.errors.push({ id, error: structuredClone(error) });
  }
}

export async function callOpenBotTool(
  client: FakeAgentClient,
  threadId: string,
  tool: string,
  args: unknown,
  turnId = "routine-tool-turn",
  callId: string = randomUUID(),
): Promise<{ result?: unknown; error?: RpcError }> {
  const id = `openbot-tool-${randomUUID()}`;
  client.emit("request", {
    id,
    method: "item/tool/call",
    params: {
      threadId,
      turnId,
      callId,
      namespace: "openbot",
      tool,
      arguments: args,
    },
  });
  await waitFor(
    () =>
      client.responses.some((response) => response.id === id) || client.errors.some((response) => response.id === id),
  );
  const response = client.responses.find((item) => item.id === id);
  if (response) return { result: response.result };
  return { error: client.errors.find((item) => item.id === id)?.error };
}

export function openBotToolPayload(result: unknown): DynamicRecord {
  const contentItems = paramsRecord(result)?.contentItems;
  const text = Array.isArray(contentItems) ? getString(contentItems[0], "text") : null;
  if (!text) throw new Error("The OpenBot tool response has no text payload.");
  const payload = JSON.parse(text);
  if (!isDynamicRecord(payload)) throw new Error("The OpenBot tool response payload is invalid.");
  return payload;
}

export async function expectOpenBotToolError(
  client: FakeAgentClient,
  threadId: string,
  tool: string,
  args: unknown,
  message: string,
  turnId?: string,
): Promise<void> {
  const result = await callOpenBotTool(client, threadId, tool, args, turnId);
  expect(result.result).toBeUndefined();
  expect(result.error?.message).toContain(message);
}

export function notification(method: string, params: unknown): AppServerNotification {
  return { method, params };
}

export function stringParam(value: unknown, key: string): string {
  if (!isDynamicRecord(value)) throw new Error(`${key} is missing.`);
  const result = value[key];
  if (!isString(result)) throw new Error(`${key} is missing.`);
  return result;
}

export function paramsRecord(value: unknown): DynamicRecord | null {
  return isDynamicRecord(value) ? value : null;
}

export function firstInputText(value: unknown): string | null {
  const input = paramsRecord(value)?.input;
  if (!Array.isArray(input)) return null;
  return getString(input[0], "text");
}

export function inputRecords(value: unknown): DynamicRecord[] {
  const input = paramsRecord(value)?.input;
  return Array.isArray(input) ? input.filter(isDynamicRecord) : [];
}

export function stores(root: string): { store: BotStore; mailbox: MailboxStore } {
  const store = new BotStore(join(root, "user-data"), join(root, "home"));
  return { store, mailbox: new MailboxStore(join(root, "user-data"), store.sharedRoot, store.database) };
}

export function fakeBrowser(tabs: BrowserTab[] = []) {
  return {
    onChanged: (_listener: (tabs: BrowserTab[], activeTabId: string | null) => void) => () => undefined,
    onControlChanged: (_listener: (state: BrowserControlState) => void) => () => undefined,
    clearControls: () => undefined,
    endControl: () => undefined,
    listTabs: () => tabs,
    handleDynamicTool: async (_params: DynamicToolCallParams) => ({ success: true, contentItems: [] }),
  };
}

export function nextRoutinesChanged(agentService: AgentService, botId: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (event: AgentEvent) => {
      if (event.type !== "routines-changed" || event.botId !== botId) return;
      agentService.off("event", listener);
      resolve();
    };
    agentService.on("event", listener);
  });
}

export async function protocolMessages(logPath: string): Promise<DynamicRecord[]> {
  try {
    return (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(isDynamicRecord);
  } catch {
    return [];
  }
}

export async function waitFor(check: () => boolean | undefined | Promise<boolean | undefined>): Promise<void> {
  const deadline = Date.now() + HARNESS_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  // The predicate's own source names the condition, which every call site
  // already spells out, so no call site has to repeat it as a description.
  const condition = check.toString().replace(/\s+/g, " ").trim();
  throw new Error(
    `Timed out after ${HARNESS_WAIT_TIMEOUT_MS}ms waiting for: ${condition.length > 200 ? `${condition.slice(0, 200)}…` : condition}`,
  );
}

export async function createFakeCodex(directory: string): Promise<string> {
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
let archivedThread = process.env.OPENBOT_FAKE_ARCHIVED_THREAD === "1";
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
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
        { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
        { model: "gpt-5.5", displayName: "GPT-5.5" },
        { model: "gpt-5.4", displayName: "GPT-5.4" },
        { model: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
        { model: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark" }
      ] } });
      if (message.method === "plugin/list") write({ id: message.id, result: { marketplaces: [{ plugins: [{ id: "computer-use@openai-bundled", name: "computer-use", installed: true, enabled: true }] }] } });
      if (message.method === "thread/start") {
        const threadId = "thread-" + (++threadCounter);
        write({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
      }
      if (message.method === "thread/resume") {
        if (archivedThread) write({ id: message.id, error: { code: -32600, message: "session " + message.params.threadId + " is archived. Run codex unarchive " + message.params.threadId + " to unarchive it first." } });
        else write({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
      }
      if (message.method === "thread/unarchive") {
        archivedThread = false;
        write({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
      }
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
        const respondToStart = () => write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        const startResponseDelay = Number(process.env.OPENBOT_FAKE_TURN_START_RESPONSE_DELAY || 0);
        if (startResponseDelay > 0) setTimeout(respondToStart, startResponseDelay);
        else respondToStart();
        write({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId } } });
        if (process.env.OPENBOT_FAKE_WARNING) {
          write({ method: "warning", params: { threadId: message.params.threadId, message: process.env.OPENBOT_FAKE_WARNING } });
        }
        if (process.env.OPENBOT_FAKE_CONTEXT_USAGE) {
          const totalTokens = Number(process.env.OPENBOT_FAKE_CONTEXT_USAGE);
          write({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId, tokenUsage: { total: { totalTokens }, last: { totalTokens }, modelContextWindow: 100000 } } });
        }
        write({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, itemId: "message-" + turnId, delta: "Streaming" } });
        if (process.env.OPENBOT_FAKE_AGENT_TOOL === "1" && turnCounter === 1) {
          setTimeout(() => write({ id: "agent-tool-1", method: "item/tool/call", params: { threadId: message.params.threadId, turnId, callId: "call-1", namespace: "openbot", tool: "send_message", arguments: { recipientBotIds: ["sales-outbound", "inbox-manager"], text: "Please prepare your reports.", paths: JSON.parse(process.env.OPENBOT_FAKE_AGENT_TOOL_PATHS || "[]") } } }), 30);
        }
        if (process.env.OPENBOT_FAKE_AGENT_TOOL_CALLS && turnCounter === 1) {
          const calls = JSON.parse(process.env.OPENBOT_FAKE_AGENT_TOOL_CALLS);
          calls.forEach((call, index) => setTimeout(() => write({
            id: "agent-tool-configured-" + index,
            method: "item/tool/call",
            params: {
              threadId: message.params.threadId,
              turnId,
              callId: "configured-call-" + index,
              namespace: "openbot",
              tool: call.tool,
              arguments: call.arguments,
            },
          }), 30 + index * 30));
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

export async function createFakeClaude(directory: string): Promise<string> {
  const executable = join(directory, "claude");
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.246 (Claude Code)'
elif [ "$1" = "auth" ]; then
  printf '%s' '{"loggedIn":true,"email":"claude@example.com","subscriptionType":"max"}'
fi
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

export async function createPendingFakeClaude(directory: string): Promise<string> {
  const executable = join(directory, "claude-pending");
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.246 (Claude Code)'
elif [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  printf '%s\\n' 'started' >> "$OPENBOT_FAKE_CLAUDE_LOGIN_LOG"
  trap 'printf "%s\\n" "stopped" >> "$OPENBOT_FAKE_CLAUDE_LOGIN_LOG"; exit 143' TERM INT
  while :; do sleep 0.1; done
elif [ "$1" = "auth" ]; then
  printf '%s' '{"loggedIn":false}'
fi
`,
  );
  await chmod(executable, 0o755);
  return executable;
}

export async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function createFakeGrok(directory: string): Promise<string> {
  const executable = join(directory, "grok");
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'grok 1.0.5'
fi
`,
  );
  await chmod(executable, 0o755);
  return executable;
}
