// @vitest-environment node

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GrokAgentClient } from "./grok-client";
import {
  type AppServerNotification,
  type AppServerRequest,
  decodeAccountReadResult,
  decodeModelListResponse,
  decodeRecordResponse,
  decodeThreadResponse,
  decodeTurnResponse,
} from "./protocol";

let root: string;
let executable: string;
let logPath: string;
let client: GrokAgentClient | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-grok-acp-"));
  executable = join(root, "grok");
  logPath = join(root, "fake-grok.jsonl");
  await writeFile(executable, FAKE_GROK_ACP);
  await chmod(executable, 0o700);
  process.env.OPENBOT_FAKE_GROK_LOG = logPath;
  delete process.env.OPENBOT_FAKE_GROK_MODE;
});

afterEach(async () => {
  await client?.stop();
  client = null;
  delete process.env.OPENBOT_FAKE_GROK_LOG;
  delete process.env.OPENBOT_FAKE_GROK_MODE;
  await rm(root, { recursive: true, force: true });
});

describe.sequential("GrokAgentClient", () => {
  it("discovers ACP models, configures a session, streams, steers, asks, approves, cancels, and resumes", async () => {
    client = new GrokAgentClient({ executable, version: "1.0.5" }, 5_000);
    const notifications: AppServerNotification[] = [];
    const requests: AppServerRequest[] = [];
    client.on("notification", (notification) => notifications.push(notification));
    client.on("request", (request) => requests.push(request));
    client.start();

    await client.request("initialize", {}, decodeRecordResponse);
    await expect(client.request("account/read", {}, decodeAccountReadResult)).resolves.toMatchObject({
      account: { type: "grok" },
    });
    const models = await client.request("model/list", {}, decodeModelListResponse);
    expect(models.data).toEqual([
      expect.objectContaining({
        model: "grok-4.5",
        defaultReasoningEffort: "xhigh",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "xhigh" }],
      }),
      expect.objectContaining({ model: "grok-fast" }),
    ]);

    const started = await client.request(
      "thread/start",
      {
        cwd: root,
        runtimeWorkspaceRoots: [root],
        developerInstructions: "Use OpenBot tools.",
        dynamicTools: [],
        model: "grok-fast",
        effort: "xhigh",
      },
      decodeThreadResponse,
    );
    const threadId = started.thread.id;
    const turn = await client.request(
      "turn/start",
      {
        threadId,
        model: "grok-fast",
        effort: "xhigh",
        clientUserMessageId: "turn-1",
        input: [{ type: "text", text: "Build it" }],
      },
      decodeTurnResponse,
    );
    expect(turn.turn.status).toBe("inProgress");
    await waitFor(() => requests.some((request) => request.method.includes("requestApproval")));

    await client.request(
      "turn/steer",
      {
        threadId,
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Also add tests" }],
      },
      decodeRecordResponse,
    );
    const approval = requests.find((request) => request.method.includes("requestApproval"));
    if (!approval) throw new Error("The fake ACP permission request was not surfaced.");
    client.respond(approval.id, { decision: "accept" });
    await waitFor(() => requests.filter((request) => request.method === "item/tool/requestUserInput").length === 1);
    const elicitation = requests.find((request) => request.method === "item/tool/requestUserInput");
    if (!elicitation) throw new Error("The standard ACP elicitation was not surfaced.");
    client.respond(elicitation.id, { answers: { language: { answers: ["TypeScript"] } } });
    await waitFor(() => requests.filter((request) => request.method === "item/tool/requestUserInput").length === 2);
    const prompt = requests.filter((request) => request.method === "item/tool/requestUserInput")[1];
    if (!prompt) throw new Error("The xAI user-input request was not surfaced.");
    client.respond(prompt.id, { answers: { confirm: { answers: ["yes"] } } });
    await waitFor(() => notifications.some((notification) => notification.method === "turn/completed"));
    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "turn/started" }),
        expect.objectContaining({ method: "item/agentMessage/delta" }),
        expect.objectContaining({ method: "item/completed" }),
        expect.objectContaining({ method: "turn/completed" }),
      ]),
    );
    // A thought only reaches the thinking disclosure while it is phased as commentary; without the
    // phase it arrives as an ordinary agent message and renders as a chat bubble.
    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "item/started",
          params: expect.objectContaining({
            item: expect.objectContaining({ type: "agentMessage", phase: "commentary" }),
          }),
        }),
        expect.objectContaining({
          method: "item/completed",
          params: expect.objectContaining({
            item: expect.objectContaining({ phase: "commentary", text: "GROK_THOUGHT" }),
          }),
        }),
      ]),
    );

    const secondTurn = await client.request(
      "turn/start",
      { threadId, clientUserMessageId: "turn-2", input: [{ type: "text", text: "Wait" }] },
      decodeTurnResponse,
    );
    await client.request("turn/interrupt", { threadId, turnId: secondTurn.turn.id }, decodeRecordResponse);
    await waitFor(() =>
      notifications.some(
        (notification) =>
          notification.method === "turn/completed" &&
          JSON.stringify(notification.params).includes('"status":"interrupted"'),
      ),
    );

    const log = await readLog();
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "start", args: ["--no-auto-update", "agent", "stdio"] }),
        expect.objectContaining({ method: "authenticate", methodId: "cached_token" }),
        expect.objectContaining({ method: "session/set_config_option", configId: "model", value: "grok-fast" }),
        expect.objectContaining({ method: "session/set_config_option", configId: "thought", value: "extra_high" }),
        expect.objectContaining({ event: "permission-response", optionId: "allow-once" }),
        expect.objectContaining({ event: "elicitation-response", language: "TypeScript" }),
        expect.objectContaining({ event: "user-input-response" }),
        expect.objectContaining({ method: "session/cancel" }),
      ]),
    );

    await client.stop();
    client = new GrokAgentClient({ executable, version: "1.0.5" }, 5_000);
    client.start();
    await client.request("initialize", {}, decodeRecordResponse);
    await expect(
      client.request("thread/resume", { threadId, cwd: root, dynamicTools: [] }, decodeRecordResponse),
    ).resolves.toEqual(expect.any(Object));
    expect(await readLog()).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "session/load", sessionId: threadId })]),
    );
  });

  it("uses one neutral effort when thought_level is not advertised", async () => {
    process.env.OPENBOT_FAKE_GROK_MODE = "no-thought";
    client = new GrokAgentClient({ executable, version: "1.0.5" }, 5_000);
    client.start();
    await client.request("initialize", {}, decodeRecordResponse);
    const models = await client.request("model/list", {}, decodeModelListResponse);
    expect(models.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        }),
      ]),
    );
  });

  it("discovers and applies per-model reasoning efforts from Grok metadata", async () => {
    process.env.OPENBOT_FAKE_GROK_MODE = "model-metadata";
    client = new GrokAgentClient({ executable, version: "1.0.13" }, 5_000);
    client.start();
    await client.request("initialize", {}, decodeRecordResponse);

    const models = await client.request("model/list", {}, decodeModelListResponse);
    expect(models.data).toEqual([
      expect.objectContaining({
        model: "grok-4.6",
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
          { reasoningEffort: "xhigh" },
        ],
      }),
      expect.objectContaining({
        model: "grok-4.5",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      }),
    ]);

    await client.request(
      "thread/start",
      { cwd: root, dynamicTools: [], model: "grok-4.6", effort: "xhigh" },
      decodeThreadResponse,
    );
    expect(await readLog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "session/set_model",
          modelId: "grok-4.6",
          reasoningEffort: "extra_high",
        }),
      ]),
    );
    expect(await readLog()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "session/set_config_option", configId: "thought" })]),
    );

    const previousLogLength = (await readLog()).length;
    await client.request(
      "thread/start",
      { cwd: root, dynamicTools: [], model: "grok-4.5", effort: "medium" },
      decodeThreadResponse,
    );
    const unsupportedModelLog = (await readLog()).slice(previousLogLength);
    expect(unsupportedModelLog).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "session/set_model", modelId: "grok-4.5" })]),
    );
    expect(
      unsupportedModelLog.some((entry) => entry.method === "session/set_config_option" && entry.configId === "thought"),
    ).toBe(false);
    expect(
      unsupportedModelLog.some((entry) => entry.method === "session/set_model" && "reasoningEffort" in entry),
    ).toBe(false);
  });

  it("supports Grok's legacy ACP model catalog and session/set_model", async () => {
    process.env.OPENBOT_FAKE_GROK_MODE = "legacy-models";
    client = new GrokAgentClient({ executable, version: "1.0.5" }, 5_000);
    client.start();
    await client.request("initialize", {}, decodeRecordResponse);
    const models = await client.request("model/list", {}, decodeModelListResponse);
    expect(models.data).toEqual([
      expect.objectContaining({ model: "grok-4.5", displayName: "Grok 4.5" }),
      expect.objectContaining({ model: "grok-fast", displayName: "Grok Fast" }),
    ]);

    await client.request(
      "thread/start",
      { cwd: root, dynamicTools: [], model: "grok-fast", effort: "xhigh" },
      decodeThreadResponse,
    );
    expect(await readLog()).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "session/set_model", modelId: "grok-fast" })]),
    );
  });

  it("reports auth as signed out and rejects empty model discovery without a fallback", async () => {
    process.env.OPENBOT_FAKE_GROK_MODE = "auth-error";
    client = new GrokAgentClient({ executable, version: "1.0.5" }, 5_000);
    client.start();
    await client.request("initialize", {}, decodeRecordResponse);
    await expect(client.request("account/read", {}, decodeAccountReadResult)).resolves.toMatchObject({ account: null });
    await client.stop();

    process.env.OPENBOT_FAKE_GROK_MODE = "no-model";
    client = new GrokAgentClient({ executable, version: "1.0.5" }, 5_000);
    client.start();
    await expect(client.request("initialize", {}, decodeRecordResponse)).rejects.toThrow(
      "did not advertise any ACP models",
    );
  });
});

async function readLog(): Promise<DynamicRecord[]> {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(parseLogLine);
}

function parseLogLine(line: string): DynamicRecord {
  const value = JSON.parse(line);
  if (!isDynamicRecord(value)) throw new Error("The fake Grok log contains an invalid entry.");
  return value;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error("Timed out waiting for the fake Grok ACP process.");
    },
    { timeout: timeoutMs },
  );
}

const FAKE_GROK_ACP = String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.OPENBOT_FAKE_GROK_LOG;
const mode = process.env.OPENBOT_FAKE_GROK_MODE || "normal";
let sessionCounter = 0;
let promptCounter = 0;
let pendingPrompt = null;

const log = (value) => {
  if (logPath) appendFileSync(logPath, JSON.stringify(value) + "\n");
};
log({ event: "start", args: process.argv.slice(2) });
const write = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const modelConfig = () => {
  const options = [{
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "grok-4.5",
    options: [
      { value: "grok-4.5", name: "Grok 4.5", description: "Most capable" },
      { value: "grok-fast", name: "Grok Fast", description: "Fast" },
    ],
  }];
  if (mode !== "no-thought") options.push({
    id: "thought",
    name: "Thought level",
    category: "thought_level",
    type: "select",
    currentValue: "extra_high",
    options: [
      { value: "low", name: "Low" },
      { value: "extra_high", name: "Extra high" },
    ],
  });
  return mode === "no-model" ? options.filter((option) => option.category !== "model") : options;
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method && message.id === "permission-1") {
    log({ event: "permission-response", optionId: message.result?.outcome?.optionId });
    write({
      id: "elicitation-1",
      method: "elicitation/create",
      params: {
        mode: "form",
        sessionId: pendingPrompt.sessionId,
        message: "Choose a language",
        requestedSchema: {
          type: "object",
          properties: {
            language: { type: "string", title: "Language", enum: ["TypeScript", "Rust"] },
          },
          required: ["language"],
        },
      },
    });
    return;
  }
  if (!message.method && message.id === "elicitation-1") {
    log({ event: "elicitation-response", language: message.result?.content?.language });
    write({
      id: "input-1",
      method: "xai/request_user_input",
      params: {
        sessionId: pendingPrompt.sessionId,
        questions: [{ id: "confirm", header: "Confirm", question: "Continue?", options: [] }],
      },
    });
    return;
  }
  if (!message.method && message.id === "input-1") {
    log({ event: "user-input-response", hasAnswers: Boolean(message.result?.answers) });
    write({
      method: "session/update",
      params: {
        sessionId: pendingPrompt.sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "GROK_THOUGHT" } },
      },
    });
    write({
      method: "session/update",
      params: {
        sessionId: pendingPrompt.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "GROK_DONE" } },
      },
    });
    write({ id: pendingPrompt.id, result: { stopReason: "end_turn" } });
    pendingPrompt = null;
    return;
  }
  if (message.method === "initialize") {
    log({ method: message.method });
    write({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { configOptions: {} } },
        authMethods: [
          { id: "cached_token", name: "Cached login" },
          { id: "xai.api_key", name: "xAI API key" },
        ],
        agentInfo: { name: "fake-grok", version: "1.0.5" },
      },
    });
    return;
  }
  if (message.method === "authenticate") {
    log({ method: message.method, methodId: message.params.methodId });
    if (mode === "auth-error") write({ id: message.id, error: { code: -32000, message: "Authentication required. Run grok login." } });
    else write({ id: message.id, result: {} });
    return;
  }
  if (message.method === "session/new") {
    sessionCounter += 1;
    const sessionId = "grok-session-" + sessionCounter;
    log({ method: message.method, sessionId, mcpAuthorization: message.params.mcpServers?.some((server) => server.headers?.some((header) => header.name.toLowerCase() === "authorization" && header.value.startsWith("Bearer "))) });
    const result = mode === "model-metadata"
      ? {
          sessionId,
          models: {
            currentModelId: "grok-4.6",
            availableModels: [
              {
                modelId: "grok-4.6",
                name: "Grok 4.6",
                _meta: {
                  supportsReasoningEffort: true,
                  reasoningEffort: "high",
                  reasoningEfforts: [
                    { value: "low" },
                    { value: "medium" },
                    { value: "high" },
                    { value: "extra_high" },
                    { value: "unsupported" },
                  ],
                },
              },
              {
                modelId: "grok-4.5",
                name: "Grok 4.5",
                _meta: { supportsReasoningEffort: false },
              },
            ],
          },
          configOptions: modelConfig().filter((option) => option.category === "thought_level"),
        }
      : mode === "legacy-models"
      ? {
          sessionId,
          models: {
            currentModelId: "grok-4.5",
            availableModels: [
              { modelId: "grok-4.5", name: "Grok 4.5" },
              { modelId: "grok-fast", name: "Grok Fast" },
            ],
          },
          configOptions: modelConfig().filter((option) => option.category !== "model"),
        }
      : { sessionId, configOptions: modelConfig() };
    write({ id: message.id, result });
    return;
  }
  if (message.method === "session/load") {
    log({ method: message.method, sessionId: message.params.sessionId });
    write({ id: message.id, result: { configOptions: modelConfig() } });
    return;
  }
  if (message.method === "session/close") {
    log({ method: message.method, sessionId: message.params.sessionId });
    write({ id: message.id, result: {} });
    return;
  }
  if (message.method === "session/set_config_option") {
    log({ method: message.method, configId: message.params.configId, value: message.params.value });
    const configOptions = modelConfig().map((option) => option.id === message.params.configId ? { ...option, currentValue: message.params.value } : option);
    write({ id: message.id, result: { configOptions } });
    return;
  }
  if (message.method === "session/set_model") {
    log({
      method: message.method,
      modelId: message.params.modelId,
      reasoningEffort: message.params._meta?.reasoningEffort,
    });
    write({ id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    promptCounter += 1;
    log({ method: message.method, promptCounter, text: message.params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n") });
    if (promptCounter === 1) {
      pendingPrompt = { id: message.id, sessionId: message.params.sessionId };
      write({
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: { toolCallId: "tool-1", title: "Run tests", kind: "execute", rawInput: { command: "bun test" } },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
    } else if (promptCounter === 2) {
      write({ id: message.id, result: { stopReason: "end_turn" } });
    } else {
      pendingPrompt = { id: message.id, sessionId: message.params.sessionId };
    }
    return;
  }
  if (message.method === "session/cancel") {
    log({ method: message.method, sessionId: message.params.sessionId });
    if (pendingPrompt) {
      write({ id: pendingPrompt.id, result: { stopReason: "cancelled" } });
      pendingPrompt = null;
    }
    if (message.id !== undefined) write({ id: message.id, result: {} });
  }
});
`;
