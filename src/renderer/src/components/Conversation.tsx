import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  AgentEvent,
  AgentPromptQuestion,
  AttachmentSummary,
  BotAvatarColor,
  BotAvatarShape,
  BrowserControlAction,
  BrowserControlState,
  BrowserTab,
  DraftAttachment,
  QueueSnapshot,
  UpdateBotInput,
} from "../../../shared/ipc";
import type { BotMessage, BotProfile } from "../data";
import { AVATAR_COLORS, AVATAR_SHAPES } from "../data";
import { AgentAvatar } from "./AgentAvatar";
import { ComposerEditor, expandComposerMentions } from "./ComposerEditor";
import { PanelResizer, readPanelWidth, savePanelWidth } from "./PanelResizer";
import { SidebarToggleIcon } from "./Sidebar";

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
  browserControlState: BrowserControlState;
  leftSidebarCollapsed: boolean;
  prompt: Extract<AgentEvent, { type: "prompt" }> | undefined;
  onCloseAgentPicker: () => void;
  onCreateAgent: () => void;
  onSelectAgent: (botId: string) => void;
  onUpdateBot: (botId: string, updates: Omit<UpdateBotInput, "botId">) => Promise<void>;
  onSendMessage: (body: string, attachmentDraftIds: string[]) => Promise<boolean>;
  onCompleteOnboarding: (answer: string) => Promise<boolean>;
  onAnswerPrompt: (answers: Record<string, string[]>) => Promise<boolean>;
  onCancelQueuedMessage: (deliveryId: string) => void;
  onResumeQueue: () => void;
  onActivateBrowserTab: (tabId: string) => void;
  onCloseBrowserTab: (tabId: string) => void;
  onToggleLeftSidebar: () => void;
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
const SETTINGS_PANEL_STORAGE_KEY = "infeld:settings-panel-width";
const SETTINGS_PANEL_DEFAULT = 296;
const SETTINGS_PANEL_MIN = 260;
const SETTINGS_PANEL_MAX = 520;
const BROWSER_PANEL_STORAGE_KEY = "infeld:browser-panel-width";
const BROWSER_PANEL_DEFAULT = 380;
const BROWSER_PANEL_MIN = 300;
const BROWSER_PANEL_MAX = 680;

const BROWSER_ACTION_LABELS: Record<BrowserControlAction, string> = {
  open: "Opening a page…",
  "list-tabs": "Checking tabs…",
  snapshot: "Reading the page…",
  click: "Clicking…",
  type: "Typing…",
  key: "Using the keyboard…",
  scroll: "Scrolling…",
  back: "Going back…",
  forward: "Going forward…",
  reload: "Reloading…",
  screenshot: "Taking a screenshot…",
  "close-tab": "Closing a tab…",
};

const AVATAR_COLOR_LABELS: Record<BotAvatarColor, string> = {
  black: "Black",
  brown: "Brown",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  cyan: "Cyan",
  blue: "Blue",
  violet: "Violet",
  magenta: "Magenta",
  gray: "Gray",
};

const AVATAR_SHAPE_LABELS: Record<BotAvatarShape, string> = {
  blob: "blob",
  pebble: "pebble",
  squircle: "squircle",
  tablet: "tablet",
  wedge: "wedge",
  hex: "hex",
  cloud: "cloud",
  teardrop: "teardrop",
};

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <path d="m5 5 10 10M15 5 5 15" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-current">
      <rect x="6" y="6" width="8" height="8" rx="1.5" />
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

function BrowserControlIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" class="browser-tab-control-icon">
      <path d="M3.25 2.5 11 8.2 7.55 9.3l-1.5 3.45z" />
      <circle cx="11.75" cy="3.75" r="1.45" />
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
  customChoice?: string;
  pending?: boolean;
  onSubmit: (answer: string) => Promise<boolean>;
}) {
  const [answer, setAnswer] = createSignal("");
  const [customSelected, setCustomSelected] = createSignal(false);
  let customInput: HTMLInputElement | undefined;
  const submit = async () => {
    const value = answer().trim();
    if (value && !props.pending) await props.onSubmit(value);
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
              aria-selected={choice === props.customChoice ? customSelected() : answer() === choice}
              class="choice-option"
              classList={{
                "choice-option-selected":
                  choice === props.customChoice ? customSelected() : answer() === choice,
              }}
              disabled={props.pending}
              onClick={() => {
                if (choice === props.customChoice) {
                  setAnswer("");
                  setCustomSelected(true);
                  customInput?.focus();
                  return;
                }
                setCustomSelected(false);
                setAnswer(choice);
                void props.onSubmit(choice);
              }}
            >
              <span class="choice-key">{String.fromCharCode(65 + index())}</span>
              <span>{choice}</span>
            </button>
          )}
        </For>
      </div>
      <input
        ref={(element) => (customInput = element)}
        class="choice-input"
        value={answer()}
        placeholder="Type your own answer"
        aria-label="Custom answer"
        disabled={props.pending}
        onInput={(event) => {
          setCustomSelected(true);
          setAnswer(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
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
  return <AgentAvatar bot={props.bot} class="exchange-agent-avatar" />;
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
  const singleRecipient = () => {
    const recipientId = recipients()[0];
    return recipientId ? props.bots.find((bot) => bot.id === recipientId) : undefined;
  };
  const agentCountLabel = () => `${recipients().length} agents`;

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
        <Show
          when={recipients().length === 1}
          fallback={
            <div class="exchange-agent-picker">
              <button
                type="button"
                class="exchange-agent-trigger exchange-agent-trigger-outgoing"
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
          }
        >
          <button
            type="button"
            class="exchange-agent-trigger exchange-agent-trigger-single"
            aria-label={`Open exchange with ${singleRecipient()?.name ?? recipients()[0] ?? "agent"}`}
            title={singleRecipient()?.name ?? recipients()[0] ?? "Agent"}
            onClick={() => {
              const recipientId = recipients()[0];
              if (recipientId) props.onSelectAgent(recipientId);
            }}
          >
            <ExchangeAgentAvatar bot={singleRecipient()} />
            <span>{singleRecipient()?.name ?? recipients()[0] ?? "Agent"}</span>
          </button>
        </Show>
      </Show>
      <time dateTime={props.message.time}>{props.message.time}</time>
    </div>
  );
}

function MessageBody(props: {
  message: BotMessage;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal") => void;
}) {
  return (
    <>
      <Show when={props.message.body}>
        <p class="message-copy">
          <TaggedMessageText
            body={props.message.body}
            bots={props.bots}
            onSelectAgent={props.onSelectAgent}
          />
        </p>
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

function TaggedMessageText(props: {
  body: string;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
}) {
  const parts = createMemo(() => taggedMessageParts(props.body, props.bots));
  return (
    <For each={parts()}>
      {(part) => (
        <Show when={part.bot} fallback={part.text}>
          {(bot) => (
            <button
              type="button"
              class="message-agent-tag"
              aria-label={`Open agent ${bot().name}`}
              onClick={() => props.onSelectAgent(bot().id)}
            >
              <AgentAvatar bot={bot()} />
              <span>{bot().name}</span>
            </button>
          )}
        </Show>
      )}
    </For>
  );
}

function taggedMessageParts(body: string, bots: BotProfile[]) {
  const orderedBots = [...bots].sort((left, right) => right.name.length - left.name.length);
  if (orderedBots.length === 0) return [{ text: body, bot: undefined }];
  const botsByName = new Map(orderedBots.map((bot) => [bot.name.toLocaleLowerCase(), bot]));
  const expression = new RegExp(
    `@(${orderedBots.map((bot) => escapeExpression(bot.name)).join("|")})(?=$|[\\s.,!?;:()\\[\\]{}])`,
    "giu",
  );
  const parts: Array<{ text: string; bot: BotProfile | undefined }> = [];
  let cursor = 0;
  for (const match of body.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: body.slice(cursor, index), bot: undefined });
    const name = match[1] ?? "";
    const bot = botsByName.get(name.toLocaleLowerCase());
    parts.push({ text: match[0], bot });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor), bot: undefined });
  return parts.length > 0 ? parts : [{ text: body, bot: undefined }];
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function AgentActivityIndicator(props: {
  bot: BotProfile | undefined;
  state: "Queued" | "Working";
}) {
  return (
    <div
      class="agent-activity-entry"
      role="status"
      aria-label={`${props.bot?.name ?? "Agent"} is ${props.state.toLowerCase()}`}
    >
      <AgentAvatar bot={props.bot} class="agent-activity-avatar" />
      <div class="agent-activity-bubble" aria-hidden="true">
        <span>{props.state}</span>
        <span class="agent-activity-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
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
  const [avatarPickerOpen, setAvatarPickerOpen] = createSignal(false);
  const [avatarShape, setAvatarShape] = createSignal<BotAvatarShape>("blob");
  const [avatarColor, setAvatarColor] = createSignal<BotAvatarColor>("orange");
  const [browserAddress, setBrowserAddress] = createSignal("https://www.google.com");
  const [mediaPreview, setMediaPreview] = createSignal<MediaPreview | null>(null);
  const [pickerQuery, setPickerQuery] = createSignal("");
  const [activePickerOption, setActivePickerOption] = createSignal(0);
  const [settingsPanelWidth, setSettingsPanelWidth] = createSignal(
    readPanelWidth(
      SETTINGS_PANEL_STORAGE_KEY,
      SETTINGS_PANEL_DEFAULT,
      SETTINGS_PANEL_MIN,
      SETTINGS_PANEL_MAX,
    ),
  );
  const [browserPanelWidth, setBrowserPanelWidth] = createSignal(
    readPanelWidth(
      BROWSER_PANEL_STORAGE_KEY,
      BROWSER_PANEL_DEFAULT,
      BROWSER_PANEL_MIN,
      BROWSER_PANEL_MAX,
    ),
  );
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
  const activeBrowserControl = createMemo(() => {
    const sessions = props.browserControlState.sessions;
    const activeTab = props.browserTabs.find((tab) => tab.id === props.activeBrowserTabId);
    const forActiveTab = activeTab?.ownerThreadId
      ? sessions.filter((session) => session.threadId === activeTab.ownerThreadId)
      : [];
    const candidates = forActiveTab.length > 0 ? forActiveTab : sessions;
    return (
      [...candidates]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .find((session) => session.phase === "acting") ?? candidates.at(-1)
    );
  });
  const browserControlBot = createMemo(() => {
    const control = activeBrowserControl();
    return control ? props.bots.find((bot) => bot.threadId === control.threadId) : undefined;
  });
  const browserControlForTab = (tab: BrowserTab) => {
    const sessions = props.browserControlState.sessions;
    return (
      sessions.find((session) => session.tabId === tab.id) ??
      sessions.find(
        (session) =>
          session.tabId === null &&
          tab.id === props.activeBrowserTabId &&
          session.threadId === tab.ownerThreadId,
      )
    );
  };
  const browserControllerForTab = (tab: BrowserTab) => {
    const control = browserControlForTab(tab);
    return control ? props.bots.find((bot) => bot.threadId === control.threadId) : undefined;
  };
  const agentActivity = createMemo<"Queued" | "Working" | null>(() => {
    if (
      props.activeTurnId ||
      props.queue?.deliveries.some(
        (delivery) => delivery.status === "starting" || delivery.status === "running",
      )
    ) {
      return "Working";
    }
    if (
      !props.queue?.paused &&
      props.queue?.deliveries.some((delivery) => delivery.status === "queued")
    ) {
      return "Queued";
    }
    return null;
  });
  const seenMessageIds = new Set<string>();
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  let scrollElement: HTMLDivElement | undefined;
  let conversationPanel: HTMLElement | undefined;
  let browserSurface: HTMLDivElement | undefined;
  let browserResizeObserver: ResizeObserver | undefined;
  let pickerInput: HTMLInputElement | undefined;
  let stickToLatest = true;
  let lastConversationBotId: string | undefined;

  function updateScrollFade(element = scrollElement) {
    if (!element) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFadeAtTop(element.scrollTop > 2);
    setFadeAtBottom(remaining > 2);
  }

  const markMessageSeen = (messageId: string): boolean => {
    const key = `${props.bot?.id ?? "none"}:${messageId}`;
    if (seenMessageIds.has(key)) return false;
    seenMessageIds.add(key);
    return true;
  };

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
      setAvatarPickerOpen(false);
      props.onCloseAgentPicker();
    };
    window.addEventListener("keydown", closeOnEscape);
    const scrollResizeObserver = new ResizeObserver(() => updateScrollFade());
    if (scrollElement) scrollResizeObserver.observe(scrollElement);
    requestAnimationFrame(() => updateScrollFade());
    onCleanup(() => {
      scrollResizeObserver.disconnect();
      unsubscribeImport();
      window.removeEventListener("keydown", closeOnEscape);
    });
  });

  createEffect(() => {
    const botId = props.bot?.id;
    const lastMessage = props.messages[props.messages.length - 1];
    props.activeTurnId;
    props.queue?.deliveries.map((delivery) => `${delivery.id}:${delivery.status}`).join("|");
    lastMessage?.body;
    lastMessage?.status;
    lastMessage?.exchange?.deliveries
      .map((delivery) => `${delivery.id}:${delivery.status}:${delivery.position}`)
      .join("|");
    props.loaded;
    props.agentPickerOpen;
    props.prompt;
    if (botId !== lastConversationBotId) {
      lastConversationBotId = botId;
      stickToLatest = true;
    }
    requestAnimationFrame(() => {
      if (!scrollElement) return;
      if (stickToLatest) scrollElement.scrollTop = scrollElement.scrollHeight;
      updateScrollFade(scrollElement);
    });
  });

  createEffect(() => {
    const bot = props.bot;
    if (!bot) return;
    setSettingsName(bot.name);
    setSettingsTitle(bot.role);
    setSettingsDescription(bot.description);
    setSettingsNotifications(bot.notifications);
    setAvatarShape(bot.avatarShape);
    setAvatarColor(bot.avatarColor);
    setAvatarPickerOpen(false);
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
    const text = override ?? expandComposerMentions(draft.text);
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
      ref={(element) => (conversationPanel = element)}
      aria-label="Conversation"
      class="conversation-panel"
      classList={{
        "conversation-drop-active": dropActive(),
        "browser-panel-active": screenOpen(),
      }}
      style={`--settings-panel-width: ${settingsPanelWidth()}px; --browser-panel-width: ${browserPanelWidth()}px`}
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
        <Show when={props.leftSidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label="Show sidebar"
            aria-controls="bot-sidebar"
            aria-expanded="false"
            title="Show sidebar"
            onClick={props.onToggleLeftSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
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
                    <AgentAvatar bot={bot()} />
                    <h1>{bot().name}</h1>
                  </button>
                )}
              </Show>
              <button
                type="button"
                class="header-panel-toggle computer-button no-drag"
                classList={{ "computer-button-agent-active": Boolean(activeBrowserControl()) }}
                aria-label={
                  activeBrowserControl()
                    ? `${browserControlBot()?.name ?? "Agent"} is controlling the browser`
                    : screenOpen()
                      ? "Hide computer"
                      : "Open computer"
                }
                aria-expanded={screenOpen()}
                onClick={() => {
                  setSettingsOpen(false);
                  if (screenOpen()) hideBrowserPanel();
                  else showBrowserPanel();
                }}
              >
                <ComputerIcon />
                <Show when={activeBrowserControl()}>
                  <span class="computer-control-dot" aria-hidden="true" />
                </Show>
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
                    <AgentAvatar bot={bot} />
                    <span>{bot.name}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </header>

      <div
        class="conversation-scroll"
        classList={{
          "scroll-fade-top": fadeAtTop(),
          "scroll-fade-bottom": fadeAtBottom(),
        }}
        ref={(element) => (scrollElement = element)}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
          updateScrollFade(element);
        }}
      >
        <Show when={!props.agentPickerOpen && props.loaded}>
          <Show when={props.messages.length > 0}>
            <div class="time-marker">
              <span>{props.messages[0]?.time ?? "now"}</span>
            </div>
          </Show>
          <Show when={props.messages.length === 0 && !props.activeTurnId}>
            <article class="message-entry message-entry-animated message-entry-bot onboarding-message">
              <div class="bot-bubble">
                <p class="message-copy">Hey — good to meet you.</p>
              </div>
              <ChoiceCard
                title="What do you want me helping with most?"
                hint="This becomes my ongoing specialty. You can change it later in Settings."
                choices={ONBOARDING_CHOICES}
                customChoice="Something else"
                pending={submitting()}
                onSubmit={async (answer) => {
                  if (submitting()) return false;
                  setSubmitting(true);
                  setComposerError(null);
                  const completed = await props.onCompleteOnboarding(answer);
                  setSubmitting(false);
                  return completed;
                }}
              />
            </article>
          </Show>
          <For each={props.messages}>
            {(message, index) => {
              const animateEntrance = markMessageSeen(message.id);
              return (
                <Show
                  when={message.exchange}
                  fallback={
                    <article
                      class="message-entry"
                      classList={{
                        "message-entry-animated": animateEntrance,
                        "message-entry-user": message.author === "you",
                        "message-entry-bot": message.author === "bot",
                      }}
                      style={{ "animation-delay": `${Math.min(index() * 35, 350)}ms` }}
                    >
                      <div
                        class={message.author === "you" ? "user-bubble" : "bot-bubble"}
                        classList={{ "bot-bubble-streaming": message.streaming === true }}
                      >
                        <MessageBody
                          message={message}
                          bots={props.bots}
                          onSelectAgent={props.onSelectAgent}
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
                      classList={{ "exchange-message-entry-animated": animateEntrance }}
                      style={{ "animation-delay": `${Math.min(index() * 35, 350)}ms` }}
                    >
                      <ExchangeSystemRow
                        message={message}
                        bots={props.bots}
                        onSelectAgent={props.onSelectAgent}
                      />
                      <Show
                        when={
                          exchange().direction === "incoming" &&
                          (message.attachments?.length ?? 0) > 0
                        }
                      >
                        <div class="exchange-agent-attachments">
                          <AttachmentCards
                            attachments={message.attachments ?? []}
                            onPreview={(attachment) => void previewAttachment(attachment)}
                            onAction={attachmentAction}
                          />
                        </div>
                      </Show>
                    </article>
                  )}
                </Show>
              );
            }}
          </For>
          <Show when={agentActivity()}>
            {(state) => <AgentActivityIndicator bot={props.bot} state={state()} />}
          </Show>
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
          <div class="composer-input-label">
            <ComposerEditor
              botId={props.bot?.id}
              bots={props.bots}
              value={currentDraft().text}
              disabled={props.agentPickerOpen || submitting()}
              placeholder={`Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`}
              ariaLabel={`Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`}
              onValueChange={(text) => updateCurrentDraft({ text })}
              onSubmit={() => void submitMessage()}
            />
          </div>
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
              <StopIcon />
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
        <aside
          id="browser-side-panel"
          class="browser-panel"
          classList={{ "browser-panel-controlled": Boolean(activeBrowserControl()) }}
          aria-label="Browser"
        >
          <PanelResizer
            class="right-panel-resizer"
            label="Resize right panel"
            controls="browser-side-panel"
            direction="right"
            value={browserPanelWidth()}
            defaultValue={BROWSER_PANEL_DEFAULT}
            min={BROWSER_PANEL_MIN}
            max={() =>
              Math.min(
                BROWSER_PANEL_MAX,
                Math.max(
                  BROWSER_PANEL_MIN,
                  (conversationPanel?.clientWidth || window.innerWidth) - 300,
                ),
              )
            }
            onResize={setBrowserPanelWidth}
            onResizeEnd={(value) => savePanelWidth(BROWSER_PANEL_STORAGE_KEY, value)}
          />
          <header class="browser-panel-header">
            <div class="browser-tabs">
              <div class="browser-tab-strip" role="tablist" aria-label="Browser tabs">
                <For each={props.browserTabs}>
                  {(tab) => {
                    const control = () => browserControlForTab(tab);
                    const controller = () => browserControllerForTab(tab);
                    const title = () => (tab.loading ? "Loading…" : tab.title || tab.url);
                    return (
                      <div
                        class="browser-tab-wrap"
                        classList={{ "browser-tab-controlled": Boolean(control()) }}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-label={
                            control()
                              ? `${title()}, controlled by ${controller()?.name ?? "agent"}`
                              : title()
                          }
                          aria-selected={props.activeBrowserTabId === tab.id}
                          class="browser-tab"
                          classList={{
                            "browser-tab-active": props.activeBrowserTabId === tab.id,
                          }}
                          onClick={() => props.onActivateBrowserTab(tab.id)}
                        >
                          <Show when={control()}>
                            {(session) => (
                              <span
                                class="browser-tab-control"
                                classList={{
                                  "browser-tab-control-acting": session().phase === "acting",
                                }}
                                title={`${controller()?.name ?? "Agent"}: ${BROWSER_ACTION_LABELS[session().action]}`}
                              >
                                <BrowserControlIcon />
                              </span>
                            )}
                          </Show>
                          <span class="browser-tab-title">{title()}</span>
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
                    );
                  }}
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
            </div>
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
        <aside id="settings-side-panel" class="agent-settings-panel" aria-label="Agent settings">
          <PanelResizer
            class="right-panel-resizer"
            label="Resize right panel"
            controls="settings-side-panel"
            direction="right"
            value={settingsPanelWidth()}
            defaultValue={SETTINGS_PANEL_DEFAULT}
            min={SETTINGS_PANEL_MIN}
            max={() =>
              Math.min(
                SETTINGS_PANEL_MAX,
                Math.max(
                  SETTINGS_PANEL_MIN,
                  (conversationPanel?.clientWidth || window.innerWidth) - 300,
                ),
              )
            }
            onResize={setSettingsPanelWidth}
            onResizeEnd={(value) => savePanelWidth(SETTINGS_PANEL_STORAGE_KEY, value)}
          />
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
            <button
              type="button"
              class="agent-settings-avatar"
              aria-label="Edit agent avatar"
              aria-expanded={avatarPickerOpen()}
              onClick={() => setAvatarPickerOpen((open) => !open)}
            >
              <AgentAvatar shape={avatarShape()} color={avatarColor()} bot={props.bot} />
            </button>
            <Show when={avatarPickerOpen()}>
              <section class="avatar-editor" aria-label="Avatar editor">
                <fieldset class="avatar-shape-grid" aria-label="Character shape">
                  <For each={AVATAR_SHAPES}>
                    {(shape) => (
                      <button
                        type="button"
                        class="avatar-shape-choice"
                        classList={{ "avatar-choice-selected": avatarShape() === shape }}
                        aria-label={`${AVATAR_SHAPE_LABELS[shape]} character shape`}
                        aria-pressed={avatarShape() === shape}
                        onClick={() => {
                          setAvatarShape(shape);
                          if (props.bot)
                            void props.onUpdateBot(props.bot.id, { avatarShape: shape });
                        }}
                      >
                        <AgentAvatar shape={shape} color={avatarColor()} bot={props.bot} />
                      </button>
                    )}
                  </For>
                </fieldset>
                <div class="avatar-editor-divider" />
                <fieldset class="avatar-color-grid" aria-label="Character color">
                  <For each={AVATAR_COLORS}>
                    {(color) => (
                      <button
                        type="button"
                        class="avatar-color-choice"
                        classList={{ "avatar-choice-selected": avatarColor() === color }}
                        aria-label={`${AVATAR_COLOR_LABELS[color]} character color`}
                        aria-pressed={avatarColor() === color}
                        onClick={() => {
                          setAvatarColor(color);
                          if (props.bot)
                            void props.onUpdateBot(props.bot.id, { avatarColor: color });
                        }}
                      >
                        <span class={`avatar-color-swatch avatar-color-swatch-${color}`} />
                      </button>
                    )}
                  </For>
                </fieldset>
              </section>
            </Show>
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
