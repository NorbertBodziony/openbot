import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  AgentEvent,
  AgentModelId,
  AgentModelOption,
  AgentReasoningEffort,
  AgentStatus,
  AttachmentSummary,
  BotAvatarColor,
  BotAvatarShape,
  BrowserControlAction,
  BrowserControlState,
  BrowserTab,
  DraftAttachment,
  MessageReaction,
  QueueSnapshot,
  UpdateBotInput,
} from "../../../shared/ipc";
import { MESSAGE_REACTIONS, MORE_MESSAGE_REACTIONS } from "../../../shared/ipc";
import type { BotMessage, BotProfile } from "../data";
import { AVATAR_COLORS, AVATAR_SHAPES } from "../data";
import { AgentAvatar } from "./AgentAvatar";
import { ComposerEditor, expandComposerMentions } from "./ComposerEditor";
import { ChoiceCard, PromptCard } from "./ConversationPrompts";
import { PanelResizer, readPanelWidth, savePanelWidth } from "./PanelResizer";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { SidebarToggleIcon } from "./Sidebar";

interface ConversationProps {
  agentStatus: AgentStatus;
  bot: BotProfile | undefined;
  bots: BotProfile[];
  modelOptions: AgentModelOption[];
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
  onSendMessage: (
    body: string,
    attachmentDraftIds: string[],
    replyToMessageId: string | null,
  ) => Promise<boolean>;
  onCompleteOnboarding: (
    answer: string,
    model: AgentModelId,
    reasoningEffort: AgentReasoningEffort,
  ) => Promise<boolean>;
  onAnswerPrompt: (answers: Record<string, string[]>) => Promise<boolean>;
  onCancelQueuedMessage: (deliveryId: string) => void;
  onResumeQueue: () => void;
  onActivateBrowserTab: (tabId: string) => void;
  onCloseBrowserTab: (tabId: string) => void;
  onToggleLeftSidebar: () => void;
  onOpenAgentSetup: () => Promise<void>;
  onStop: () => void;
}

interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
  replyToMessageId: string | null;
}

interface MediaPreview {
  attachment: AttachmentSummary;
  text: string | null;
  loading: boolean;
  error: string | null;
}

type RightPanelMode = "none" | "browser" | "settings";

const EMPTY_DRAFT: ComposerDraft = { text: "", attachments: [], replyToMessageId: null };
const ONBOARDING_CHOICES = [
  "Work & projects",
  "Research & writing",
  "Sales & outreach",
  "Something else",
];
const SETTINGS_PANEL_STORAGE_KEY = "openbot:settings-panel-width";
const SETTINGS_PANEL_DEFAULT = 296;
const SETTINGS_PANEL_MIN = 260;
const SETTINGS_PANEL_MAX = 520;
const BROWSER_PANEL_STORAGE_KEY = "openbot:browser-panel-width";
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

function ReactionIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="7.25" />
      <path d="M7.25 8h.01M12.75 8h.01M6.9 11.5c.85 1.25 1.88 1.85 3.1 1.85s2.25-.6 3.1-1.85" />
    </svg>
  );
}

function ReplyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="m8.25 5-4.5 4.1 4.5 4.1V10c4.1 0 6.45 1.35 8 4.35-.25-5.2-2.9-7.65-8-7.65z" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="5" cy="10" r="1" />
      <circle cx="10" cy="10" r="1" />
      <circle cx="15" cy="10" r="1" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
      <path d="M13 6.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v6.5A1.5 1.5 0 0 0 5 13h1.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="m4.5 10.5 3.25 3.25L15.5 6" />
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
  referencedMessage?: BotMessage;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
  onPreview: (attachment: AttachmentSummary) => void;
  onAttachmentAction: (attachment: AttachmentSummary, action: "open" | "reveal") => void;
}) {
  return (
    <>
      <Show when={props.referencedMessage}>
        {(referenced) => (
          <div class="message-reply-context">
            <span>{referenced().author === "you" ? "You" : "Agent"}</span>
            <p>{referenced().body || "Attachment"}</p>
          </div>
        )}
      </Show>
      <Show when={props.message.body}>
        <p class="message-copy">
          <TaggedMessageText
            body={props.message.body}
            bots={props.bots}
            onSelectAgent={props.onSelectAgent}
          />
        </p>
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

function MessageActions(props: {
  message: BotMessage;
  pickerOpen: boolean;
  moreOpen: boolean;
  expandedEmoji: boolean;
  copied: boolean;
  onTogglePicker: () => void;
  onToggleMore: () => void;
  onExpandEmoji: () => void;
  onReact: (emoji: MessageReaction | null) => void;
  onReply: () => void;
  onCopy: () => void;
}) {
  return (
    <div
      class="message-actions"
      classList={{ "message-actions-open": props.pickerOpen || props.moreOpen }}
      role="toolbar"
      aria-label={`${props.message.author === "you" ? "User" : "Agent"} message actions`}
    >
      <div class="message-action-popover-anchor">
        <button
          type="button"
          class="message-action-button"
          aria-label="Add reaction"
          aria-expanded={props.pickerOpen}
          onClick={props.onTogglePicker}
        >
          <ReactionIcon />
        </button>
        <Show when={props.pickerOpen}>
          <div class="reaction-picker" role="menu" aria-label="Choose a reaction">
            <div class="reaction-picker-row">
              <For each={MESSAGE_REACTIONS}>
                {(emoji) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={props.message.reaction === emoji}
                    aria-label={`React with ${emoji}`}
                    onClick={() => props.onReact(props.message.reaction === emoji ? null : emoji)}
                  >
                    {emoji}
                  </button>
                )}
              </For>
              <button
                type="button"
                class="reaction-more-button"
                aria-label="More emoji"
                aria-expanded={props.expandedEmoji}
                onClick={props.onExpandEmoji}
              >
                <PlusIcon />
              </button>
            </div>
            <Show when={props.expandedEmoji}>
              <div class="reaction-picker-row reaction-picker-more">
                <For each={MORE_MESSAGE_REACTIONS}>
                  {(emoji) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={props.message.reaction === emoji}
                      aria-label={`React with ${emoji}`}
                      onClick={() => props.onReact(props.message.reaction === emoji ? null : emoji)}
                    >
                      {emoji}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <button
        type="button"
        class="message-action-button"
        aria-label={`Reply to ${props.message.author === "you" ? "User" : "Agent"} message`}
        onClick={props.onReply}
      >
        <ReplyIcon />
      </button>
      <div class="message-action-popover-anchor">
        <button
          type="button"
          class="message-action-button"
          aria-label="More message actions"
          aria-expanded={props.moreOpen}
          onClick={props.onToggleMore}
        >
          <MoreIcon />
        </button>
        <Show when={props.moreOpen}>
          <div class="message-more-menu" role="menu">
            <button type="button" role="menuitem" onClick={props.onCopy}>
              {props.copied ? <CheckIcon /> : <CopyIcon />}
              <span>{props.copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
        </Show>
      </div>
    </div>
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
  state: "Queued" | "Working" | null;
}) {
  return (
    <div
      class="agent-activity-entry"
      classList={{ "agent-activity-entry-visible": props.state !== null }}
      role="status"
      aria-hidden={props.state === null}
      aria-label={
        props.state ? `${props.bot?.name ?? "Agent"} is ${props.state.toLowerCase()}` : undefined
      }
    >
      <AgentAvatar bot={props.bot} class="agent-activity-avatar" />
      <div class="agent-activity-bubble" aria-hidden="true">
        <span>{props.state ?? "Working"}</span>
        <span class="agent-activity-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

function ThinkingDisclosure(props: { message: BotMessage }) {
  const stepCount = () => props.message.items?.length ?? 0;
  return (
    <article class="thinking-entry">
      <details class="thinking-disclosure">
        <summary aria-label="Show thinking details">
          <span class="thinking-mark" aria-hidden="true">
            <ThinkingIcon />
          </span>
          <span>Thinking</span>
          <Show when={props.message.streaming}>
            <span class="thinking-live-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </Show>
          <Show when={!props.message.streaming && stepCount() > 1}>
            <small>{stepCount()} steps</small>
          </Show>
          <span class="thinking-chevron" aria-hidden="true">
            <ChevronIcon />
          </span>
        </summary>
        <div class="thinking-details">
          <For each={props.message.items ?? []}>{(item) => <p>{item}</p>}</For>
        </div>
      </details>
    </article>
  );
}

export function Conversation(props: ConversationProps) {
  const agentReady = () => props.agentStatus.phase === "ready";
  const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({});
  const [showAttachments, setShowAttachments] = createSignal(false);
  const [attachmentBusy, setAttachmentBusy] = createSignal(false);
  const [composerError, setComposerError] = createSignal<string | null>(null);
  const [settingsSaveError, setSettingsSaveError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [dropActive, setDropActive] = createSignal(false);
  const [rightPanels, setRightPanels] = createSignal<Record<string, RightPanelMode>>({});
  const [settingsName, setSettingsName] = createSignal("");
  const [settingsTitle, setSettingsTitle] = createSignal("");
  const [settingsDescription, setSettingsDescription] = createSignal("");
  const [settingsNotifications, setSettingsNotifications] = createSignal(true);
  const [settingsModel, setSettingsModel] = createSignal<AgentModelId>("gpt-5.6-luna");
  const [settingsReasoning, setSettingsReasoning] = createSignal<AgentReasoningEffort>("medium");
  const [avatarPickerOpen, setAvatarPickerOpen] = createSignal(false);
  const [avatarShape, setAvatarShape] = createSignal<BotAvatarShape>("blob");
  const [avatarColor, setAvatarColor] = createSignal<BotAvatarColor>("orange");
  const [browserAddress, setBrowserAddress] = createSignal("https://www.google.com");
  const [mediaPreview, setMediaPreview] = createSignal<MediaPreview | null>(null);
  const [pickerQuery, setPickerQuery] = createSignal("");
  const [activePickerOption, setActivePickerOption] = createSignal(0);
  const [openReactionMessageId, setOpenReactionMessageId] = createSignal<string | null>(null);
  const [openMoreMessageId, setOpenMoreMessageId] = createSignal<string | null>(null);
  const [expandedEmojiMessageId, setExpandedEmojiMessageId] = createSignal<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = createSignal<string | null>(null);
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
  const selectedModel = createMemo(() =>
    props.modelOptions.find((option) => option.id === settingsModel()),
  );
  const reasoningOptions = createMemo(
    () => selectedModel()?.supportedReasoningEfforts ?? ["medium" as const],
  );
  const currentDraft = createMemo(() => {
    const id = props.bot?.id;
    return id ? (drafts()[id] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
  });
  const replyTarget = createMemo(() => {
    const id = currentDraft().replyToMessageId;
    return id ? props.messages.find((message) => message.id === id) : undefined;
  });
  const filteredPickerBots = createMemo(() => {
    const query = pickerQuery().trim().toLowerCase();
    return query
      ? props.bots.filter((bot) => `${bot.name} ${bot.role}`.toLowerCase().includes(query))
      : props.bots;
  });
  const activeRightPanel = createMemo<RightPanelMode>(() => {
    if (props.agentPickerOpen) return "none";
    const botId = props.bot?.id;
    return botId ? (rightPanels()[botId] ?? "none") : "none";
  });
  const screenOpen = () => activeRightPanel() === "browser";
  const settingsOpen = () => activeRightPanel() === "settings";
  const browserTabs = createMemo(() => {
    const bot = props.bot;
    if (!bot) return [];
    return props.browserTabs.filter((tab) =>
      tab.ownerBotId
        ? tab.ownerBotId === bot.id
        : Boolean(bot.threadId && tab.ownerThreadId === bot.threadId),
    );
  });
  const activeBrowserTab = createMemo(
    () => browserTabs().find((tab) => tab.id === props.activeBrowserTabId) ?? browserTabs()[0],
  );
  const activeBrowserControl = createMemo(() => {
    const sessions = props.browserControlState.sessions;
    const activeTab = activeBrowserTab();
    const forActiveTab = activeTab?.ownerThreadId
      ? sessions.filter((session) => session.threadId === activeTab.ownerThreadId)
      : [];
    const forActiveBot = props.bot?.threadId
      ? sessions.filter((session) => session.threadId === props.bot?.threadId)
      : [];
    const candidates = forActiveTab.length > 0 ? forActiveTab : forActiveBot;
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
          tab.id === activeBrowserTab()?.id &&
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
  const queueBarVisible = createMemo(
    () =>
      Boolean(props.queue?.paused) ||
      Boolean(props.queue?.deliveries.some((item) => item.status === "queued")),
  );
  const seenMessageIds = new Set<string>();
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  let scrollElement: HTMLDivElement | undefined;
  let conversationPanel: HTMLElement | undefined;
  let browserSurface: HTMLDivElement | undefined;
  let browserResizeObserver: ResizeObserver | undefined;
  let browserWindowResizeHandler: (() => void) | undefined;
  let browserVisibilityFrame: number | undefined;
  let browserBoundsFrame: number | undefined;
  let browserVisibilityGeneration = 0;
  let pickerInput: HTMLInputElement | undefined;
  let stickToLatest = true;
  let lastConversationBotId: string | undefined;
  let lastSettingsSignature: string | undefined;
  const importTargetBots = new Map<string, string>();

  async function saveBotPatch(updates: Omit<UpdateBotInput, "botId">): Promise<boolean> {
    const botId = props.bot?.id;
    if (!botId) return false;
    setSettingsSaveError(null);
    try {
      await props.onUpdateBot(botId, updates);
      return true;
    } catch (error) {
      setSettingsSaveError(
        error instanceof Error ? error.message : "Could not save agent settings.",
      );
      return false;
    }
  }

  function selectModel(model: AgentModelId, persist = true, reportComposerError = false): void {
    const option = props.modelOptions.find((candidate) => candidate.id === model);
    if (!option) return;
    const reasoningEffort = option.supportedReasoningEfforts.includes(settingsReasoning())
      ? settingsReasoning()
      : option.defaultReasoningEffort;
    const previousModel = settingsModel();
    const previousReasoning = settingsReasoning();
    setSettingsModel(model);
    setSettingsReasoning(reasoningEffort);
    if (persist) {
      if (reportComposerError) setComposerError(null);
      void saveBotPatch({ model, reasoningEffort }).then((saved) => {
        if (saved) return;
        setSettingsModel(previousModel);
        setSettingsReasoning(previousReasoning);
        if (reportComposerError) setComposerError("Could not change model. Try again.");
      });
    }
  }

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
    const unsubscribeImport = window.openbot.agent.onAttachmentImport((event) => {
      if (event.type === "started") {
        const botId = props.bot?.id;
        if (botId) importTargetBots.set(event.requestId, botId);
        setAttachmentBusy(true);
        setComposerError(null);
      } else if (event.type === "error") {
        importTargetBots.delete(event.requestId);
        setAttachmentBusy(false);
        setComposerError(event.message);
      } else {
        setAttachmentBusy(false);
        const botId = importTargetBots.get(event.requestId);
        importTargetBots.delete(event.requestId);
        if (botId && props.bots.some((bot) => bot.id === botId)) {
          addAttachments(event.attachments, botId);
        } else {
          for (const attachment of event.attachments) {
            void window.openbot.agent.discardDraftAttachment(attachment.id);
          }
        }
      }
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenReactionMessageId(null);
      setOpenMoreMessageId(null);
      setExpandedEmojiMessageId(null);
      hideBrowserPanel();
      setMediaPreview(null);
      setAvatarPickerOpen(false);
      props.onCloseAgentPicker();
    };
    const closeMessageMenus = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest(".message-actions")) return;
      setOpenReactionMessageId(null);
      setOpenMoreMessageId(null);
      setExpandedEmojiMessageId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeMessageMenus);
    const scrollResizeObserver = new ResizeObserver(() => updateScrollFade());
    if (scrollElement) scrollResizeObserver.observe(scrollElement);
    requestAnimationFrame(() => updateScrollFade());
    onCleanup(() => {
      scrollResizeObserver.disconnect();
      unsubscribeImport();
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeMessageMenus);
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
    const signature = [
      bot.id,
      bot.name,
      bot.role,
      bot.description,
      String(bot.notifications),
      bot.model,
      bot.reasoningEffort,
      bot.avatarShape,
      bot.avatarColor,
    ].join("\u0000");
    if (signature === lastSettingsSignature) return;
    lastSettingsSignature = signature;
    setSettingsName(bot.name);
    setSettingsTitle(bot.role);
    setSettingsDescription(bot.description);
    setSettingsNotifications(bot.notifications);
    setSettingsModel(bot.model);
    setSettingsReasoning(bot.reasoningEffort);
    setAvatarShape(bot.avatarShape);
    setAvatarColor(bot.avatarColor);
    setAvatarPickerOpen(false);
  });

  createEffect(() => {
    const request = props.settingsRequest;
    if (!request || props.bot?.id !== request.botId) return;
    setActiveRightPanel("settings");
  });

  createEffect(() => {
    if (!props.agentPickerOpen) return;
    setPickerQuery("");
    setActivePickerOption(0);
    requestAnimationFrame(() => pickerInput?.focus());
  });

  createEffect(() => {
    props.bot?.id;
    const activeTab = activeBrowserTab();
    setBrowserAddress(activeTab?.url ?? "https://www.google.com");
    if (screenOpen() && activeTab && activeTab.id !== props.activeBrowserTabId) {
      props.onActivateBrowserTab(activeTab.id);
    }
  });

  createEffect(() => {
    const controlledBotIds = new Set(
      props.browserControlState.sessions
        .map((session) => props.bots.find((bot) => bot.threadId === session.threadId)?.id)
        .filter((botId): botId is string => Boolean(botId)),
    );
    if (controlledBotIds.size === 0) return;
    setRightPanels((current) => {
      const next = { ...current };
      let changed = false;
      for (const botId of controlledBotIds) {
        if (next[botId] === "browser") continue;
        next[botId] = "browser";
        changed = true;
      }
      return changed ? next : current;
    });
  });

  createEffect(() => {
    const botId = props.bot?.id;
    const visible = screenOpen();
    const generation = ++browserVisibilityGeneration;
    if (browserVisibilityFrame !== undefined) cancelAnimationFrame(browserVisibilityFrame);
    browserResizeObserver?.disconnect();
    browserResizeObserver = undefined;
    if (browserWindowResizeHandler)
      window.removeEventListener("resize", browserWindowResizeHandler);
    browserWindowResizeHandler = undefined;
    if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
    browserBoundsFrame = undefined;
    if (!visible) {
      void window.openbot.browser.setVisible({ visible: false });
      return;
    }
    browserVisibilityFrame = requestAnimationFrame(() => {
      browserVisibilityFrame = undefined;
      if (
        generation !== browserVisibilityGeneration ||
        props.bot?.id !== botId ||
        !screenOpen() ||
        !browserSurface
      ) {
        return;
      }
      const syncBounds = () => {
        if (
          generation !== browserVisibilityGeneration ||
          props.bot?.id !== botId ||
          !screenOpen() ||
          !browserSurface
        ) {
          return;
        }
        const bounds = browserSurface.getBoundingClientRect();
        void window.openbot.browser.setVisible({
          visible: true,
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        });
      };
      syncBounds();
      const scheduleBoundsSync = () => {
        if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
        browserBoundsFrame = requestAnimationFrame(() => {
          browserBoundsFrame = undefined;
          syncBounds();
        });
      };
      browserResizeObserver = new ResizeObserver(scheduleBoundsSync);
      browserResizeObserver.observe(browserSurface);
      browserWindowResizeHandler = scheduleBoundsSync;
      window.addEventListener("resize", browserWindowResizeHandler);
    });
  });

  onCleanup(() => {
    browserVisibilityGeneration += 1;
    if (browserVisibilityFrame !== undefined) cancelAnimationFrame(browserVisibilityFrame);
    if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
    browserResizeObserver?.disconnect();
    if (browserWindowResizeHandler)
      window.removeEventListener("resize", browserWindowResizeHandler);
    void window.openbot.browser.setVisible({ visible: false });
  });

  function addAttachments(selected: DraftAttachment[], botId = props.bot?.id) {
    if (!botId) return;
    const draft = drafts()[botId] ?? EMPTY_DRAFT;
    const available = Math.max(0, 10 - draft.attachments.length);
    const accepted = selected.slice(0, available);
    for (const attachment of selected.slice(available)) {
      void window.openbot.agent.discardDraftAttachment(attachment.id);
    }
    setDrafts((current) => ({
      ...current,
      [botId]: {
        ...(current[botId] ?? EMPTY_DRAFT),
        attachments: [...draft.attachments, ...accepted],
      },
    }));
    if (selected.length > accepted.length) setComposerError("You can attach at most 10 files.");
    setShowAttachments(false);
  }

  async function chooseAttachments() {
    if (attachmentBusy()) return;
    setAttachmentBusy(true);
    setComposerError(null);
    try {
      addAttachments(await window.openbot.agent.chooseAttachments());
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
      override ? null : draft.replyToMessageId,
    );
    setSubmitting(false);
    if (sent) setDrafts((current) => ({ ...current, [botId]: EMPTY_DRAFT }));
  }

  function replyToMessage(message: BotMessage) {
    updateCurrentDraft({ replyToMessageId: message.id });
    setOpenReactionMessageId(null);
    setOpenMoreMessageId(null);
  }

  async function reactToMessage(message: BotMessage, emoji: MessageReaction | null) {
    const botId = props.bot?.id;
    if (!botId) return;
    setOpenReactionMessageId(null);
    setExpandedEmojiMessageId(null);
    try {
      await window.openbot.agent.setMessageReaction({ botId, messageId: message.id, emoji });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyMessage(message: BotMessage) {
    const text = message.body;
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = document.createElement("textarea");
        input.value = text;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.append(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        if (copiedMessageId() === message.id) setCopiedMessageId(null);
      }, 1_400);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : "Could not copy the message.");
    }
  }

  function removeAttachment(id: string) {
    updateCurrentDraft({
      attachments: currentDraft().attachments.filter((attachment) => attachment.id !== id),
    });
    void window.openbot.agent.discardDraftAttachment(id);
  }

  async function openBrowserAddress() {
    const value = browserAddress().trim();
    if (!value) return;
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const tab = await window.openbot.browser.open({
        url,
        ownerThreadId: props.bot?.threadId ?? null,
        ownerBotId: props.bot?.id ?? null,
      });
      setBrowserAddress(tab.url);
      setActiveRightPanel("browser");
    } catch {
      setBrowserAddress(url);
    }
  }

  function showBrowserPanel() {
    setActiveRightPanel("browser");
    if (browserTabs().length === 0) void openBrowserAddress();
  }

  function hideBrowserPanel() {
    setActiveRightPanel("none");
    void window.openbot.browser.setVisible({ visible: false });
  }

  function setActiveRightPanel(mode: RightPanelMode) {
    const botId = props.bot?.id;
    if (!botId) return;
    setRightPanels((current) =>
      current[botId] === mode ? current : { ...current, [botId]: mode },
    );
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
    void window.openbot.agent
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
                      setActiveRightPanel("settings");
                    }}
                  >
                    <AgentAvatar bot={bot()} />
                    <h1>{bot().name}</h1>
                  </button>
                )}
              </Show>
              <div class="conversation-header-actions no-drag">
                <Show when={props.bot}>
                  <ProviderModelPicker
                    value={settingsModel()}
                    modelOptions={props.modelOptions}
                    agentStatus={props.agentStatus}
                    disabled={!agentReady() || agentActivity() === "Working"}
                    disabledReason={
                      agentActivity() === "Working"
                        ? "Wait for the current work to finish before changing models."
                        : "Models are available after an agent CLI connects."
                    }
                    onChange={(model) => selectModel(model, true, true)}
                  />
                </Show>
                <button
                  type="button"
                  class="header-panel-toggle computer-button"
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
                    if (screenOpen()) hideBrowserPanel();
                    else showBrowserPanel();
                  }}
                >
                  <ComputerIcon />
                  <Show when={activeBrowserControl()}>
                    <span class="computer-control-dot" aria-hidden="true" />
                  </Show>
                </button>
              </div>
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
          <Show when={!agentReady()}>
            <section class="agent-setup-card" role="status">
              <div>
                <strong>
                  {props.agentStatus.phase === "starting" ||
                  props.agentStatus.phase === "restarting"
                    ? "Connecting to agent CLIs…"
                    : "Agent CLI setup required"}
                </strong>
                <p>
                  {props.agentStatus.message ??
                    "Install and sign in to Codex CLI or Claude CLI, then restart OpenBot."}
                </p>
              </div>
              <Show
                when={
                  props.agentStatus.phase !== "starting" && props.agentStatus.phase !== "restarting"
                }
              >
                <button
                  type="button"
                  onClick={() =>
                    void props
                      .onOpenAgentSetup()
                      .catch((error) =>
                        setComposerError(error instanceof Error ? error.message : String(error)),
                      )
                  }
                >
                  Setup guide
                </button>
              </Show>
            </section>
          </Show>
          <Show when={props.messages.length > 0}>
            <div class="time-marker">
              <span>{props.messages[0]?.time ?? "now"}</span>
            </div>
          </Show>
          <Show when={agentReady() && props.messages.length === 0 && !props.activeTurnId}>
            <article class="message-entry message-entry-animated message-entry-bot onboarding-message">
              <div class="bot-bubble">
                <p class="message-copy">Hey — good to meet you.</p>
              </div>
              <div class="choice-card onboarding-runtime-card">
                <div class="choice-card-heading">
                  <div>
                    <strong>Agent setup</strong>
                    <span>Choose a model. You can change it later.</span>
                  </div>
                </div>
                <div class="agent-settings-model-controls onboarding-model-control">
                  <ProviderModelPicker
                    variant="field"
                    ariaLabel="Onboarding model"
                    value={settingsModel()}
                    agentStatus={props.agentStatus}
                    modelOptions={props.modelOptions}
                    onChange={(model) => selectModel(model, false)}
                  />
                </div>
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
                  const completed = await props.onCompleteOnboarding(
                    answer,
                    settingsModel(),
                    settingsReasoning(),
                  );
                  setSubmitting(false);
                  return completed;
                }}
              />
            </article>
          </Show>
          <For each={props.messages}>
            {(message) => {
              const animateEntrance = message.animate === true && markMessageSeen(message.id);
              return (
                <Show
                  when={message.exchange}
                  fallback={
                    <Show
                      when={message.kind === "thinking"}
                      fallback={
                        <article
                          class="message-entry"
                          classList={{
                            "message-entry-animated": animateEntrance,
                            "message-entry-user": message.author === "you",
                            "message-entry-bot": message.author === "bot",
                          }}
                        >
                          <div class="message-shell">
                            <div
                              class={message.author === "you" ? "user-bubble" : "bot-bubble"}
                              classList={{ "bot-bubble-streaming": message.streaming === true }}
                            >
                              <MessageBody
                                message={message}
                                referencedMessage={props.messages.find(
                                  (candidate) => candidate.id === message.replyToMessageId,
                                )}
                                bots={props.bots}
                                onSelectAgent={props.onSelectAgent}
                                onPreview={(attachment) => void previewAttachment(attachment)}
                                onAttachmentAction={attachmentAction}
                              />
                            </div>
                            <MessageActions
                              message={message}
                              pickerOpen={openReactionMessageId() === message.id}
                              moreOpen={openMoreMessageId() === message.id}
                              expandedEmoji={expandedEmojiMessageId() === message.id}
                              copied={copiedMessageId() === message.id}
                              onTogglePicker={() => {
                                setOpenReactionMessageId((current) =>
                                  current === message.id ? null : message.id,
                                );
                                setOpenMoreMessageId(null);
                                setExpandedEmojiMessageId(null);
                              }}
                              onToggleMore={() => {
                                setOpenMoreMessageId((current) =>
                                  current === message.id ? null : message.id,
                                );
                                setOpenReactionMessageId(null);
                                setExpandedEmojiMessageId(null);
                              }}
                              onExpandEmoji={() =>
                                setExpandedEmojiMessageId((current) =>
                                  current === message.id ? null : message.id,
                                )
                              }
                              onReact={(emoji) => void reactToMessage(message, emoji)}
                              onReply={() => replyToMessage(message)}
                              onCopy={() => void copyMessage(message)}
                            />
                          </div>
                          <Show when={message.reaction}>
                            {(reaction) => (
                              <button
                                type="button"
                                class="message-reaction-pill"
                                aria-label={`Remove reaction ${reaction()}`}
                                onClick={() => void reactToMessage(message, null)}
                              >
                                {reaction()}
                              </button>
                            )}
                          </Show>
                        </article>
                      }
                    >
                      <div classList={{ "thinking-entry-animated": animateEntrance }}>
                        <ThinkingDisclosure message={message} />
                      </div>
                    </Show>
                  }
                >
                  {(exchange) => (
                    <article
                      class="exchange-message-entry"
                      classList={{ "exchange-message-entry-animated": animateEntrance }}
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
          <AgentActivityIndicator bot={props.bot} state={agentActivity()} />
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
        <Show when={replyTarget()}>
          {(message) => (
            <div class="composer-reply-preview">
              <div>
                <span>Replying to {message().author === "you" ? "your message" : "Agent"}</span>
                <p>{message().body || "Attachment"}</p>
              </div>
              <button
                type="button"
                aria-label="Cancel reply"
                onClick={() => updateCurrentDraft({ replyToMessageId: null })}
              >
                <CloseIcon />
              </button>
            </div>
          )}
        </Show>
        <Show when={composerError()}>
          <div class="composer-error" role="alert">
            {composerError()}
          </div>
        </Show>
        <div
          class="agent-queue-bar"
          classList={{ "agent-queue-bar-visible": queueBarVisible() }}
          aria-hidden={!queueBarVisible()}
        >
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
        <div class="composer">
          <button
            type="button"
            class="composer-button"
            aria-label="Attach a file"
            disabled={props.agentPickerOpen || attachmentBusy() || !agentReady()}
            onClick={() => setShowAttachments((value) => !value)}
          >
            <PlusIcon />
          </button>
          <div class="composer-input-label">
            <ComposerEditor
              botId={props.bot?.id}
              bots={props.bots}
              value={currentDraft().text}
              disabled={props.agentPickerOpen || submitting() || !agentReady()}
              placeholder={
                !agentReady()
                  ? "Complete agent CLI setup to start"
                  : replyTarget()
                    ? "Reply…"
                    : `Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`
              }
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
                disabled={submitting() || !agentReady()}
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
                <For each={browserTabs()}>
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
                            "browser-tab-active": activeBrowserTab()?.id === tab.id,
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
            <Show when={browserTabs().length === 0}>
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
              onClick={() => setActiveRightPanel("none")}
            >
              <BackIcon />
            </button>
            <h2>Settings</h2>
            <button
              type="button"
              class="agent-settings-nav-button"
              aria-label="Close details"
              onClick={() => setActiveRightPanel("none")}
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
                          saveBotPatch({ avatarShape: shape });
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
                          saveBotPatch({ avatarColor: color });
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
                onBlur={() => saveBotPatch({ name: settingsName().trim() || "New agent" })}
              />
            </label>
            <label class="agent-settings-field">
              <span>Title</span>
              <input
                value={settingsTitle()}
                aria-label="Agent title"
                placeholder="Describe what your agent does"
                onInput={(event) => setSettingsTitle(event.currentTarget.value)}
                onBlur={() => saveBotPatch({ role: settingsTitle().trim() })}
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
                onBlur={() => saveBotPatch({ description: settingsDescription() })}
              />
            </label>
            <section class="agent-settings-model" aria-labelledby="agent-model-heading">
              <div class="agent-settings-section-heading">
                <strong id="agent-model-heading">Runtime</strong>
                <span>Choose how this agent runs</span>
              </div>
              <div class="agent-settings-model-controls">
                <div class="agent-settings-model-option">
                  <ProviderModelPicker
                    variant="field"
                    ariaLabel="Agent model"
                    value={settingsModel()}
                    agentStatus={props.agentStatus}
                    modelOptions={props.modelOptions}
                    disabled={!agentReady() || agentActivity() === "Working"}
                    disabledReason={
                      agentActivity() === "Working"
                        ? "Wait for the current work to finish before changing models."
                        : "Models are available after an agent CLI connects."
                    }
                    onChange={(model) => selectModel(model, true, true)}
                  />
                  <Show when={selectedModel()} keyed>
                    {(model) => <p class="agent-settings-model-description">{model.description}</p>}
                  </Show>
                </div>
                <label class="agent-settings-model-row agent-settings-thinking-row">
                  <span>Reasoning</span>
                  <select
                    value={settingsReasoning()}
                    aria-label="Agent reasoning level"
                    onChange={(event) => {
                      const reasoningEffort = event.currentTarget.value as AgentReasoningEffort;
                      setSettingsReasoning(reasoningEffort);
                      saveBotPatch({ reasoningEffort });
                    }}
                  >
                    <For each={reasoningOptions()}>
                      {(effort) => <option value={effort}>{reasoningLabel(effort)}</option>}
                    </For>
                  </select>
                </label>
              </div>
            </section>
            <Show when={settingsSaveError()}>
              {(message) => (
                <p class="agent-settings-save-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
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
                  saveBotPatch({ notifications: next });
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

function reasoningLabel(effort: AgentReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}

function ThinkingIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.75a4.65 4.65 0 0 0-2.85 8.33c.47.36.73.78.78 1.17h4.14c.05-.39.31-.81.78-1.17A4.65 4.65 0 0 0 8 1.75Z" />
      <path d="M6.3 13h3.4M6.9 14.5h2.2" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m5.75 6.5 2.25 2.25 2.25-2.25" />
    </svg>
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
