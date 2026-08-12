import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type {
  AgentEvent,
  AgentStatus,
  AppInfo,
  BotSummary,
  BrowserTab,
  ConversationMessage,
  QueueSnapshot,
  UpdateBotInput,
} from "../../shared/ipc";
import { Conversation } from "./components/Conversation";
import { Sidebar } from "./components/Sidebar";
import { accentForBot, type BotMessage, type BotProfile } from "./data";

const FALLBACK_STATUS: AgentStatus = {
  phase: "blocked",
  cliVersion: null,
  auth: { kind: "unknown" },
  capabilities: { chat: "unavailable", browser: "unavailable", computerUse: "unavailable" },
  message: "Local Codex is unavailable.",
  fullAccess: true,
};

type PromptEvent = Extract<AgentEvent, { type: "prompt" }>;

export function App() {
  const [botList, setBotList] = createSignal<BotProfile[]>([]);
  const [activeBotId, setActiveBotId] = createSignal("");
  const [liveMessages, setLiveMessages] = createSignal<Record<string, BotMessage[]>>({});
  const [uiErrors, setUiErrors] = createSignal<Record<string, BotMessage[]>>({});
  const [conversationLoaded, setConversationLoaded] = createSignal<Record<string, boolean>>({});
  const [activeTurns, setActiveTurns] = createSignal<Record<string, string | null>>({});
  const [queues, setQueues] = createSignal<Record<string, QueueSnapshot>>({});
  const [browserTabs, setBrowserTabs] = createSignal<BrowserTab[]>([]);
  const [activeBrowserTabId, setActiveBrowserTabId] = createSignal<string | null>(null);
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const [creatingAgent, setCreatingAgent] = createSignal(false);
  const [settingsRequest, setSettingsRequest] = createSignal<{
    botId: string;
    nonce: number;
  } | null>(null);
  const [pendingPrompts, setPendingPrompts] = createSignal<Record<string, PromptEvent | undefined>>(
    {},
  );
  const [appInfo, setAppInfo] = createSignal<AppInfo | null>(null);
  const [agentStatus, setAgentStatus] = createSignal<AgentStatus>(FALLBACK_STATUS);

  const activeBot = createMemo(
    () => botList().find((bot) => bot.id === activeBotId()) ?? botList()[0],
  );
  const activeMessages = createMemo(() => {
    const bot = activeBot();
    return bot ? [...(liveMessages()[bot.id] ?? []), ...(uiErrors()[bot.id] ?? [])] : [];
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
        .then(applyStoredBots)
        .catch((error) => {
          setAgentStatus((current) => ({ ...current, message: String(error) }));
        }),
    ]);
  });

  createEffect(() => {
    const botId = activeBot()?.id;
    if (!botId) return;
    void Promise.all([
      window.infeld.agent.readConversation(botId),
      window.infeld.agent.listQueue(botId),
    ])
      .then(([snapshot, queue]) => {
        setQueues((current) => ({ ...current, [botId]: queue }));
        applyConversation(snapshot.botId, snapshot.messages, snapshot.activeTurnId);
      })
      .catch((error) => appendUiError(botId, error, "Load failed"));
  });

  function handleAgentEvent(event: AgentEvent) {
    switch (event.type) {
      case "status":
        setAgentStatus(event.status);
        return;
      case "bots-changed":
        applyStoredBots(event.bots);
        return;
      case "conversation":
        applyConversation(
          event.snapshot.botId,
          event.snapshot.messages,
          event.snapshot.activeTurnId,
        );
        return;
      case "queue-changed":
        setQueues((current) => ({ ...current, [event.snapshot.botId]: event.snapshot }));
        return;
      case "browser-changed":
        setBrowserTabs(event.tabs);
        setActiveBrowserTabId(event.activeTabId);
        return;
      case "turn-started":
        setActiveTurns((current) => ({ ...current, [event.botId]: event.turnId }));
        return;
      case "turn-completed":
        setActiveTurns((current) => ({ ...current, [event.botId]: null }));
        return;
      case "prompt":
        setPendingPrompts((current) => ({ ...current, [event.botId]: event }));
        return;
      case "error":
        if (event.botId) appendUiError(event.botId, event.message, "Error");
    }
  }

  function applyStoredBots(storedBots: BotSummary[]) {
    const profiles = storedBots.map(toBotProfile);
    setBotList(profiles);
    setActiveBotId((current) =>
      profiles.some((bot) => bot.id === current) ? current : (profiles[0]?.id ?? ""),
    );
  }

  function applyConversation(
    botId: string,
    messages: ConversationMessage[],
    activeTurnId: string | null,
  ) {
    setLiveMessages((current) => ({
      ...current,
      [botId]: messages.map((message) => toBotMessage(message, botList())),
    }));
    setConversationLoaded((current) => ({ ...current, [botId]: true }));
    setActiveTurns((current) => ({ ...current, [botId]: activeTurnId }));
  }

  async function createAgent() {
    if (creatingAgent()) return;
    setCreatingAgent(true);
    try {
      const stored = await window.infeld.agent.createBot();
      const newAgent = toBotProfile(stored);
      setBotList((current) => [newAgent, ...current.filter((item) => item.id !== newAgent.id)]);
      setLiveMessages((current) => ({ ...current, [newAgent.id]: [] }));
      setConversationLoaded((current) => ({ ...current, [newAgent.id]: true }));
      setAgentPickerOpen(false);
      setActiveBotId(newAgent.id);
    } catch (error) {
      setAgentPickerOpen(false);
      if (activeBotId()) appendUiError(activeBotId(), error, "Create failed");
    } finally {
      setCreatingAgent(false);
    }
  }

  function selectBot(botId: string) {
    setAgentPickerOpen(false);
    setActiveBotId(botId);
  }

  function activateBrowserTab(tabId: string) {
    void window.infeld.browser.activate(tabId);
  }

  function closeBrowserTab(tabId: string) {
    void window.infeld.browser.close(tabId);
  }

  async function updateBot(botId: string, updates: Omit<UpdateBotInput, "botId">) {
    const previous = botList();
    setBotList((current) =>
      current.map((bot) => (bot.id === botId ? { ...bot, ...updates } : bot)),
    );
    try {
      const stored = await window.infeld.agent.updateBot({ botId, ...updates });
      setBotList((current) =>
        current.map((bot) => (bot.id === botId ? toBotProfile(stored) : bot)),
      );
    } catch (error) {
      setBotList(previous);
      appendUiError(botId, error, "Settings failed");
      throw error;
    }
  }

  function editBot(botId: string) {
    selectBot(botId);
    setSettingsRequest({ botId, nonce: Date.now() });
  }

  async function deleteBot(botId: string) {
    try {
      await window.infeld.agent.deleteBot(botId);
      const remaining = botList().filter((bot) => bot.id !== botId);
      setBotList(remaining);
      setActiveBotId((current) => (current === botId ? (remaining[0]?.id ?? "") : current));
      setSettingsRequest((current) => (current?.botId === botId ? null : current));
      setLiveMessages((current) => withoutBot(current, botId));
      setUiErrors((current) => withoutBot(current, botId));
      setConversationLoaded((current) => withoutBot(current, botId));
      setActiveTurns((current) => withoutBot(current, botId));
      setQueues((current) => withoutBot(current, botId));
      setPendingPrompts((current) => withoutBot(current, botId));
    } catch (error) {
      appendUiError(botId, error, "Delete failed");
      throw error;
    }
  }

  async function sendMessage(body: string, attachmentDraftIds: string[]): Promise<boolean> {
    const bot = activeBot();
    if (!bot || (!body.trim() && attachmentDraftIds.length === 0)) return false;
    try {
      await window.infeld.agent.sendMessage({
        botId: bot.id,
        text: body.trim(),
        attachmentDraftIds,
      });
      setUiErrors((current) => ({ ...current, [bot.id]: [] }));
      return true;
    } catch (error) {
      appendUiError(bot.id, error, "Send failed");
      return false;
    }
  }

  async function answerPrompt(answers: Record<string, string[]>): Promise<boolean> {
    const bot = activeBot();
    const prompt = bot ? pendingPrompts()[bot.id] : undefined;
    if (!bot || !prompt) return false;
    try {
      await window.infeld.agent.respondToPrompt({ requestId: prompt.requestId, answers });
      setPendingPrompts((current) => ({ ...current, [bot.id]: undefined }));
      return true;
    } catch (error) {
      appendUiError(bot.id, error, "Answer failed");
      return false;
    }
  }

  function cancelQueuedMessage(deliveryId: string) {
    const bot = activeBot();
    if (!bot) return;
    void window.infeld.agent
      .cancelQueuedMessage({ botId: bot.id, deliveryId })
      .catch((error) => appendUiError(bot.id, error, "Cancel failed"));
  }

  function resumeQueue() {
    const bot = activeBot();
    if (!bot) return;
    void window.infeld.agent
      .setQueuePaused({ botId: bot.id, paused: false })
      .catch((error) => appendUiError(bot.id, error, "Resume failed"));
  }

  function stopActiveTurn() {
    const bot = activeBot();
    const turnId = bot ? activeTurns()[bot.id] : null;
    if (!bot || !turnId) return;
    void window.infeld.agent
      .interrupt({ botId: bot.id, turnId })
      .catch((error) => appendUiError(bot.id, error, "Stop failed"));
  }

  function appendUiError(botId: string, error: unknown, status: string) {
    const body = error instanceof Error ? error.message : String(error);
    setUiErrors((current) => ({
      ...current,
      [botId]: [
        ...(current[botId] ?? []),
        {
          id: `ui-${Date.now()}-${Math.random()}`,
          author: "bot",
          body,
          time: formatTime(new Date().toISOString()),
          status,
        },
      ],
    }));
  }

  const activeQueue = createMemo(() => {
    const bot = activeBot();
    return bot ? queues()[bot.id] : undefined;
  });

  return (
    <div class="app-frame">
      <Sidebar
        bots={botList()}
        activeBotId={activeBot()?.id ?? ""}
        appInfo={appInfo()}
        agentStatus={agentStatus()}
        onSelectBot={selectBot}
        onCreateBot={() => setAgentPickerOpen(true)}
        onEditBot={editBot}
        onDeleteBot={deleteBot}
      />
      <Conversation
        bot={activeBot()}
        bots={botList()}
        messages={activeMessages()}
        loaded={activeBot() ? conversationLoaded()[activeBot()?.id ?? ""] === true : false}
        queue={activeQueue()}
        browserTabs={browserTabs()}
        activeBrowserTabId={activeBrowserTabId()}
        prompt={activeBot() ? pendingPrompts()[activeBot()?.id ?? ""] : undefined}
        activeTurnId={activeBot() ? activeTurns()[activeBot()?.id ?? ""] : null}
        agentPickerOpen={agentPickerOpen()}
        creatingAgent={creatingAgent()}
        settingsRequest={settingsRequest()}
        onCloseAgentPicker={() => setAgentPickerOpen(false)}
        onCreateAgent={() => void createAgent()}
        onSelectAgent={selectBot}
        onUpdateBot={updateBot}
        onSendMessage={sendMessage}
        onAnswerPrompt={answerPrompt}
        onCancelQueuedMessage={cancelQueuedMessage}
        onResumeQueue={resumeQueue}
        onActivateBrowserTab={activateBrowserTab}
        onCloseBrowserTab={closeBrowserTab}
        onStop={stopActiveTurn}
      />
    </div>
  );
}

function toBotProfile(stored: BotSummary): BotProfile {
  return {
    id: stored.id,
    name: stored.name,
    role: stored.role,
    description: stored.description,
    notifications: stored.notifications,
    threadId: stored.threadId,
    initials: stored.name.slice(0, 1).toUpperCase(),
    accent: stored.name.toLowerCase() === "new agent" ? "neutral" : accentForBot(stored.id),
    time: stored.updatedAt ? formatTime(stored.updatedAt) : "now",
    preview: cleanPreview(stored.preview),
  };
}

function toBotMessage(message: ConversationMessage, bots: BotProfile[]): BotMessage {
  const sender = message.senderBotId
    ? (bots.find((bot) => bot.id === message.senderBotId)?.name ?? message.senderBotId)
    : null;
  const exchangeSenderId = message.senderBotId ?? message.exchange?.senderBotId;
  return {
    id: message.id,
    author: message.author === "user" ? "you" : "bot",
    body: message.text,
    time: formatTime(message.createdAt),
    kind: message.exchange ? "exchange" : "text",
    senderBotId: exchangeSenderId,
    senderLabel: sender ? `Message from ${sender}` : undefined,
    replyToMessageId: message.replyToMessageId,
    attachments: message.attachments,
    exchange: message.exchange,
    status: message.exchange
      ? undefined
      : message.delivery?.status === "queued"
        ? `Queued #${message.delivery.position}`
        : message.delivery?.status === "starting"
          ? "Starting…"
          : message.delivery?.status === "running"
            ? "Working…"
            : message.delivery?.status === "cancelled"
              ? "Cancelled"
              : message.status === "streaming"
                ? "Typing…"
                : message.status === "failed"
                  ? "Failed"
                  : message.status === "interrupted"
                    ? "Stopped"
                    : undefined,
  };
}

function cleanPreview(preview: string): string {
  const cleaned = preview
    .replace(/\binbox\s+at\s+zero\b[:,]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || "No messages yet";
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function withoutBot<T>(values: Record<string, T>, botId: string): Record<string, T> {
  const next = { ...values };
  delete next[botId];
  return next;
}
