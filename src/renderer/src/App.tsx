import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type {
  AgentEvent,
  AgentStatus,
  AppInfo,
  BotSummary,
  ConversationMessage,
} from "../../shared/ipc";
import { Conversation } from "./components/Conversation";
import { Sidebar } from "./components/Sidebar";
import { type BotAccent, type BotMessage, type BotProfile, bots as initialBots } from "./data";

const FALLBACK_STATUS: AgentStatus = {
  phase: "blocked",
  cliVersion: null,
  auth: { kind: "unknown" },
  capabilities: { chat: "unavailable", browser: "unavailable", computerUse: "unavailable" },
  message: "Local Codex is unavailable.",
  fullAccess: true,
};

export function App() {
  const [botList, setBotList] = createSignal<BotProfile[]>(initialBots);
  const [activeBotId, setActiveBotId] = createSignal("sales-outbound");
  const [liveMessages, setLiveMessages] = createSignal<Record<string, BotMessage[]>>({});
  const [activeTurns, setActiveTurns] = createSignal<Record<string, string | null>>({});
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const [creatingAgent, setCreatingAgent] = createSignal(false);
  const [pendingPrompts, setPendingPrompts] = createSignal<
    Record<string, Extract<AgentEvent, { type: "prompt" }> | undefined>
  >({});
  const [appInfo, setAppInfo] = createSignal<AppInfo | null>(null);
  const [agentStatus, setAgentStatus] = createSignal<AgentStatus>(FALLBACK_STATUS);
  const activeBot = createMemo(
    () => botList().find((bot) => bot.id === activeBotId()) ?? botList()[0],
  );
  const activeMessages = createMemo(() => {
    const bot = activeBot();
    if (!bot) return [];
    const live = liveMessages()[bot.id];
    return live?.length ? live : bot.messages;
  });

  onMount(() => {
    const unsubscribe = window.infeld.agent.onEvent(handleAgentEvent);
    onCleanup(unsubscribe);

    void Promise.all([
      window.infeld
        .getAppInfo()
        .then(setAppInfo)
        .catch(() =>
          setAppInfo({ name: "Infeld Bot", version: "unavailable", platform: "darwin" }),
        ),
      window.infeld.agent
        .getStatus()
        .then(setAgentStatus)
        .catch(() => undefined),
      window.infeld.agent
        .listBots()
        .then(mergeStoredBots)
        .catch(() => undefined),
    ]);
  });

  createEffect(() => {
    const botId = activeBotId();
    void window.infeld.agent
      .readConversation(botId)
      .then((snapshot) => {
        if (!snapshot.messages.length) {
          setActiveTurns((current) => ({ ...current, [botId]: snapshot.activeTurnId }));
          return;
        }
        setLiveMessages((current) => ({
          ...current,
          [botId]: snapshot.messages.map(toBotMessage),
        }));
        setActiveTurns((current) => ({ ...current, [botId]: snapshot.activeTurnId }));
      })
      .catch(() => undefined);
  });

  function handleAgentEvent(event: AgentEvent) {
    switch (event.type) {
      case "status":
        setAgentStatus(event.status);
        return;
      case "conversation":
        setLiveMessages((current) => ({
          ...current,
          [event.snapshot.botId]: event.snapshot.messages.map(toBotMessage),
        }));
        setActiveTurns((current) => ({
          ...current,
          [event.snapshot.botId]: event.snapshot.activeTurnId,
        }));
        return;
      case "turn-started":
        setActiveTurns((current) => ({ ...current, [event.botId]: event.turnId }));
        return;
      case "turn-completed":
        setActiveTurns((current) => ({ ...current, [event.botId]: null }));
        return;
      case "prompt":
        setPendingPrompts((current) => ({ ...current, [event.botId]: event }));
        appendSystemMessage(
          event.botId,
          event.questions.map((question, index) => `${index + 1}. ${question.question}`).join("\n"),
          "Input needed · reply below",
        );
        return;
      case "error":
        if (event.botId) appendSystemMessage(event.botId, event.message, "Error");
    }
  }

  function mergeStoredBots(_storedBots: BotSummary[]) {
    setBotList(initialBots);
  }

  async function createAgent() {
    if (creatingAgent()) return;
    setCreatingAgent(true);
    try {
      const stored = await window.infeld.agent.createBot();
      const newAgent = toBotProfile(stored, 0);
      setBotList((current) => [newAgent, ...current]);
      setLiveMessages((current) => ({ ...current, [newAgent.id]: [] }));
      setAgentPickerOpen(false);
      setActiveBotId(newAgent.id);
    } catch (error) {
      setAgentPickerOpen(false);
      appendSystemMessage(activeBotId(), String(error), "Create failed");
    } finally {
      setCreatingAgent(false);
    }
  }

  function selectBot(botId: string) {
    setAgentPickerOpen(false);
    setActiveBotId(botId);
  }

  function sendMessage(body: string) {
    const trimmed = body.trim();
    const bot = activeBot();
    if (!trimmed || !bot) return;

    setLiveMessages((current) => ({
      ...current,
      [bot.id]: [
        ...(current[bot.id] ?? []),
        { author: "you", body: trimmed, time: formatTime(new Date().toISOString()) },
      ],
    }));

    const prompt = pendingPrompts()[bot.id];
    if (prompt) {
      const lines = trimmed.split("\n").map((line) => line.trim());
      const answers = Object.fromEntries(
        prompt.questions.map((question, index) => [
          question.id,
          [lines[index] || (prompt.questions.length === 1 ? trimmed : "")],
        ]),
      );
      void window.infeld.agent
        .respondToPrompt({ requestId: prompt.requestId, answers })
        .then(() => {
          setPendingPrompts((current) => ({ ...current, [bot.id]: undefined }));
        })
        .catch((error) => appendSystemMessage(bot.id, String(error), "Answer failed"));
      return;
    }

    void window.infeld.agent
      .sendMessage({ botId: bot.id, text: trimmed })
      .then((turn) => {
        setActiveTurns((current) => ({ ...current, [bot.id]: turn.turnId }));
      })
      .catch((error) => appendSystemMessage(bot.id, String(error), "Error"));
  }

  function stopActiveTurn() {
    const bot = activeBot();
    const turnId = bot ? activeTurns()[bot.id] : null;
    if (!bot || !turnId) return;
    void window.infeld.agent.interrupt({ botId: bot.id, turnId }).catch((error) => {
      appendSystemMessage(bot.id, String(error), "Stop failed");
    });
  }

  function appendSystemMessage(botId: string, body: string, status: string) {
    setLiveMessages((current) => ({
      ...current,
      [botId]: [
        ...(current[botId] ?? []),
        { author: "bot", body, time: formatTime(new Date().toISOString()), status },
      ],
    }));
  }

  return (
    <div class="app-frame">
      <Sidebar
        bots={botList()}
        activeBotId={activeBot()?.id ?? ""}
        appInfo={appInfo()}
        agentStatus={agentStatus()}
        onSelectBot={selectBot}
        onCreateBot={() => setAgentPickerOpen(true)}
      />
      <Conversation
        bot={activeBot()}
        bots={botList()}
        messages={activeMessages()}
        activeTurnId={activeBot() ? activeTurns()[activeBot()?.id ?? ""] : null}
        agentPickerOpen={agentPickerOpen()}
        creatingAgent={creatingAgent()}
        onCloseAgentPicker={() => setAgentPickerOpen(false)}
        onCreateAgent={() => void createAgent()}
        onSelectAgent={selectBot}
        onSendMessage={sendMessage}
        onStop={stopActiveTurn}
      />
    </div>
  );
}

function toBotProfile(stored: BotSummary, index: number): BotProfile {
  const visual = initialBots.find((bot) => bot.id === stored.id);
  return {
    id: stored.id,
    name: stored.name,
    role: stored.role,
    initials: visual?.initials ?? stored.name.slice(0, 1).toUpperCase(),
    accent:
      visual?.accent ??
      (stored.name.toLowerCase() === "new agent" ? "neutral" : accentForIndex(index)),
    time: stored.updatedAt ? formatTime(stored.updatedAt) : (visual?.time ?? "now"),
    preview: stored.preview,
    messages: visual?.messages ?? [],
  };
}

function toBotMessage(message: ConversationMessage): BotMessage {
  return {
    author: message.author === "user" ? "you" : "bot",
    body: message.text,
    time: formatTime(message.createdAt),
    status:
      message.status === "streaming"
        ? "Typing…"
        : message.status === "failed"
          ? "Failed"
          : message.status === "interrupted"
            ? "Stopped"
            : undefined,
  };
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function accentForIndex(index: number): BotAccent {
  const accents: BotAccent[] = ["teal", "orange", "purple", "blue", "violet", "coral"];
  return accents[index % accents.length];
}
