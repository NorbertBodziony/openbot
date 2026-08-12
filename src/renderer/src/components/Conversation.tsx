import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  AgentEvent,
  AgentPromptQuestion,
  AttachmentSummary,
  BrowserTab,
  DraftAttachment,
  QueueSnapshot,
  UpdateBotInput,
} from "../../../shared/ipc";
import type { BotMessage, BotProfile } from "../data";
import { GrokMark } from "./GrokMark";

interface ConversationProps {
  bot: BotProfile | undefined;
  bots: BotProfile[];
  messages: BotMessage[];
  loaded: boolean;
  activeTurnId: string | null | undefined;
  agentPickerOpen: boolean;
  creatingAgent: boolean;
  settingsRequest: { botId: string; nonce: number } | null;
  queue: QueueSnapshot | undefined;
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  prompt: Extract<AgentEvent, { type: "prompt" }> | undefined;
  onCloseAgentPicker: () => void;
  onCreateAgent: () => void;
  onSelectAgent: (botId: string) => void;
  onUpdateBot: (botId: string, updates: Omit<UpdateBotInput, "botId">) => Promise<void>;
  onSendMessage: (body: string, attachmentDraftIds: string[]) => Promise<boolean>;
  onAnswerPrompt: (answers: Record<string, string[]>) => Promise<boolean>;
  onCancelQueuedMessage: (deliveryId: string) => void;
  onResumeQueue: () => void;
  onActivateBrowserTab: (tabId: string) => void;
  onCloseBrowserTab: (tabId: string) => void;
  onStop: () => void;
}

interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
}

interface MediaPreview {
  attachment: AttachmentSummary;
  text: string | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [] };
const ONBOARDING_CHOICES = [
  "Work & projects",
  "Research & writing",
  "Sales & outreach",
  "Something else",
];

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <path d="m5 5 10 10M15 5 5 15" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="settings-back-icon fill-none stroke-current">
      <path d="m12.5 4-6 6 6 6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <path d="M10 4v12M4 10h12" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="file-icon fill-none stroke-current">
      <path d="M5 2.5h6l4 4V17.5H5z" stroke-width="1.2" stroke-linejoin="round" />
      <path d="M11 2.5v4h4M7.5 11h5M7.5 14h5" stroke-width="1.2" stroke-linecap="round" />
    </svg>
  );
}

function ComputerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <rect x="2.5" y="3" width="15" height="10" rx="1.5" stroke-width="1.3" />
      <path d="M7 17h6M10 13v4" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  );
}

function BrowserBackIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      class="browser-toolbar-icon fill-none stroke-current"
    >
      <path d="m12 4-6 6 6 6" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function BrowserForwardIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      class="browser-toolbar-icon fill-none stroke-current"
    >
      <path d="m8 4 6 6-6 6" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function BrowserReloadIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      class="browser-toolbar-icon fill-none stroke-current"
    >
      <path d="M15.5 7.5A6 6 0 1 0 16 11" stroke-width="1.3" stroke-linecap="round" />
      <path d="M15.5 4.5v3h-3" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function ChoiceCard(props: {
  title: string;
  hint?: string;
  choices: string[];
  pending?: boolean;
  onSubmit: (answer: string) => void;
}) {
  const [answer, setAnswer] = createSignal("");
  const submit = () => {
    const value = answer().trim();
    if (value && !props.pending) props.onSubmit(value);
  };
  return (
    <div class="choice-card">
      <div class="choice-card-heading">
        <div>
          <strong>{props.title}</strong>
          <span>{props.hint ?? "Pick whatever fits, or type your own."}</span>
        </div>
      </div>
      <div class="choice-options" role="listbox" aria-label={props.title}>
        <For each={props.choices}>
          {(choice, index) => (
            <button
              type="button"
              role="option"
              aria-selected={answer() === choice}
              class="choice-option"
              classList={{ "choice-option-selected": answer() === choice }}
              disabled={props.pending}
              onClick={() => {
                setAnswer(choice);
                props.onSubmit(choice);
              }}
            >
              <span class="choice-key">{String.fromCharCode(65 + index())}</span>
              <span>{choice}</span>
            </button>
          )}
        </For>
      </div>
      <input
        class="choice-input"
        value={answer()}
        placeholder="Type your own answer"
        aria-label="Custom answer"
        disabled={props.pending}
        onInput={(event) => setAnswer(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
    </div>
  );
}

function PromptCard(props: {
  questions: AgentPromptQuestion[];
  onSubmit: (answers: Record<string, string[]>) => Promise<boolean>;
}) {
  const [answers, setAnswers] = createSignal<Record<string, string>>({});
  const [submitting, setSubmitting] = createSignal(false);
  const submit = async () => {
    if (submitting()) return;
    const result = Object.fromEntries(
      props.questions.map((question) => [question.id, [answers()[question.id]?.trim() ?? ""]]),
    );
    if (Object.values(result).some((value) => !value[0])) return;
    setSubmitting(true);
    await props.onSubmit(result);
    setSubmitting(false);
  };
  return (
    <section class="prompt-card" aria-label="Agent question">
      <For each={props.questions}>
        {(question) => (
          <div class="prompt-question">
            <strong>{question.question}</strong>
            <Show when={question.options?.length}>
              <div class="choice-options">
                <For each={question.options ?? []}>
                  {(option) => (
                    <button
                      type="button"
                      class="choice-option"
                      classList={{
                        "choice-option-selected": answers()[question.id] === option.label,
                      }}
                      onClick={() =>
                        setAnswers((current) => ({ ...current, [question.id]: option.label }))
                      }
                    >
                      <span>{option.label}</span>
                      <small>{option.description}</small>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <input
              class="choice-input"
              type={question.isSecret ? "password" : "text"}
              value={answers()[question.id] ?? ""}
              placeholder="Type your answer"
              aria-label={question.header}
              onInput={(event) =>
                setAnswers((current) => ({ ...current, [question.id]: event.currentTarget.value }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </div>
        )}
      </For>
      <button
        type="button"
        class="prompt-submit"
        disabled={submitting()}
        onClick={() => void submit()}
      >
        {submitting() ? "Sending…" : "Send answer"}
      </button>
    </section>
  );
}

function AttachmentCards(props: {
  attachments: AttachmentSummary[];
  onPreview: (attachment: AttachmentSummary) => void;
  onAction: (attachment: AttachmentSummary, action: "open" | "reveal") => void;
}) {
  return (
    <div class="message-attachments">
      <For each={props.attachments}>
        {(attachment) => (
          <div class="message-attachment">
            <button
              type="button"
              class="attachment-preview-button"
              disabled={attachment.previewKind === "none"}
              aria-label={`Preview ${attachment.name}`}
              onClick={() => props.onPreview(attachment)}
            >
              <Show
                when={attachment.previewKind === "image"}
                fallback={<span class="file-type-badge">{fileBadge(attachment)}</span>}
              >
                <img src={attachment.previewUrl ?? ""} alt="" />
              </Show>
              <span>
                <strong>{attachment.name}</strong>
                <small>{formatFileSize(attachment.size)}</small>
              </span>
            </button>
            <div class="attachment-actions">
              <button type="button" onClick={() => props.onAction(attachment, "open")}>
                Open
              </button>
              <button type="button" onClick={() => props.onAction(attachment, "reveal")}>
                Finder
              </button>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

function ExchangeAgentAvatar(props: { bot: BotProfile | undefined }) {
  return (
    <span
      class={`bot-avatar exchange-agent-avatar bot-avatar-${props.bot?.accent ?? "neutral"}`}
      aria-hidden="true"
    >
      <GrokMark />
    </span>
  );
}

function ExchangeSystemRow(props: {
  message: BotMessage;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
}) {
  const [agentsOpen, setAgentsOpen] = createSignal(false);
  const exchange = () => props.message.exchange;
  const recipients = () => exchange()?.recipientBotIds ?? [];
  const sender = () => {
    const senderId = exchange()?.senderBotId;
    return props.bots.find((bot) => bot.id === senderId);
  };
  const agentCountLabel = () =>
    `${recipients().length} agent${recipients().length === 1 ? "" : "s"}`;

  return (
    <div class="exchange-system-row">
      <Show
        when={exchange()?.direction === "outgoing"}
        fallback={
          <>
            <span class="exchange-system-label">Message from</span>
            <button
              type="button"
              class="exchange-agent-trigger exchange-agent-trigger-incoming"
              aria-label={`Open exchange with ${sender()?.name ?? exchange()?.senderBotId ?? "agent"}`}
              onClick={() => {
                const senderId = exchange()?.senderBotId;
                if (senderId) props.onSelectAgent(senderId);
              }}
            >
              <ExchangeAgentAvatar bot={sender()} />
              <span>{sender()?.name ?? exchange()?.senderBotId ?? "Agent"}</span>
            </button>
          </>
        }
      >
        <span class="exchange-system-label">Messaged</span>
        <div class="exchange-agent-picker">
          <button
            type="button"
            class="exchange-agent-trigger"
            aria-haspopup="menu"
            aria-expanded={agentsOpen()}
            aria-label={`${agentCountLabel()}, show list`}
            onClick={() => setAgentsOpen((open) => !open)}
          >
            <span class="exchange-avatar-stack" aria-hidden="true">
              <For each={recipients().slice(0, 3)}>
                {(recipientId) => (
                  <ExchangeAgentAvatar bot={props.bots.find((bot) => bot.id === recipientId)} />
                )}
              </For>
            </span>
            <span>{agentCountLabel()}</span>
          </button>
          <Show when={agentsOpen()}>
            <div class="exchange-agent-menu" role="menu">
              <For each={recipients()}>
                {(recipientId) => {
                  const recipient = () => props.bots.find((bot) => bot.id === recipientId);
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      class="exchange-agent-menu-item"
                      onClick={() => {
                        setAgentsOpen(false);
                        props.onSelectAgent(recipientId);
                      }}
                    >
                      <ExchangeAgentAvatar bot={recipient()} />
                      <span>{recipient()?.name ?? recipientId}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>
      </Show>
      <time dateTime={props.message.time}>{props.message.time}</time>
    </div>
  );
}

function MessageBody(props: {
  message: BotMessage;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal") => void;
}) {
  return (
    <>
      <Show when={props.message.body}>
        <p class="message-copy">{props.message.body}</p>
      </Show>
      <Show when={props.message.replyToMessageId}>
        <small class="reply-reference">Reply to {props.message.replyToMessageId}</small>
      </Show>
      <Show when={props.message.status}>
        <div class="message-status">
          <span />
          {props.message.status}
        </div>
      </Show>
      <Show when={props.message.attachments?.length}>
        <AttachmentCards
          attachments={props.message.attachments ?? []}
          onPreview={props.onPreview}
          onAction={props.onAttachmentAction}
        />
      </Show>
    </>
  );
}

export function Conversation(props: ConversationProps) {
  const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({});
  const [showAttachments, setShowAttachments] = createSignal(false);
  const [attachmentBusy, setAttachmentBusy] = createSignal(false);
  const [composerError, setComposerError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [dropActive, setDropActive] = createSignal(false);
  const [screenOpen, setScreenOpen] = createSignal(false);
  const [browserDismissed, setBrowserDismissed] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [settingsName, setSettingsName] = createSignal("");
  const [settingsTitle, setSettingsTitle] = createSignal("");
  const [settingsDescription, setSettingsDescription] = createSignal("");
  const [settingsNotifications, setSettingsNotifications] = createSignal(true);
  const [browserAddress, setBrowserAddress] = createSignal("https://www.google.com");
  const [mediaPreview, setMediaPreview] = createSignal<MediaPreview | null>(null);
  const [pickerQuery, setPickerQuery] = createSignal("");
  const [activePickerOption, setActivePickerOption] = createSignal(0);
  const currentDraft = createMemo(() => {
    const id = props.bot?.id;
    return id ? (drafts()[id] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
  });
  const filteredPickerBots = createMemo(() => {
    const query = pickerQuery().trim().toLowerCase();
    return query
      ? props.bots.filter((bot) => `${bot.name} ${bot.role}`.toLowerCase().includes(query))
      : props.bots;
  });
  let scrollElement: HTMLDivElement | undefined;
  let browserSurface: HTMLDivElement | undefined;
  let browserResizeObserver: ResizeObserver | undefined;
  let pickerInput: HTMLInputElement | undefined;

  const updateCurrentDraft = (patch: Partial<ComposerDraft>) => {
    const id = props.bot?.id;
    if (!id) return;
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_DRAFT), ...patch } }));
  };

  onMount(() => {
    const unsubscribeImport = window.infeld.agent.onAttachmentImport((event) => {
      if (event.type === "started") {
        setAttachmentBusy(true);
        setComposerError(null);
      } else if (event.type === "error") {
        setAttachmentBusy(false);
        setComposerError(event.message);
      } else {
        setAttachmentBusy(false);
        addAttachments(event.attachments);
      }
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      hideBrowserPanel();
      setMediaPreview(null);
      setSettingsOpen(false);
      props.onCloseAgentPicker();
    };
    window.addEventListener("keydown", closeOnEscape);
    onCleanup(() => {
      unsubscribeImport();
      window.removeEventListener("keydown", closeOnEscape);
    });
  });

  createEffect(() => {
    props.messages.length;
    requestAnimationFrame(() => {
      if (scrollElement) scrollElement.scrollTop = scrollElement.scrollHeight;
    });
  });

  createEffect(() => {
    const bot = props.bot;
    if (!bot) return;
    setSettingsName(bot.name);
    setSettingsTitle(bot.role);
    setSettingsDescription(bot.description);
    setSettingsNotifications(bot.notifications);
  });

  createEffect(() => {
    const request = props.settingsRequest;
    if (!request || props.bot?.id !== request.botId) return;
    setScreenOpen(false);
    setSettingsOpen(true);
  });

  createEffect(() => {
    if (!props.agentPickerOpen) return;
    setPickerQuery("");
    setActivePickerOption(0);
    hideBrowserPanel();
    setSettingsOpen(false);
    requestAnimationFrame(() => pickerInput?.focus());
  });

  createEffect(() => {
    const activeTab = props.browserTabs.find((tab) => tab.id === props.activeBrowserTabId);
    if (activeTab) setBrowserAddress(activeTab.url);
    if (props.browserTabs.length > 0 && !browserDismissed()) {
      setScreenOpen(true);
    }
  });

  createEffect(() => {
    const visible = screenOpen();
    browserResizeObserver?.disconnect();
    if (!visible) {
      void window.infeld.browser.setVisible({ visible: false });
      return;
    }
    requestAnimationFrame(() => {
      if (!browserSurface) return;
      const syncBounds = () => {
        if (!browserSurface) return;
        const bounds = browserSurface.getBoundingClientRect();
        void window.infeld.browser.setVisible({
          visible: true,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        });
      };
      syncBounds();
      browserResizeObserver = new ResizeObserver(syncBounds);
      browserResizeObserver.observe(browserSurface);
    });
  });

  onCleanup(() => {
    browserResizeObserver?.disconnect();
    void window.infeld.browser.setVisible({ visible: false });
  });

  function addAttachments(selected: DraftAttachment[]) {
    const available = Math.max(0, 10 - currentDraft().attachments.length);
    const accepted = selected.slice(0, available);
    for (const attachment of selected.slice(available)) {
      void window.infeld.agent.discardDraftAttachment(attachment.id);
    }
    updateCurrentDraft({ attachments: [...currentDraft().attachments, ...accepted] });
    if (selected.length > accepted.length) setComposerError("You can attach at most 10 files.");
    setShowAttachments(false);
  }

  async function chooseAttachments() {
    if (attachmentBusy()) return;
    setAttachmentBusy(true);
    setComposerError(null);
    try {
      addAttachments(await window.infeld.agent.chooseAttachments());
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function submitMessage(override?: string) {
    const botId = props.bot?.id;
    const draft = currentDraft();
    const text = override ?? draft.text;
    const attachments = override ? [] : draft.attachments;
    if (!botId || submitting() || (!text.trim() && attachments.length === 0)) return;
    setSubmitting(true);
    setComposerError(null);
    const sent = await props.onSendMessage(
      text,
      attachments.map((item) => item.id),
    );
    setSubmitting(false);
    if (sent) setDrafts((current) => ({ ...current, [botId]: EMPTY_DRAFT }));
  }

  function removeAttachment(id: string) {
    updateCurrentDraft({
      attachments: currentDraft().attachments.filter((attachment) => attachment.id !== id),
    });
    void window.infeld.agent.discardDraftAttachment(id);
  }

  async function openBrowserAddress() {
    const value = browserAddress().trim();
    if (!value) return;
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const tab = await window.infeld.browser.open({
        url,
        ownerThreadId: props.bot?.threadId ?? null,
      });
      setBrowserAddress(tab.url);
      showBrowserPanel();
    } catch {
      setBrowserAddress(url);
    }
  }

  function showBrowserPanel() {
    setBrowserDismissed(false);
    setScreenOpen(true);
  }

  function hideBrowserPanel() {
    setBrowserDismissed(true);
    setScreenOpen(false);
    void window.infeld.browser.setVisible({ visible: false });
  }

  async function previewAttachment(attachment: AttachmentSummary) {
    if (!attachment.previewUrl || attachment.previewKind === "none") return;
    setMediaPreview({
      attachment,
      text: null,
      loading: attachment.previewKind === "text",
      error: null,
    });
    if (attachment.previewKind !== "text") return;
    try {
      const response = await fetch(attachment.previewUrl);
      if (!response.ok) throw new Error("Preview is unavailable.");
      const text = await response.text();
      setMediaPreview((current) =>
        current?.attachment.id === attachment.id
          ? { ...current, text: text.slice(0, 1_000_000), loading: false }
          : current,
      );
    } catch (error) {
      setMediaPreview((current) =>
        current?.attachment.id === attachment.id
          ? {
              ...current,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }

  function attachmentAction(attachment: AttachmentSummary, action: "open" | "reveal") {
    void window.infeld.agent
      .openAttachment({ attachmentId: attachment.id, action })
      .catch((error) => setComposerError(error instanceof Error ? error.message : String(error)));
  }

  function handlePickerKeyDown(event: KeyboardEvent) {
    const optionCount = filteredPickerBots().length + 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActivePickerOption((current) => (current + 1) % optionCount);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActivePickerOption((current) => (current - 1 + optionCount) % optionCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const bot = filteredPickerBots()[activePickerOption() - 1];
      if (activePickerOption() === 0) props.onCreateAgent();
      else if (bot) props.onSelectAgent(bot.id);
    } else if (event.key === "Escape") props.onCloseAgentPicker();
  }

  return (
    <main
      aria-label="Conversation"
      class="conversation-panel"
      classList={{
        "conversation-drop-active": dropActive(),
        "browser-panel-active": screenOpen(),
      }}
      onDragEnter={(event) => {
        if (event.dataTransfer?.types.includes("Files")) setDropActive(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropActive(false);
      }}
    >
      <Show when={dropActive()}>
        <div class="attachment-drop-overlay">Drop files to attach</div>
      </Show>
      <header class="window-drag conversation-header">
        <Show
          when={props.agentPickerOpen}
          fallback={
            <>
              <Show when={props.bot}>
                {(bot) => (
                  <button
                    type="button"
                    class="conversation-title no-drag"
                    aria-label="View agent settings"
                    onClick={() => {
                      hideBrowserPanel();
                      setSettingsOpen(true);
                    }}
                  >
                    <span class={`bot-avatar bot-avatar-${bot().accent}`}>
                      <GrokMark />
                    </span>
                    <h1>{bot().name}</h1>
                  </button>
                )}
              </Show>
              <button
                type="button"
                class="computer-button no-drag"
                aria-label={screenOpen() ? "Hide computer" : "Open computer"}
                aria-expanded={screenOpen()}
                onClick={() => {
                  setSettingsOpen(false);
                  if (screenOpen()) hideBrowserPanel();
                  else showBrowserPanel();
                }}
              >
                <ComputerIcon />
              </button>
            </>
          }
        >
          <div class="agent-picker-root no-drag">
            <label class="agent-recipient-field">
              <span>To:</span>
              <input
                ref={(element) => (pickerInput = element)}
                role="combobox"
                aria-label="To:"
                aria-expanded="true"
                placeholder="Search or create agents"
                value={pickerQuery()}
                onInput={(event) => {
                  setPickerQuery(event.currentTarget.value);
                  setActivePickerOption(0);
                }}
                onKeyDown={handlePickerKeyDown}
              />
            </label>
            <div class="agent-picker-menu" role="listbox">
              <button
                type="button"
                role="option"
                aria-selected={activePickerOption() === 0}
                class="agent-picker-option agent-picker-create"
                disabled={props.creatingAgent}
                onClick={props.onCreateAgent}
              >
                <span class="agent-picker-plus">
                  <PlusIcon />
                </span>
                <span>{props.creatingAgent ? "Creating agent…" : "Create new agent"}</span>
              </button>
              <For each={filteredPickerBots()}>
                {(bot, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={activePickerOption() === index() + 1}
                    class="agent-picker-option"
                    onClick={() => props.onSelectAgent(bot.id)}
                  >
                    <span class={`bot-avatar bot-avatar-${bot.accent}`}>
                      <GrokMark />
                    </span>
                    <span>{bot.name}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </header>

      <div class="conversation-scroll" ref={(element) => (scrollElement = element)}>
        <Show when={!props.agentPickerOpen && props.loaded}>
          <Show when={props.messages.length > 0}>
            <div class="time-marker">
              <span>{props.messages[0]?.time ?? "now"}</span>
            </div>
          </Show>
          <Show when={props.messages.length === 0 && !props.activeTurnId}>
            <article class="message-entry message-entry-bot onboarding-message">
              <div class="bot-bubble">
                <p class="message-copy">Hey — good to meet you.</p>
              </div>
              <ChoiceCard
                title="What do you want me helping with most?"
                choices={ONBOARDING_CHOICES}
                pending={submitting()}
                onSubmit={(answer) => void submitMessage(answer)}
              />
            </article>
          </Show>
          <For each={props.messages}>
            {(message, index) => (
              <Show
                when={message.exchange}
                fallback={
                  <article
                    class="message-entry"
                    classList={{
                      "message-entry-user": message.author === "you",
                      "message-entry-bot": message.author === "bot",
                    }}
                    style={{ "animation-delay": `${Math.min(index() * 35, 350)}ms` }}
                  >
                    <div class={message.author === "you" ? "user-bubble" : "bot-bubble"}>
                      <MessageBody
                        message={message}
                        onPreview={(attachment) => void previewAttachment(attachment)}
                        onAttachmentAction={attachmentAction}
                      />
                    </div>
                  </article>
                }
              >
                {(exchange) => (
                  <article
                    class="exchange-message-entry"
                    style={{ "animation-delay": `${Math.min(index() * 35, 350)}ms` }}
                  >
                    <ExchangeSystemRow
                      message={message}
                      bots={props.bots}
                      onSelectAgent={props.onSelectAgent}
                    />
                    <Show when={exchange().direction === "incoming"}>
                      <div class="message-entry message-entry-bot exchange-agent-message">
                        <div class="bot-bubble">
                          <MessageBody
                            message={message}
                            onPreview={(attachment) => void previewAttachment(attachment)}
                            onAttachmentAction={attachmentAction}
                          />
                        </div>
                      </div>
                    </Show>
                  </article>
                )}
              </Show>
            )}
          </For>
          <Show when={props.prompt}>
            {(prompt) => (
              <PromptCard questions={prompt().questions} onSubmit={props.onAnswerPrompt} />
            )}
          </Show>
        </Show>
      </div>

      <div class="composer-wrap">
        <Show when={showAttachments()}>
          <div class="attachment-menu">
            <button
              type="button"
              disabled={attachmentBusy()}
              onClick={() => void chooseAttachments()}
            >
              <FileIcon />
              {attachmentBusy() ? "Importing…" : "Attach files"}
            </button>
            <span class="attachment-menu-hint">You can also drop files or paste an image</span>
          </div>
        </Show>
        <For each={currentDraft().attachments}>
          {(attachment) => (
            <div class="composer-attachment">
              <span class={attachment.kind === "file" ? "file-type-badge" : "attachment-thumb"}>
                <Show when={attachment.kind === "image"} fallback={fileBadge(attachment)}>
                  <img src={attachment.previewUrl ?? ""} alt="" />
                </Show>
              </span>
              <span>
                <strong>{attachment.name}</strong>
                <small>{formatFileSize(attachment.size)}</small>
              </span>
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => removeAttachment(attachment.id)}
              >
                <CloseIcon />
              </button>
            </div>
          )}
        </For>
        <Show when={composerError()}>
          <div class="composer-error" role="alert">
            {composerError()}
          </div>
        </Show>
        <Show
          when={
            props.queue?.paused || props.queue?.deliveries.some((item) => item.status === "queued")
          }
        >
          <div class="agent-queue-bar">
            <Show when={props.queue?.paused}>
              <button type="button" onClick={props.onResumeQueue}>
                Resume queue
              </button>
            </Show>
            <For each={props.queue?.deliveries.filter((item) => item.status === "queued") ?? []}>
              {(delivery) => (
                <span>
                  Queued #{delivery.position}
                  <button
                    type="button"
                    aria-label={`Cancel queued message ${delivery.position}`}
                    onClick={() => props.onCancelQueuedMessage(delivery.id)}
                  >
                    <CloseIcon />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
        <div class="composer">
          <button
            type="button"
            class="composer-button"
            aria-label="Attach a file"
            disabled={props.agentPickerOpen || attachmentBusy()}
            onClick={() => setShowAttachments((value) => !value)}
          >
            <PlusIcon />
          </button>
          <label class="composer-input-label">
            <span class="sr-only">Message {props.bot?.name}</span>
            <textarea
              rows="1"
              value={currentDraft().text}
              disabled={props.agentPickerOpen || submitting()}
              placeholder={`Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`}
              aria-label={`Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`}
              onInput={(event) => updateCurrentDraft({ text: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitMessage();
                }
              }}
            />
          </label>
          <Show
            when={props.activeTurnId}
            fallback={
              <button
                type="button"
                class="voice-button"
                aria-label="Send message"
                disabled={submitting()}
                onClick={() => void submitMessage()}
              >
                {submitting() ? "…" : "↑"}
              </button>
            }
          >
            <button
              type="button"
              class="voice-button voice-button-active"
              aria-label="Stop agent"
              onClick={props.onStop}
            >
              <CloseIcon />
            </button>
          </Show>
        </div>
      </div>

      <Show when={mediaPreview()}>
        {(preview) => (
          <div class="media-backdrop" role="presentation">
            <button
              type="button"
              class="media-dismiss"
              aria-label="Close media preview"
              onClick={() => setMediaPreview(null)}
            />
            <section
              class="media-modal"
              role="dialog"
              aria-modal="true"
              aria-label={preview().attachment.name}
            >
              <button
                type="button"
                class="media-close"
                aria-label="Close media preview"
                onClick={() => setMediaPreview(null)}
              >
                <CloseIcon />
              </button>
              <Show when={preview().attachment.previewKind === "image"}>
                <img
                  class="media-image"
                  src={preview().attachment.previewUrl ?? ""}
                  alt={preview().attachment.name}
                />
              </Show>
              <Show when={preview().attachment.previewKind === "pdf"}>
                <iframe
                  class="media-document"
                  title={preview().attachment.name}
                  src={preview().attachment.previewUrl ?? ""}
                />
              </Show>
              <Show when={preview().attachment.previewKind === "text"}>
                <pre class="media-text">
                  {preview().loading ? "Loading…" : (preview().error ?? preview().text)}
                </pre>
              </Show>
              <div class="media-caption">
                <span>{preview().attachment.name}</span>
                <button
                  type="button"
                  onClick={() => attachmentAction(preview().attachment, "open")}
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => attachmentAction(preview().attachment, "reveal")}
                >
                  Show in Finder
                </button>
              </div>
            </section>
          </div>
        )}
      </Show>

      <Show when={screenOpen()}>
        <aside class="browser-panel" aria-label="Browser">
          <header class="browser-panel-header">
            <div class="browser-tabs" role="tablist" aria-label="Browser tabs">
              <For each={props.browserTabs}>
                {(tab) => (
                  <div class="browser-tab-wrap">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={props.activeBrowserTabId === tab.id}
                      class="browser-tab"
                      classList={{ "browser-tab-active": props.activeBrowserTabId === tab.id }}
                      onClick={() => props.onActivateBrowserTab(tab.id)}
                    >
                      <span>{tab.loading ? "Loading…" : tab.title || tab.url}</span>
                    </button>
                    <button
                      type="button"
                      class="browser-tab-close"
                      aria-label={`Close ${tab.title || "browser tab"}`}
                      onClick={() => props.onCloseBrowserTab(tab.id)}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                )}
              </For>
              <button
                type="button"
                class="browser-new-tab"
                aria-label="New browser tab"
                onClick={() => {
                  setBrowserAddress("https://www.google.com");
                  void openBrowserAddress();
                }}
              >
                <PlusIcon />
              </button>
            </div>
            <button
              type="button"
              class="browser-panel-close"
              aria-label="Hide browser panel"
              onClick={hideBrowserPanel}
            >
              <CloseIcon />
            </button>
          </header>
          <div class="browser-toolbar">
            <button type="button" aria-label="Go back" class="browser-toolbar-button" disabled>
              <BrowserBackIcon />
            </button>
            <button type="button" aria-label="Go forward" class="browser-toolbar-button" disabled>
              <BrowserForwardIcon />
            </button>
            <button
              type="button"
              aria-label="Reload page"
              class="browser-toolbar-button"
              onClick={() => void openBrowserAddress()}
            >
              <BrowserReloadIcon />
            </button>
            <form
              class="browser-address-bar"
              onSubmit={(event) => {
                event.preventDefault();
                void openBrowserAddress();
              }}
            >
              <input
                value={browserAddress()}
                aria-label="Browser address"
                onInput={(event) => setBrowserAddress(event.currentTarget.value)}
              />
            </form>
            <button type="button" class="browser-toolbar-button" aria-label="Browser menu">
              <span class="browser-menu-dots">•••</span>
            </button>
          </div>
          <div class="browser-surface" ref={(element) => (browserSurface = element)}>
            <Show when={props.browserTabs.length === 0}>
              <div class="browser-empty-state">
                <strong>Open a page</strong>
                <span>The agent can browse here while it works.</span>
              </div>
            </Show>
          </div>
        </aside>
      </Show>

      <Show when={settingsOpen() && props.bot}>
        <aside class="agent-settings-panel" aria-label="Agent settings">
          <header class="agent-settings-header">
            <button
              type="button"
              class="agent-settings-nav-button"
              aria-label="Back to details"
              onClick={() => setSettingsOpen(false)}
            >
              <BackIcon />
            </button>
            <h2>Settings</h2>
            <button
              type="button"
              class="agent-settings-nav-button"
              aria-label="Close details"
              onClick={() => setSettingsOpen(false)}
            >
              <CloseIcon />
            </button>
          </header>
          <div class="agent-settings-content">
            <button type="button" class="agent-settings-avatar" aria-label="Edit agent avatar">
              <span class={`bot-avatar bot-avatar-${props.bot?.accent ?? "neutral"}`}>
                <GrokMark />
              </span>
            </button>
            <label class="agent-settings-field">
              <span>Name</span>
              <input
                value={settingsName()}
                aria-label="Agent name"
                onInput={(event) => setSettingsName(event.currentTarget.value)}
                onBlur={() =>
                  void props.onUpdateBot(props.bot?.id ?? "", {
                    name: settingsName().trim() || "New agent",
                  })
                }
              />
            </label>
            <label class="agent-settings-field">
              <span>Title</span>
              <input
                value={settingsTitle()}
                aria-label="Agent title"
                placeholder="Describe what your agent does"
                onInput={(event) => setSettingsTitle(event.currentTarget.value)}
                onBlur={() =>
                  void props.onUpdateBot(props.bot?.id ?? "", { role: settingsTitle().trim() })
                }
              />
            </label>
            <label class="agent-settings-field agent-settings-description">
              <span>Description</span>
              <textarea
                rows="4"
                value={settingsDescription()}
                aria-label="Agent description"
                placeholder="What this agent is for"
                onInput={(event) => setSettingsDescription(event.currentTarget.value)}
                onBlur={() =>
                  void props.onUpdateBot(props.bot?.id ?? "", {
                    description: settingsDescription(),
                  })
                }
              />
            </label>
            <div class="agent-settings-notifications">
              <div>
                <strong>Notifications</strong>
                <span>Get notified when this agent finishes or needs input</span>
              </div>
              <button
                type="button"
                role="switch"
                class="settings-switch"
                classList={{ "settings-switch-on": settingsNotifications() }}
                aria-label="Notifications"
                aria-checked={settingsNotifications()}
                onClick={() => {
                  const next = !settingsNotifications();
                  setSettingsNotifications(next);
                  void props.onUpdateBot(props.bot?.id ?? "", { notifications: next });
                }}
              >
                <span />
              </button>
            </div>
          </div>
        </aside>
      </Show>
    </main>
  );
}

function fileBadge(attachment: AttachmentSummary): string {
  if (attachment.previewKind === "pdf") return "PDF";
  if (attachment.previewKind === "text") return "TXT";
  return attachment.name.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
