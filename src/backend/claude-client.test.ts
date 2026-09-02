// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAgentClient } from "./claude-client";
import {
  decodeAccountReadResult,
  decodeModelListResponse,
  decodeRecordResponse,
  decodeThreadResponse,
  decodeTurnResponse,
  getRecord,
  getString,
} from "./protocol";

type TestStreamMessage =
  | {
      type: "stream_event";
      parent_tool_use_id: null;
      session_id: string;
      uuid: string;
      event: {
        type: "content_block_delta";
        index: number;
        delta: { type: "text_delta"; text: string };
      };
    }
  | {
      type: "assistant";
      parent_tool_use_id: string | null;
      session_id: string;
      uuid: string;
      message: { content: Array<{ type: "text"; text: string }> };
    }
  | {
      type: "result";
      subtype: "success";
      result: string;
      terminal_reason: "completed";
      errors: string[];
      session_id: string;
      uuid: string;
    };

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("ClaudeAgentClient", () => {
  it("streams a Claude SDK turn through the App Server event contract", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-claude-client-"));
    const sharedRoot = join(root, "shared");
    const executable = join(root, "claude");
    await writeFile(
      executable,
      `#!/bin/sh
if [ "$1" = "auth" ]; then
  printf '%s' '{"loggedIn":true,"email":"claude@example.com","subscriptionType":"max"}'
fi
`,
    );
    await chmod(executable, 0o755);

    const output = new TestQueue<TestStreamMessage>();
    let prompt: AsyncIterable<SDKUserMessage> | null = null;
    const generator = new TestQuery(output);
    const client = new ClaudeAgentClient({ executable, version: "2.1.231" }, (params) => {
      if (!isString(params.prompt)) prompt = params.prompt;
      expect(params.options).toMatchObject({
        cwd: root,
        permissionMode: "default",
        additionalDirectories: [root, sharedRoot],
      });
      const options: DynamicRecord | null = isDynamicRecord(params.options) ? params.options : null;
      const mcpServers: DynamicRecord | null = isDynamicRecord(options?.mcpServers) ? options.mcpServers : null;
      const openbotServer = mcpServers?.openbot;
      const serverInstance = isDynamicRecord(openbotServer) ? openbotServer.instance : null;
      const registeredTools = isDynamicRecord(serverInstance) ? serverInstance._registeredTools : null;
      expect(isDynamicRecord(registeredTools) ? Object.keys(registeredTools) : []).toEqual(
        expect.arrayContaining([
          "attach_files_to_response",
          "remember",
          "forget_memory",
          "list_routines",
          "create_routine",
          "update_routine",
          "delete_routine",
          "test_routine",
          "react_to_user_message",
          "list_sites",
          "publish_site",
          "replace_site",
          "delete_site",
        ]),
      );
      return generator;
    });
    const notifications: Array<{ method: string; params: unknown }> = [];
    client.on("notification", (notification) => notifications.push(notification));
    client.start();

    await expect(client.request("account/read", {}, decodeAccountReadResult)).resolves.toMatchObject({
      account: { type: "claude", email: "claude@example.com", planType: "max" },
    });
    const thread = await client.request(
      "thread/start",
      {
        cwd: root,
        model: "claude-sonnet-5",
        developerInstructions: "Be concise.",
        runtimeWorkspaceRoots: [root, sharedRoot],
      },
      decodeThreadResponse,
    );
    const deliveryId = "8bf58506-96a8-4d96-837c-3ab807b79d1f";
    await client.request(
      "turn/start",
      {
        threadId: thread.thread.id,
        clientUserMessageId: deliveryId,
        input: [{ type: "text", text: "Hello" }],
      },
      decodeTurnResponse,
    );

    if (prompt === null) throw new Error("Claude prompt was not initialized.");
    const promptStream: AsyncIterable<SDKUserMessage> = prompt;
    let sent: SDKUserMessage | undefined;
    for await (const message of promptStream) {
      sent = message;
      break;
    }
    expect(sent).toMatchObject({ uuid: deliveryId, message: { content: "Hello" } });
    output.push({
      type: "stream_event",
      parent_tool_use_id: null,
      session_id: thread.thread.id,
      uuid: deliveryId,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
    });
    output.push({
      type: "result",
      subtype: "success",
      result: "Hi",
      terminal_reason: "completed",
      errors: [],
      session_id: thread.thread.id,
      uuid: deliveryId,
    });
    await waitFor(() => notifications.some((event) => event.method === "turn/completed"));

    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "turn/started" }),
        expect.objectContaining({
          method: "item/agentMessage/delta",
          params: expect.objectContaining({ turnId: deliveryId, delta: "Hi" }),
        }),
        expect.objectContaining({
          method: "turn/completed",
          params: expect.objectContaining({ turn: { id: deliveryId, status: "completed" } }),
        }),
      ]),
    );
    await client.stop();
  });

  it("discovers each model's supported reasoning efforts from the Claude SDK", async () => {
    const query = new TestQuery(new TestQueue<TestStreamMessage>(), [
      {
        value: "opus",
        resolvedModel: "claude-opus-5",
        displayName: "Claude Opus 5",
        description: "Most capable",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "claude-opus-5",
        displayName: "Claude Opus 5 duplicate",
        description: "Duplicate alias",
        supportsEffort: true,
        supportedEffortLevels: ["high"],
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        description: "Balanced",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "max"],
      },
      {
        value: "haiku",
        resolvedModel: "claude-haiku-5",
        displayName: "Claude Haiku 5",
        description: "Fast",
        supportsEffort: false,
      },
    ]);
    const client = new ClaudeAgentClient({ executable: "/bin/true", version: "2.1.251" }, () => query);
    client.start();

    await expect(client.request("model/list", {}, decodeModelListResponse)).resolves.toEqual({
      data: [
        {
          model: "claude-opus-5",
          displayName: "Claude Opus 5",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
            { reasoningEffort: "xhigh" },
            { reasoningEffort: "max" },
          ],
        },
        {
          model: "claude-sonnet-5",
          displayName: "Claude Sonnet 5",
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "max" },
          ],
        },
        {
          model: "claude-haiku-5",
          displayName: "Claude Haiku 5",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        },
      ],
    });
    expect(query.closed).toBe(true);
  });

  it("preserves discovered model capabilities when a later refresh times out", async () => {
    const discoveryQuery = new TestQuery(new TestQueue<TestStreamMessage>(), [
      {
        value: "fable",
        resolvedModel: "claude-fable-5",
        displayName: "Claude Fable 5",
        description: "Fast",
        supportsEffort: false,
      },
    ]);
    const timeoutQuery = new TestQuery(new TestQueue<TestStreamMessage>(), new Promise<ModelInfo[]>(() => {}));
    const runtimeQuery = new TestQuery(new TestQueue<TestStreamMessage>());
    const queries = [discoveryQuery, timeoutQuery, runtimeQuery];
    let runtimeOptions: DynamicRecord | null = null;
    const client = new ClaudeAgentClient({ executable: "/bin/true", version: "2.1.251" }, (params) => {
      const next = queries.shift();
      if (!next) throw new Error("Unexpected Claude query.");
      if (next === runtimeQuery && isDynamicRecord(params.options)) runtimeOptions = params.options;
      return next;
    });
    client.start();

    await client.request("model/list", {}, decodeModelListResponse);
    await expect(client.request("model/list", {}, decodeModelListResponse, 10)).rejects.toThrow(
      "Claude request timed out: model/list",
    );
    await client.request(
      "thread/start",
      { cwd: process.cwd(), model: "claude-fable-5", effort: "medium" },
      decodeThreadResponse,
    );

    expect(runtimeOptions).toMatchObject({ model: "fable" });
    expect(runtimeOptions).not.toHaveProperty("effort");
    expect(timeoutQuery.closed).toBe(true);
    await client.stop();
  });

  it("uses alias-only discovery values for Claude SDK model selection", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-claude-model-alias-"));
    const discoveryQuery = new TestQuery(new TestQueue<TestStreamMessage>(), [
      {
        value: "sonnet",
        displayName: "Claude Sonnet",
        description: "Balanced",
        supportsEffort: true,
        supportedEffortLevels: ["medium", "high"],
      },
    ]);
    const initialQuery = new TestQuery(new TestQueue<TestStreamMessage>());
    const switchingQuery = new TestQuery(new TestQueue<TestStreamMessage>());
    const queries = [discoveryQuery, initialQuery, switchingQuery];
    let initialOptions: DynamicRecord | null = null;
    const client = new ClaudeAgentClient({ executable: "/bin/true", version: "2.1.251" }, (params) => {
      const next = queries.shift();
      if (!next) throw new Error("Unexpected Claude query.");
      if (next === initialQuery && isDynamicRecord(params.options)) initialOptions = params.options;
      return next;
    });
    client.start();

    await expect(client.request("model/list", {}, decodeModelListResponse)).resolves.toEqual({
      data: [expect.objectContaining({ model: "sonnet" })],
    });
    await client.request("thread/start", { cwd: root, model: "sonnet", effort: "medium" }, decodeThreadResponse);
    expect(initialOptions).toMatchObject({ model: "sonnet" });

    const switchingThread = await client.request(
      "thread/start",
      { cwd: root, model: "claude-opus-5", effort: "medium" },
      decodeThreadResponse,
    );
    await client.request(
      "turn/start",
      { threadId: switchingThread.thread.id, model: "sonnet", effort: "medium", input: [] },
      decodeTurnResponse,
    );
    expect(switchingQuery.models).toEqual(["sonnet"]);

    await client.stop();
  });

  it("keeps neutral UI effort for unsupported models without sending effort to Claude", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-claude-effort-support-"));
    const discoveryQuery = new TestQuery(new TestQueue<TestStreamMessage>(), [
      {
        value: "haiku",
        resolvedModel: "claude-haiku-5",
        displayName: "Claude Haiku 5",
        description: "Fast",
        supportsEffort: false,
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        description: "Balanced",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "max"],
      },
    ]);
    const unsupportedQuery = new TestQuery(new TestQueue<TestStreamMessage>());
    const switchingQuery = new TestQuery(new TestQueue<TestStreamMessage>());
    const effortChangingQuery = new TestQuery(new TestQueue<TestStreamMessage>());
    const clearingQuery = new TestQuery(new TestQueue<TestStreamMessage>());
    const queries = [discoveryQuery, unsupportedQuery, switchingQuery, effortChangingQuery, clearingQuery];
    const runtimeOptions: DynamicRecord[] = [];
    const client = new ClaudeAgentClient({ executable: "/bin/true", version: "2.1.251" }, (params) => {
      const next = queries.shift();
      if (!next) throw new Error("Unexpected Claude query.");
      if (next !== discoveryQuery && isDynamicRecord(params.options)) runtimeOptions.push(params.options);
      return next;
    });
    client.start();

    const models = await client.request("model/list", {}, decodeModelListResponse);
    expect(models.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "claude-haiku-5",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        }),
      ]),
    );

    const unsupportedThread = await client.request(
      "thread/start",
      { cwd: root, model: "claude-haiku-5", effort: "medium" },
      decodeThreadResponse,
    );
    expect(runtimeOptions[0]).not.toHaveProperty("effort");
    await client.request(
      "turn/start",
      { threadId: unsupportedThread.thread.id, model: "claude-haiku-5", effort: "high", input: [] },
      decodeTurnResponse,
    );
    expect(unsupportedQuery.flagSettings).toEqual([]);

    const switchingThread = await client.request(
      "thread/start",
      { cwd: root, model: "claude-haiku-5", effort: "medium" },
      decodeThreadResponse,
    );
    await client.request(
      "turn/start",
      { threadId: switchingThread.thread.id, model: "claude-sonnet-5", effort: "high", input: [] },
      decodeTurnResponse,
    );
    expect(switchingQuery.models).toEqual(["sonnet"]);
    expect(switchingQuery.flagSettings).toEqual([{ effortLevel: "low" }]);

    const effortChangingThread = await client.request(
      "thread/start",
      { cwd: root, model: "claude-sonnet-5", effort: "high" },
      decodeThreadResponse,
    );
    expect(runtimeOptions[2]).toMatchObject({ effort: "low" });
    await client.request(
      "turn/start",
      { threadId: effortChangingThread.thread.id, model: "claude-sonnet-5", effort: "max", input: [] },
      decodeTurnResponse,
    );
    expect(effortChangingQuery.models).toEqual([]);
    expect(effortChangingQuery.flagSettings).toEqual([{ effortLevel: "max" }]);

    const clearingThread = await client.request(
      "thread/start",
      { cwd: root, model: "claude-sonnet-5", effort: "medium" },
      decodeThreadResponse,
    );
    await client.request(
      "turn/start",
      { threadId: clearingThread.thread.id, model: "claude-haiku-5", effort: "medium", input: [] },
      decodeTurnResponse,
    );
    expect(clearingQuery.models).toEqual(["haiku"]);
    expect(clearingQuery.flagSettings).toEqual([{ effortLevel: null }]);

    await client.stop();
  });

  it("restarts an inactive session when resumed with updated memory instructions", async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-claude-memory-resume-"));
    const instructions: string[] = [];
    const client = new ClaudeAgentClient({ executable: "/bin/true", version: "2.1.231" }, (params) => {
      const options: DynamicRecord | null = isDynamicRecord(params.options) ? params.options : null;
      const systemPrompt = options?.systemPrompt;
      if (isDynamicRecord(systemPrompt) && isString(systemPrompt.append)) instructions.push(systemPrompt.append);
      return new TestQuery(new TestQueue<TestStreamMessage>());
    });
    client.start();
    const config = {
      cwd: root,
      model: "claude-sonnet-5",
      developerInstructions: "<agent_memories>[]</agent_memories>",
      runtimeWorkspaceRoots: [root],
    };
    const thread = await client.request("thread/start", config, decodeThreadResponse);
    await client.request(
      "thread/resume",
      {
        ...config,
        threadId: thread.thread.id,
        developerInstructions: '<agent_memories>[{"text":"Uses metric units."}]</agent_memories>',
      },
      decodeThreadResponse,
    );

    expect(instructions).toEqual([
      "<agent_memories>[]</agent_memories>",
      '<agent_memories>[{"text":"Uses metric units."}]</agent_memories>',
    ]);
    await client.stop();
  });

  it("uses a complete assistant message when Claude omits stream deltas", async () => {
    const { client, notifications, output, threadId } = await createHarness();
    const turnId = "11111111-1111-4111-8111-111111111111";
    await startTurn(client, threadId, turnId);

    output.push(assistantMessage(threadId, "child-message", "Hidden child response", "tool-use-1"));
    output.push(assistantMessage(threadId, "main-message", "Visible without a refresh"));
    output.push(resultMessage(threadId, turnId, ""));
    await waitFor(() => notifications.some((event) => event.method === "turn/completed"));

    expect(notificationDeltas(notifications)).toEqual(["Visible without a refresh"]);
    expect(completedText(notifications)).toBe("Visible without a refresh");
    expect(JSON.stringify(notifications)).not.toContain("Hidden child response");
    await client.stop();
  });

  it("steers a second user message into the active Claude runtime", async () => {
    const { client, prompt, threadId } = await createHarness();
    const turnId = "44444444-4444-4444-8444-444444444444";
    await startTurn(client, threadId, turnId);
    const iterator = prompt[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ uuid: turnId, message: { content: "Hello" } });

    await expect(
      client.request(
        "turn/steer",
        {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: "55555555-5555-4555-8555-555555555555",
          input: [{ type: "text", text: "Also check the queue." }],
        },
        decodeRecordResponse,
      ),
    ).resolves.toEqual({ turnId });
    const steered = await iterator.next();
    expect(steered.value).toMatchObject({
      uuid: "55555555-5555-4555-8555-555555555555",
      message: { content: "Also check the queue." },
    });
    await client.stop();
  });

  it("adds only the missing suffix from a complete assistant message", async () => {
    const { client, notifications, output, threadId } = await createHarness();
    const turnId = "22222222-2222-4222-8222-222222222222";
    await startTurn(client, threadId, turnId);

    output.push(streamDelta(threadId, turnId, "Hel"));
    output.push(assistantMessage(threadId, "main-message", "Hello"));
    output.push(resultMessage(threadId, turnId, "Hello"));
    await waitFor(() => notifications.some((event) => event.method === "turn/completed"));

    expect(notificationDeltas(notifications)).toEqual(["Hel", "lo"]);
    expect(completedText(notifications)).toBe("Hello");
    await client.stop();
  });

  it("does not duplicate a fully streamed assistant message", async () => {
    const { client, notifications, output, threadId } = await createHarness();
    const turnId = "33333333-3333-4333-8333-333333333333";
    await startTurn(client, threadId, turnId);

    output.push(streamDelta(threadId, turnId, "Hello"));
    output.push(assistantMessage(threadId, "main-message", "Hello"));
    output.push(resultMessage(threadId, turnId, "Hello"));
    await waitFor(() => notifications.some((event) => event.method === "turn/completed"));

    expect(notificationDeltas(notifications)).toEqual(["Hello"]);
    expect(completedText(notifications)).toBe("Hello");
    await client.stop();
  });
});

async function createHarness(): Promise<{
  client: ClaudeAgentClient;
  notifications: Array<{ method: string; params: unknown }>;
  output: TestQueue<TestStreamMessage>;
  prompt: AsyncIterable<SDKUserMessage>;
  threadId: string;
}> {
  root = await mkdtemp(join(tmpdir(), "openbot-claude-client-"));
  const output = new TestQueue<TestStreamMessage>();
  let prompt: AsyncIterable<SDKUserMessage> | null = null;
  const generator = new TestQuery(output);
  const client = new ClaudeAgentClient({ executable: "/bin/true", version: "2.1.231" }, (params) => {
    if (!isString(params.prompt)) prompt = params.prompt;
    return generator;
  });
  const notifications: Array<{ method: string; params: unknown }> = [];
  client.on("notification", (notification) => notifications.push(notification));
  client.start();
  const thread = await client.request(
    "thread/start",
    {
      cwd: root,
      model: "claude-sonnet-5",
      developerInstructions: "Be concise.",
      runtimeWorkspaceRoots: [root],
    },
    decodeThreadResponse,
  );
  if (!prompt) throw new Error("Claude prompt was not initialized.");
  return { client, notifications, output, prompt, threadId: thread.thread.id };
}

function startTurn(client: ClaudeAgentClient, threadId: string, turnId: string) {
  return client.request(
    "turn/start",
    {
      threadId,
      clientUserMessageId: turnId,
      input: [{ type: "text", text: "Hello" }],
    },
    decodeTurnResponse,
  );
}

function streamDelta(threadId: string, turnId: string, text: string): TestStreamMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    session_id: threadId,
    uuid: turnId,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  };
}

function assistantMessage(
  threadId: string,
  messageId: string,
  text: string,
  parentToolUseId: string | null = null,
): TestStreamMessage {
  return {
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    session_id: threadId,
    uuid: messageId,
    message: { content: [{ type: "text", text }] },
  };
}

function resultMessage(threadId: string, turnId: string, result: string): TestStreamMessage {
  return {
    type: "result",
    subtype: "success",
    result,
    terminal_reason: "completed",
    errors: [],
    session_id: threadId,
    uuid: turnId,
  };
}

function notificationDeltas(notifications: Array<{ method: string; params: unknown }>): string[] {
  return notifications
    .filter((event) => event.method === "item/agentMessage/delta")
    .map((event) => getString(event.params, "delta") ?? "");
}

function completedText(notifications: Array<{ method: string; params: unknown }>): string {
  const completed = notifications.find((event) => event.method === "item/completed");
  const item = getRecord(completed?.params, "item");
  return getString(item, "text") ?? "";
}

class TestQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class TestQuery implements AsyncIterable<TestStreamMessage> {
  closed = false;
  readonly models: Array<string | undefined> = [];
  readonly flagSettings: Array<{
    effortLevel?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  }> = [];

  constructor(
    private readonly output: TestQueue<TestStreamMessage>,
    private readonly supportedModelList: ModelInfo[] | Promise<ModelInfo[]> = [],
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<TestStreamMessage> {
    return this.output[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<undefined> {
    return undefined;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return this.supportedModelList;
  }

  async setModel(model?: string): Promise<void> {
    this.models.push(model);
  }

  async applyFlagSettings(settings: {
    effortLevel?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  }): Promise<void> {
    this.flagSettings.push(settings);
  }

  close(): void {
    this.closed = true;
    this.output.close();
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!check()) throw new Error("Timed out waiting for Claude adapter events.");
  });
}
