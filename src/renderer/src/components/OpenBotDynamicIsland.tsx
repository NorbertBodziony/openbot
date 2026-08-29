import { AppLogo } from "@openbot/brand";
import type {
  DynamicIslandAction,
  DynamicIslandAttentionItem,
  DynamicIslandBotIdentity,
  DynamicIslandPresentation,
} from "@openbot/contracts/ipc";
import { Dynamic, type JSX } from "@solidjs/web";
import { Check, MessageCircle, ShieldAlert } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import { AgentAvatar } from "./AgentAvatar";
import {
  Button,
  DynamicIsland,
  type DynamicIslandHoverContentMotion,
  type DynamicIslandStateChangeReason,
  type DynamicIslandViewState,
} from "./ui";

export interface OpenBotDynamicIslandProps {
  presentation: DynamicIslandPresentation;
  state: DynamicIslandViewState;
  displayMode?: "notch" | "island";
  onStateChange: (state: DynamicIslandViewState, reason: DynamicIslandStateChangeReason) => void;
  onAction: (action: DynamicIslandAction) => void | Promise<void>;
  onLater: () => void;
}

const COMPACT_INDICES = [0, 1] as const;
const ROW_INDICES = [0, 1, 2] as const;
const IDLE_GREETING_EMOJIS = ["👋", "😊", "🙌", "✨"] as const;
type IdleGreetingEmoji = (typeof IDLE_GREETING_EMOJIS)[number];
const IDLE_GREETING_INTERVAL = 8_000;
const HOVER_CONTENT_MOTION = {
  idle: { leadingScale: 1.375, trailingScale: 1.375, translateY: 6 },
  working: { leadingScale: 1.11, trailingScale: 1.08, translateY: 6 },
  message: { leadingScale: 1.22, trailingScale: 1.08, translateY: 6 },
  question: { leadingScale: 1.08, trailingScale: 1, translateY: 6 },
  approval: { leadingScale: 1.25, trailingScale: 1.08, translateY: 6 },
} satisfies Record<DynamicIslandPresentation["mode"], DynamicIslandHoverContentMotion>;

/**
 * OpenBot's own presentation layer. Motion behavior is informed by Atoll's macOS interaction model,
 * without copying its GPL-licensed source or assets: https://github.com/Ebullioscopic/Atoll
 */
export function OpenBotDynamicIsland(props: OpenBotDynamicIslandProps): JSX.Element {
  function changeState(next: DynamicIslandViewState, reason: DynamicIslandStateChangeReason): void {
    if (props.presentation.mode === "idle" && next === "expanded") {
      void props.onAction({ type: "open-app" });
      return;
    }
    props.onStateChange(next, reason);
  }

  return (
    <DynamicIsland
      label={`${labelForMode(props.presentation.mode)}${props.displayMode === "island" ? " on external display" : ""}`}
      tone={
        props.presentation.mode === "approval"
          ? "attention"
          : props.presentation.mode === "working"
            ? "working"
            : "neutral"
      }
      state={props.state}
      displayMode={props.displayMode}
      onStateChange={changeState}
      hoverBehavior={props.presentation.mode === "idle" ? "peek" : "expand"}
      hoverContentMotion={HOVER_CONTENT_MOTION[props.presentation.mode]}
      pointerToggle={false}
      contentMotion={props.presentation.mode === "question" || props.presentation.mode === "idle" ? "atoll" : "morph"}
      morphCompactContent={props.presentation.mode !== "idle"}
      sharedLeadingMotion={props.presentation.mode === "question"}
      sharedLeadingExpandedX={
        props.presentation.mode === "question" ? (props.displayMode === "island" ? -128 : -33.75) : undefined
      }
      sharedLeadingExpandedY={
        props.presentation.mode === "question" ? (props.displayMode === "island" ? 51 : 49.5) : undefined
      }
      sharedLeadingExpandedScale={
        props.presentation.mode === "question" ? (props.displayMode === "island" ? 1.9 : 1.75) : undefined
      }
      class={[
        props.presentation.mode === "question" ? "dynamic-island-question" : undefined,
        props.presentation.mode === "idle" ? "dynamic-island-idle" : undefined,
        props.displayMode === "island" ? "dynamic-island-external" : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
      compactLeading={<CompactLeading presentation={props.presentation} />}
      compactTrailing={<CompactTrailing presentation={props.presentation} />}
      peekContent={<PeekContent presentation={props.presentation} />}
      expandedContent={
        <ExpandedContent
          presentation={props.presentation}
          displayMode={props.displayMode}
          onAction={props.onAction}
          onLater={() => {
            props.onLater();
            props.onStateChange("compact", "pointer");
          }}
        />
      }
    />
  );
}

function CompactLeading(props: { presentation: DynamicIslandPresentation }): JSX.Element {
  const key = () => compactLeadingKey(props.presentation);
  return (
    <IslandContentSwap contentKey={key()} class="dynamic-island-surface-compact-swap">
      <Switch fallback={<AppLogo variant="production" animation="blink" class="dynamic-island-surface-logo" />}>
        <Match when={props.presentation.mode === "working"}>
          <span class="dynamic-island-surface-avatar-stack">
            <For each={COMPACT_INDICES}>
              {(index) => (
                <Show when={props.presentation.working[index]}>{(item) => <IslandAvatar bot={item().bot} />}</Show>
              )}
            </For>
          </span>
        </Match>
        <Match when={props.presentation.mode === "message" && props.presentation.message}>
          {(message) => <IslandAvatar bot={message().bot} />}
        </Match>
        <Match when={props.presentation.mode === "question" && props.presentation.attention[0]}>
          {(item) => (
            <span class="dynamic-island-surface-question-identity">
              <IslandAvatar bot={item().bot} roundBlob />
              <span class="dynamic-island-surface-question-name">{item().bot.name}</span>
            </span>
          )}
        </Match>
        <Match when={props.presentation.mode === "approval"}>
          <ShieldAlert class="dynamic-island-surface-attention" strokeWidth={2} />
        </Match>
      </Switch>
    </IslandContentSwap>
  );
}

function CompactTrailing(props: { presentation: DynamicIslandPresentation }): JSX.Element {
  const key = () => compactTrailingKey(props.presentation);
  return (
    <IslandContentSwap contentKey={key()} class="dynamic-island-surface-compact-swap">
      <Switch>
        <Match when={props.presentation.mode === "working"}>
          <span class="dynamic-island-surface-count">{props.presentation.activeCount}</span>
        </Match>
        <Match when={props.presentation.mode === "message"}>
          <span class="dynamic-island-surface-count">{props.presentation.unreadCount}</span>
        </Match>
        <Match when={props.presentation.mode === "question"}>{null}</Match>
        <Match when={props.presentation.mode === "approval"}>
          <span class="dynamic-island-surface-count dynamic-island-surface-count-attention">
            {props.presentation.attentionCount}
          </span>
        </Match>
        <Match when={props.presentation.mode === "idle"}>
          <IdleGreetingEmoji />
        </Match>
      </Switch>
    </IslandContentSwap>
  );
}

function IdleGreetingEmoji(): JSX.Element {
  const [index, setIndex] = createSignal(0);
  const [activeSlot, setActiveSlot] = createSignal<0 | 1>(0);
  const [firstEmoji, setFirstEmoji] = createSignal<IdleGreetingEmoji>(IDLE_GREETING_EMOJIS[0]);
  const [secondEmoji, setSecondEmoji] = createSignal<IdleGreetingEmoji>(IDLE_GREETING_EMOJIS[0]);
  let animationFrame: number | undefined;

  onSettled(() => {
    const timer = setInterval(() => {
      const nextIndex = (index() + 1) % IDLE_GREETING_EMOJIS.length;
      const nextEmoji = IDLE_GREETING_EMOJIS[nextIndex] ?? IDLE_GREETING_EMOJIS[0];
      const nextSlot = activeSlot() === 0 ? 1 : 0;
      if (nextSlot === 0) setFirstEmoji(nextEmoji);
      else setSecondEmoji(nextEmoji);
      animationFrame = requestAnimationFrame(() => {
        setIndex(nextIndex);
        setActiveSlot(nextSlot);
      });
    }, IDLE_GREETING_INTERVAL);
    return () => {
      clearInterval(timer);
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    };
  });

  return (
    <span class="dynamic-island-surface-idle-greeting" data-active-slot={activeSlot()} aria-hidden="true">
      <span class="dynamic-island-surface-idle-greeting-layer">{firstEmoji()}</span>
      <span class="dynamic-island-surface-idle-greeting-layer">{secondEmoji()}</span>
    </span>
  );
}

function PeekContent(props: { presentation: DynamicIslandPresentation }): JSX.Element {
  return (
    <IslandContentSwap contentKey={peekKey(props.presentation)} class="dynamic-island-surface-peek-swap">
      <div class="dynamic-island-surface-peek dynamic-island-surface-peek-with-corners">
        <Switch fallback={<strong>Open OpenBot</strong>}>
          <Match when={props.presentation.mode === "idle"}>{null}</Match>
          <Match when={props.presentation.mode === "working"}>
            <strong>{workingLabel(props.presentation.activeCount)}</strong>
          </Match>
          <Match when={props.presentation.mode === "message" && props.presentation.message}>
            {(message) => (
              <>
                <strong>{message().bot.name}</strong>
                <span>{message().text}</span>
              </>
            )}
          </Match>
          <Match when={props.presentation.mode === "question" && props.presentation.attention[0]}>{null}</Match>
          <Match when={props.presentation.mode === "approval" && props.presentation.attention[0]}>
            {(item) => (
              <>
                <strong>{item().bot.name} needs approval</strong>
                <span>{item().title}</span>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </IslandContentSwap>
  );
}

function ExpandedContent(props: {
  presentation: DynamicIslandPresentation;
  displayMode?: "notch" | "island";
  onAction: (action: DynamicIslandAction) => void | Promise<void>;
  onLater: () => void;
}): JSX.Element {
  return (
    <Switch>
      <Match when={props.presentation.mode === "working"}>
        <div class="dynamic-island-surface-panel">
          <PanelHeading title={workingLabel(props.presentation.activeCount)} withLeading />
          <div class="dynamic-island-surface-list">
            <For each={ROW_INDICES}>
              {(index) => (
                <Show when={props.presentation.working[index]}>
                  {(item) => (
                    <button
                      class="dynamic-island-surface-row dynamic-island-surface-animated-row"
                      type="button"
                      onClick={() =>
                        props.onAction({
                          type: "open-bot",
                          serverId: props.presentation.serverId,
                          botId: item().bot.id,
                        })
                      }
                    >
                      <IslandAvatar bot={item().bot} />
                      <IslandContentSwap contentKey={`${item().bot.id}:${item().task}`}>
                        <span class="dynamic-island-surface-row-copy">
                          <strong>{item().bot.name}</strong>
                          <small>{item().task}</small>
                        </span>
                      </IslandContentSwap>
                    </button>
                  )}
                </Show>
              )}
            </For>
          </div>
        </div>
      </Match>
      <Match when={props.presentation.mode === "message" && props.presentation.message}>
        {(message) => (
          <div class="dynamic-island-surface-panel">
            <PanelHeading title="New reply" withLeading />
            <IslandContentSwap contentKey={message().messageId} block>
              <p class="dynamic-island-surface-message">{message().text}</p>
            </IslandContentSwap>
            <div class="dynamic-island-surface-actions">
              <Button
                size="sm"
                onClick={() =>
                  props.onAction({
                    type: "open-message",
                    serverId: props.presentation.serverId,
                    botId: message().bot.id,
                    messageId: message().messageId,
                  })
                }
              >
                <MessageCircle aria-hidden="true" /> Open chat
              </Button>
            </div>
          </div>
        )}
      </Match>
      <Match
        when={
          (props.presentation.mode === "question" || props.presentation.mode === "approval") &&
          props.presentation.attention[0]
        }
      >
        {(item) => (
          <AttentionContent
            item={item()}
            displayMode={props.displayMode}
            serverId={props.presentation.serverId}
            remainingCount={Math.max(0, props.presentation.attentionCount - 1)}
            onAction={props.onAction}
            onLater={props.onLater}
          />
        )}
      </Match>
    </Switch>
  );
}

function AttentionContent(props: {
  item: DynamicIslandAttentionItem;
  displayMode?: "notch" | "island";
  serverId: string;
  remainingCount: number;
  onAction: (action: DynamicIslandAction) => void | Promise<void>;
  onLater: () => void;
}): JSX.Element {
  const [questionIndex, setQuestionIndex] = createSignal(0);
  const [answers, setAnswers] = createSignal<Record<string, string[]>>({});
  createEffect(
    () => `${props.item.id}:${props.item.questions?.map((question) => question.id).join(",") ?? ""}`,
    () => {
      setQuestionIndex(0);
      setAnswers({});
    },
  );
  const questions = () => props.item.questions ?? [];
  const directAnswerAvailable = createMemo(
    () =>
      questions().length > 0 &&
      questions().every(
        (question) =>
          !question.isSecret &&
          Boolean(question.options && question.options.length > 0 && question.options.length <= 3),
      ),
  );
  const currentQuestion = () => questions()[questionIndex()];
  const questionText = () => currentQuestion()?.question ?? props.item.detail ?? props.item.title;
  const questionKey = () => `${props.item.id}:${currentQuestion()?.id ?? "fallback"}`;
  const openInOpenBot = () =>
    props.onAction({
      type: "review-attention",
      serverId: props.serverId,
      botId: props.item.bot.id,
      requestId: props.item.requestId,
    });

  function answerWith(label: string): void {
    const question = currentQuestion();
    if (!question || !directAnswerAvailable()) return;
    const nextAnswers = { ...answers(), [question.id]: [label] };
    if (questionIndex() < questions().length - 1) {
      setAnswers(nextAnswers);
      setQuestionIndex((index) => index + 1);
      return;
    }
    void props.onAction({
      type: "answer-prompt",
      serverId: props.serverId,
      botId: props.item.bot.id,
      requestId: props.item.requestId,
      answers: nextAnswers,
    });
  }

  return (
    <Show
      when={props.item.kind === "prompt"}
      fallback={
        <div class="dynamic-island-surface-panel dynamic-island-surface-attention-panel">
          <PanelHeading title="Approval needed" withLeading />
          <IslandContentSwap contentKey={`${props.item.id}:${props.item.detail ?? ""}`} block>
            <div class="dynamic-island-surface-request-copy">
              <Show when={props.item.approval?.reason}>{(reason) => <p>{reason()}</p>}</Show>
              <ApprovalContext item={props.item} />
              <Show when={props.remainingCount > 0}>
                <small class="dynamic-island-surface-more">
                  +{props.remainingCount} more {props.remainingCount === 1 ? "request" : "requests"}
                </small>
              </Show>
            </div>
          </IslandContentSwap>
          <div class="dynamic-island-surface-actions">
            <Button size="sm" variant="ghost" onClick={openInOpenBot}>
              Open in OpenBot
            </Button>
            <Button
              size="sm"
              onClick={() =>
                props.onAction({
                  type: "approve-attention",
                  serverId: props.serverId,
                  botId: props.item.bot.id,
                  requestId: props.item.requestId,
                })
              }
            >
              <Check aria-hidden="true" /> Approve
            </Button>
          </div>
        </div>
      }
    >
      <div class="dynamic-island-surface-panel dynamic-island-surface-question-panel">
        <div class="dynamic-island-surface-question-summary">
          <span class="dynamic-island-surface-question-avatar-slot" aria-hidden="true" />
          <div class="dynamic-island-surface-question-copy">
            <header class="dynamic-island-surface-question-heading">
              <h1>
                <span class="dynamic-island-surface-question-bot-name">{props.item.bot.name}</span>
                <span class="dynamic-island-surface-question-asks">asks</span>
              </h1>
            </header>
            <IslandContentSwap contentKey={questionKey()} block>
              <p class="dynamic-island-surface-question-prompt">{questionText()}</p>
            </IslandContentSwap>
          </div>
          <Show when={directAnswerAvailable() && questions().length > 1}>
            <span class="dynamic-island-surface-question-progress">
              {questionIndex() + 1} / {questions().length}
            </span>
          </Show>
        </div>
        <IslandContentSwap contentKey={questionKey()} block>
          <div class="dynamic-island-surface-question-step">
            <Show when={directAnswerAvailable()}>
              <ul class="dynamic-island-surface-question-options" aria-label="Suggested answers">
                <For each={currentQuestion()?.options ?? []}>
                  {(option, index) => (
                    <li>
                      <button
                        type="button"
                        aria-label={`${option.label}. ${option.description}`}
                        onClick={() => answerWith(option.label)}
                      >
                        <span class="dynamic-island-surface-question-option-index" aria-hidden="true">
                          {index() + 1}
                        </span>
                        <span class="dynamic-island-surface-question-option-copy">
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </IslandContentSwap>
        <div class="dynamic-island-surface-actions dynamic-island-surface-question-actions">
          <Show when={props.remainingCount > 0}>
            <small class="dynamic-island-surface-more">
              +{props.remainingCount} more {props.remainingCount === 1 ? "request" : "requests"}
            </small>
          </Show>
          <Button size="sm" variant="ghost" onClick={props.onLater}>
            Later
          </Button>
          <Button size="sm" onClick={openInOpenBot}>
            Answer in OpenBot
          </Button>
        </div>
      </div>
    </Show>
  );
}

function ApprovalContext(props: { item: DynamicIslandAttentionItem }): JSX.Element {
  return (
    <Show when={props.item.kind === "approval" && props.item.approval}>
      {(approval) => (
        <>
          <Show when={approval().command}>
            {(command) => (
              <div class="dynamic-island-surface-command">
                <Show when={approval().cwd}>{(cwd) => <small>{cwd()}</small>}</Show>
                <code>{command()}</code>
              </div>
            )}
          </Show>
          <Show when={approval().kind === "file-change"}>
            <div class="dynamic-island-surface-context-line">
              <small>Files</small>
              <span>{approval().grantRoot ?? "Agent workspace"}</span>
            </div>
          </Show>
          <Show when={approval().kind === "permissions" && approval().permissions}>
            {(permissions) => (
              <div class="dynamic-island-surface-context-line">
                <small>Access</small>
                <span>{permissionSummary(permissions())}</span>
              </div>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}

function PanelHeading(props: {
  title: string;
  leading?: JSX.Element;
  withLeading?: boolean;
  sharedLeading?: boolean;
}): JSX.Element {
  return (
    <header
      class={[
        "dynamic-island-surface-heading",
        props.withLeading ? "dynamic-island-surface-heading-with-leading" : undefined,
        props.sharedLeading ? "dynamic-island-surface-heading-with-shared-leading" : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Show when={props.sharedLeading}>
        <span class="dynamic-island-surface-shared-leading-slot" aria-hidden="true" />
      </Show>
      {props.leading}
      <h1>{props.title}</h1>
    </header>
  );
}

function IslandAvatar(props: { bot: DynamicIslandBotIdentity; roundBlob?: boolean }): JSX.Element {
  return (
    <AgentAvatar
      bot={props.bot}
      motion="idle"
      shape={props.roundBlob ? "cercle" : undefined}
      class="dynamic-island-surface-avatar"
    />
  );
}

function IslandContentSwap(props: {
  contentKey: string;
  children: JSX.Element;
  class?: string;
  block?: boolean;
}): JSX.Element {
  let hasRendered = false;
  return (
    <Show keyed when={props.contentKey || null}>
      {(_contentKey) => {
        const swapPhase = hasRendered ? "update" : "initial";
        hasRendered = true;
        return (
          <Dynamic
            component={props.block ? "div" : "span"}
            class={["dynamic-island-surface-content-swap", props.class].filter(Boolean).join(" ")}
            data-swap-phase={swapPhase}
          >
            {props.children}
          </Dynamic>
        );
      }}
    </Show>
  );
}

function compactLeadingKey(presentation: DynamicIslandPresentation): string {
  if (presentation.mode === "working") {
    return `working:${presentation.working.map((item) => item.bot.id).join(",")}`;
  }
  if (presentation.mode === "message") return `message:${presentation.message?.bot.id ?? ""}`;
  if (presentation.mode === "question" || presentation.mode === "approval") {
    return `${presentation.mode}:${presentation.attention[0]?.bot.id ?? ""}`;
  }
  return "idle";
}

function compactTrailingKey(presentation: DynamicIslandPresentation): string {
  if (presentation.mode === "working") return `working:${presentation.activeCount}`;
  if (presentation.mode === "message") return `message:${presentation.unreadCount}`;
  if (presentation.mode === "question") return "question";
  if (presentation.mode === "approval") return `approval:${presentation.attentionCount}`;
  return "idle";
}

function peekKey(presentation: DynamicIslandPresentation): string {
  if (presentation.mode === "working") return `working:${presentation.activeCount}`;
  if (presentation.mode === "message") return `message:${presentation.message?.messageId ?? ""}`;
  if (presentation.mode === "question" || presentation.mode === "approval") {
    return `${presentation.mode}:${presentation.attention[0]?.id ?? ""}`;
  }
  return "idle";
}

function labelForMode(mode: DynamicIslandPresentation["mode"]) {
  if (mode === "working") return "OpenBot working status";
  if (mode === "message") return "OpenBot chat update";
  if (mode === "question") return "OpenBot question from AI";
  if (mode === "approval") return "OpenBot approval request";
  return "Open OpenBot";
}

function permissionSummary(
  permissions: NonNullable<NonNullable<DynamicIslandAttentionItem["approval"]>["permissions"]>,
) {
  const parts = [
    permissions.fileSystem.read.length > 0 ? "read files" : null,
    permissions.fileSystem.write.length > 0 ? "write files" : null,
    permissions.network ? "use network" : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Limited agent access";
}

function workingLabel(count: number): string {
  return `${count} ${count === 1 ? "bot" : "bots"} working`;
}
