import type { AgentEvent } from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProvider } from "./agent-client";
import { AgentService } from "./agent-service";
import {
  CREATE_BOT_INPUT,
  createFakeClaude,
  FakeAgentClient,
  fakeBrowser,
  notification,
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

describe.sequential("AgentService: questions", () => {
  it("does not use a question prompt summary as the completed assistant reply", async () => {
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
    await service.sendMessage({ botId: "chief", text: "Ask only one question" });
    await waitFor(() => events.some((event) => event.type === "turn-started"));

    const client = clients.get("codex");
    const threadId = store.activeProviderSession("chief")?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The question-only turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "question-only-call",
      params: {
        threadId,
        turnId,
        callId: "question-only-call",
        namespace: "openbot",
        tool: "ask_user",
        arguments: {
          questions: [{ id: "scope", header: "Scope", question: "Which scope should we use?" }],
        },
      },
    });
    await waitFor(() => events.some((event) => event.type === "prompt"));
    await service.respondToPrompt({ requestId: "question-only-call", answers: { scope: ["Small"] } });
    const previewBeforeCompletion = service.listBots().find((bot) => bot.id === "chief")?.preview;

    client.emit(
      "notification",
      notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } }),
    );
    await waitFor(() => events.some((event) => event.type === "turn-completed"));

    const previewAfterCompletion = service.listBots().find((bot) => bot.id === "chief")?.preview;
    expect(previewAfterCompletion).toBe(previewBeforeCompletion);
    expect(previewAfterCompletion).not.toContain("Which scope should we use?");
  });

  it("keeps prompts from a healthy provider active when another provider exits", async () => {
    process.env.OPENBOT_CLAUDE_PATH = await createFakeClaude(root);
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
    await service.sendMessage({ botId: "chief", text: "Ask from Codex" });
    await service.setPreferredProvider("claude");
    const claudeBot = await service.createBot({
      ...CREATE_BOT_INPUT,
      name: "Claude Prompt Bot",
      avatarSeed: "setup:claude-prompt",
    });
    await service.sendMessage({ botId: claudeBot.id, text: "Ask from Claude" });
    await waitFor(() => events.filter((event) => event.type === "turn-started").length === 2);

    const codexClient = clients.get("codex");
    const claudeClient = clients.get("claude");
    const codexThreadId = store.activeProviderSession("chief")?.externalSessionId;
    const claudeThreadId = store.activeProviderSession(claudeBot.id)?.externalSessionId;
    const codexTurn = events.find((event) => event.type === "turn-started" && event.botId === "chief");
    const claudeTurn = events.find((event) => event.type === "turn-started" && event.botId === claudeBot.id);
    if (
      !codexClient ||
      !claudeClient ||
      !codexThreadId ||
      !claudeThreadId ||
      codexTurn?.type !== "turn-started" ||
      claudeTurn?.type !== "turn-started"
    ) {
      throw new Error("Both provider turns did not start.");
    }

    codexClient.emit("request", {
      method: "item/tool/call",
      id: "codex-provider-prompt",
      params: {
        threadId: codexThreadId,
        turnId: codexTurn.turnId,
        callId: "codex-provider-prompt",
        namespace: "openbot",
        tool: "ask_user",
        arguments: { questions: [{ id: "codex", header: "Codex", question: "Codex question?" }] },
      },
    });
    claudeClient.emit("request", {
      method: "item/tool/call",
      id: "claude-provider-prompt",
      params: {
        threadId: claudeThreadId,
        turnId: claudeTurn.turnId,
        callId: "claude-provider-prompt",
        namespace: "openbot",
        tool: "ask_user",
        arguments: { questions: [{ id: "claude", header: "Claude", question: "Claude question?" }] },
      },
    });
    await waitFor(() => events.filter((event) => event.type === "prompt").length === 2);

    codexClient.emit("exit", new Error("Codex exited."));
    await waitFor(() => events.some((event) => event.type === "error" && event.code === "codex_exited"));
    expect(
      (await service.readConversation("chief")).messages.find(
        (message) => message.questionPrompt?.requestId === "codex-provider-prompt",
      )?.questionPrompt?.resolution,
    ).toEqual({ status: "expired" });
    expect(
      (await service.readConversation(claudeBot.id)).messages.find(
        (message) => message.questionPrompt?.requestId === "claude-provider-prompt",
      )?.questionPrompt?.resolution,
    ).toBeNull();

    await service.respondToPrompt({ requestId: "claude-provider-prompt", answers: { claude: ["Still active"] } });
    expect(claudeClient.responses.find((response) => response.id === "claude-provider-prompt")).toBeDefined();
  });
});
