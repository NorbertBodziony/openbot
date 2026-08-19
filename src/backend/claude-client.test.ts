// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAgentClient } from "./claude-client";
import {
  decodeAccountReadResult,
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
        runtimeWorkspaceRoots: [root],
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
  constructor(private readonly output: TestQueue<TestStreamMessage>) {}

  [Symbol.asyncIterator](): AsyncIterator<TestStreamMessage> {
    return this.output[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<undefined> {
    return undefined;
  }

  async setModel(_model?: string): Promise<void> {}

  async setMaxThinkingTokens(
    _maxThinkingTokens: number | null,
    _thinkingDisplay?: "summarized" | "omitted" | null,
  ): Promise<void> {}

  close(): void {
    this.output.close();
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Claude adapter events.");
}
