import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotSummary, ConversationMessage } from "@openbot/contracts/ipc";
import type { AgentClient, AgentProvider } from "../src/backend/agent-client";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { ClaudeAgentClient } from "../src/backend/claude-client";
import { resolveClaudeCli, resolveCodexCli } from "../src/backend/cli";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import {
  getRecord,
  getString,
  type ThreadResponse,
  type TurnResponse,
} from "../src/backend/protocol";

const EXPECTED = "OPENBOT_SQLITE_SMOKE_OK";
const root = await mkdtemp(join(tmpdir(), "openbot-provider-storage-smoke-"));

try {
  const database = new OpenBotDatabase(join(root, "user-data"));
  await database.initialize();
  const codex = await resolveCodexCli();
  const claude = await resolveClaudeCli();
  await runProvider(
    database,
    "codex",
    new CodexAppServerClient(codex.executable, 60_000),
    "gpt-5.6-luna",
  );
  await runProvider(database, "claude", new ClaudeAgentClient(claude), "claude-opus-5");
  database.close();
  process.stdout.write(
    "Codex and Claude stored a completed live turn in the temporary SQLite database.\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runProvider(
  database: OpenBotDatabase,
  provider: AgentProvider,
  client: AgentClient,
  model: BotSummary["model"],
): Promise<void> {
  const botId = `smoke-${provider}`;
  const threadId = `openbot-thread-${botId}`;
  const workspace = join(root, "workspace", provider);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const bot: BotSummary = {
    id: botId,
    name: `${provider} smoke`,
    role: "Storage verification",
    description: "",
    notifications: false,
    model,
    reasoningEffort: "low",
    threadId,
    workspacePath: workspace,
    preview: "No messages yet",
    updatedAt: new Date().toISOString(),
    avatarSeed: botId,
    avatarHue: null,
    avatarUrl: null,
  };
  database.replaceAgents(
    `smoke:agent:${provider}`,
    [...database.listAgents(), bot],
    "agent.created",
  );

  const userMessage: ConversationMessage = {
    id: randomUUID(),
    author: "user",
    text: `Reply with exactly: ${EXPECTED}`,
    createdAt: new Date().toISOString(),
    status: "completed",
  };
  const assistantMessage: ConversationMessage = {
    id: randomUUID(),
    author: "assistant",
    text: "",
    createdAt: new Date().toISOString(),
    status: "streaming",
  };
  let turnId = "";
  let resolveCompleted: (() => void) | null = null;
  let rejectCompleted: ((error: Error) => void) | null = null;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const timeout = setTimeout(
    () => rejectCompleted?.(new Error(`${provider} live smoke timed out.`)),
    120_000,
  );

  client.on("notification", (notification) => {
    const params = notification.params;
    if (notification.method === "item/agentMessage/delta") {
      assistantMessage.id = getString(params, "itemId") ?? assistantMessage.id;
      assistantMessage.text += getString(params, "delta") ?? "";
      return;
    }
    if (notification.method === "item/completed") {
      const item = getRecord(params, "item");
      if (item?.type === "agentMessage") {
        assistantMessage.id = getString(item, "id") ?? assistantMessage.id;
        assistantMessage.text = getString(item, "text") ?? assistantMessage.text;
      }
      return;
    }
    if (notification.method === "turn/completed") resolveCompleted?.();
  });
  client.on("request", (request) => client.respond(request.id, { decision: "approved" }));
  client.once("exit", (error) => rejectCompleted?.(error));
  client.start();
  try {
    await client.request("initialize", {
      clientInfo: { name: "openbot-storage-smoke", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    const started = await client.request<ThreadResponse>("thread/start", {
      model,
      effort: "low",
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: "Return only the exact text requested by the user.",
      ephemeral: provider === "codex",
      persistSession: provider !== "claude",
      dynamicTools: [],
    });
    database.bindProviderSession({
      threadId,
      provider,
      externalSessionId: started.thread.id,
      model,
      effort: "low",
    });
    const turn = await client.request<TurnResponse>("turn/start", {
      threadId: started.thread.id,
      model,
      effort: "low",
      clientUserMessageId: userMessage.id,
      input: [{ type: "text", text: userMessage.text }],
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    turnId = turn.turn.id;
    assistantMessage.turnId = turnId;
    database.persistConversation(
      {
        botId,
        threadId,
        activeTurnId: turnId,
        revision: 0,
        messages: [userMessage],
      },
      "turn.started",
      { provider, turnId },
    );
    await completed;
    assistantMessage.status = "completed";
    database.persistConversation(
      {
        botId,
        threadId,
        activeTurnId: null,
        revision: 0,
        messages: [userMessage, assistantMessage],
      },
      "turn.completed",
      { provider, turnId, status: "completed" },
    );
    const stored = database.readConversation(botId, threadId);
    if (
      stored.activeTurnId !== null ||
      stored.messages.length !== 2 ||
      stored.messages[0]?.author !== "user" ||
      stored.messages[1]?.author !== "assistant" ||
      stored.messages[1]?.status !== "completed" ||
      stored.messages[1]?.text.trim() !== EXPECTED
    ) {
      throw new Error(
        `${provider} live smoke returned or stored an unexpected result: ${JSON.stringify({
          activeTurnId: stored.activeTurnId,
          messages: stored.messages.map((message) => ({
            author: message.author,
            status: message.status,
            text: message.text,
          })),
        })}`,
      );
    }
  } finally {
    clearTimeout(timeout);
    await client.stop();
  }
}
