import { AppLogo } from "@openbot/brand";
import type {
  DynamicIslandAction,
  DynamicIslandAttentionItem,
  DynamicIslandBotIdentity,
  DynamicIslandPresentation,
} from "@openbot/contracts/ipc";
import { Dynamic, type JSX } from "@solidjs/web";
import { Check, MessageCircle, MessageCircleQuestionMark } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onSettled, Show, Switch } from "solid-js";
import { AgentAvatar } from "./AgentAvatar";
import {
  Badge,
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
const QUESTION_SWAP_EXIT_DURATION = 200;
const QUESTION_SWAP_ENTER_DURATION = 320;
const QUESTION_SWAP_BLUR = 6;
const QUESTION_SWAP_MIDPOINT_OPACITY = 0.55;
const OPENBOT_COMPACT_HOVER_MOTION = {
  leadingScale: 1.22,
  trailingScale: 1.08,
  outwardTranslateX: 10,
  translateY: 4,
} as const;
const QUESTION_PROGRESS_DURATION = 300;
const QUESTION_PROGRESS_BLUR = 2;
const COMPACT_LEADING_SIZE = 20;

interface OpenBotDynamicIslandFrameProps {
  label: string;
  tone: "neutral" | "working" | "attention";
  state: DynamicIslandViewState;
  displayMode?: "notch" | "island";
  compactLeading: JSX.Element;
  compactTrailing: JSX.Element;
  expandedContent: JSX.Element;
  compactWidth?: "standard" | "wide";
  panelWidth?: "standard" | "wide";
  sharedLeading?: SharedLeadingMotion;
  sharedTrailing?: SharedLeadingMotion;
  autoExpand?: boolean;
  hoverContentMotion?: DynamicIslandHoverContentMotion;
  class?: string;
  onStateChange: (state: DynamicIslandViewState, reason: DynamicIslandStateChangeReason) => void;
}

interface SharedLeadingMotion {
  notch: { x: number; y: number; scale: number };
  island: { x: number; y: number; scale: number };
}

const WORKING_SHARED_LEADING: SharedLeadingMotion = {
  notch: { x: -58, y: 76, scale: 32 / COMPACT_LEADING_SIZE },
  island: { x: -86, y: 76, scale: 32 / COMPACT_LEADING_SIZE },
};

const QUESTION_SHARED_LEADING: SharedLeadingMotion = {
  notch: { x: -48.5, y: 49.5, scale: 35 / COMPACT_LEADING_SIZE },
  island: { x: -115, y: 51, scale: 38 / COMPACT_LEADING_SIZE },
};

const QUESTION_SHARED_TRAILING: SharedLeadingMotion = {
  notch: { x: 33.75, y: 49.5, scale: 1.08 },
  island: { x: 124, y: 51, scale: 1.08 },
};

const MESSAGE_SHARED_LEADING: SharedLeadingMotion = {
  notch: { x: -68.5, y: 49.5, scale: 35 / COMPACT_LEADING_SIZE },
  island: { x: -151, y: 51, scale: 38 / COMPACT_LEADING_SIZE },
};

const APPROVAL_SHARED_LEADING: SharedLeadingMotion = {
  notch: { x: 10.5, y: 43.5, scale: 35 / COMPACT_LEADING_SIZE },
  island: { x: -87, y: 41, scale: 38 / COMPACT_LEADING_SIZE },
};

export function OpenBotDynamicIsland(props: OpenBotDynamicIslandProps): JSX.Element {
  function changeState(next: DynamicIslandViewState, reason: DynamicIslandStateChangeReason): void {
    if (props.presentation.mode === "idle" && next === "expanded") {
      void props.onAction({ type: "open-app" });
      return;
    }
    props.onStateChange(next, reason);
  }

  return (
    <OpenBotDynamicIslandFrame
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
      compactWidth={props.presentation.mode === "question" ? "wide" : "standard"}
      panelWidth={props.presentation.mode === "question" || props.presentation.mode === "message" ? "wide" : "standard"}
      sharedLeading={
        props.presentation.mode === "working"
          ? WORKING_SHARED_LEADING
          : props.presentation.mode === "message"
            ? MESSAGE_SHARED_LEADING
            : props.presentation.mode === "question"
              ? QUESTION_SHARED_LEADING
              : props.presentation.mode === "approval"
                ? APPROVAL_SHARED_LEADING
                : undefined
      }
      sharedTrailing={props.presentation.mode === "question" ? QUESTION_SHARED_TRAILING : undefined}
      autoExpand={props.presentation.mode !== "idle"}
      hoverContentMotion={OPENBOT_COMPACT_HOVER_MOTION}
      class={
        props.presentation.mode === "question"
          ? "dynamic-island-question"
          : props.presentation.mode === "idle"
            ? "dynamic-island-idle"
            : props.presentation.mode === "message"
              ? "dynamic-island-message-first"
              : props.presentation.mode === "working"
                ? "dynamic-island-working"
                : props.presentation.mode === "approval"
                  ? "dynamic-island-approval"
                  : undefined
      }
      compactLeading={<CompactLeading presentation={props.presentation} />}
      compactTrailing={<CompactTrailing presentation={props.presentation} />}
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

function OpenBotDynamicIslandFrame(props: OpenBotDynamicIslandFrameProps): JSX.Element {
  const sharedLeading = () => props.sharedLeading?.[props.displayMode === "island" ? "island" : "notch"];
  const sharedTrailing = () => props.sharedTrailing?.[props.displayMode === "island" ? "island" : "notch"];
  return (
    <DynamicIsland
      label={props.label}
      tone={props.tone}
      state={props.state}
      displayMode={props.displayMode}
      onStateChange={props.onStateChange}
      hoverBehavior={props.autoExpand === false ? "grow" : "expand"}
      hoverContentMotion={props.hoverContentMotion ?? OPENBOT_COMPACT_HOVER_MOTION}
      pointerToggle={props.autoExpand === false ? undefined : false}
      contentMotion="spring"
      sharedLeadingMotion={Boolean(props.sharedLeading)}
      sharedLeadingExpandedX={sharedLeading()?.x}
      sharedLeadingExpandedY={sharedLeading()?.y}
      sharedLeadingExpandedScale={sharedLeading()?.scale}
      sharedTrailingMotion={Boolean(props.sharedTrailing)}
      sharedTrailingExpandedX={sharedTrailing()?.x}
      sharedTrailingExpandedY={sharedTrailing()?.y}
      sharedTrailingExpandedScale={sharedTrailing()?.scale}
      class={[
        props.class,
        props.compactWidth === "wide" ? "dynamic-island-compact-wide" : undefined,
        props.panelWidth === "wide" ? "dynamic-island-panel-wide" : undefined,
        props.displayMode === "island" ? "dynamic-island-external" : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
      compactLeading={props.compactLeading}
      compactTrailing={props.compactTrailing}
      expandedContent={props.expandedContent}
    />
  );
}

function CompactLeading(props: { presentation: DynamicIslandPresentation }): JSX.Element {
  const key = () => compactLeadingKey(props.presentation);
  return (
    <IslandContentSwap contentKey={key()} class="dynamic-island-surface-compact-swap">
      <Switch
        fallback={
          <span class="dynamic-island-surface-leading-anchor">
            <AppLogo variant="production" animation="blink" class="dynamic-island-surface-logo" />
          </span>
        }
      >
        <Match when={props.presentation.mode === "working"}>
          <span class="dynamic-island-surface-leading-anchor">
            <span class="dynamic-island-surface-avatar-stack">
              <For each={COMPACT_INDICES}>
                {(index) => (
                  <Show when={props.presentation.working[index]}>{(item) => <IslandAvatar bot={item().bot} />}</Show>
                )}
              </For>
            </span>
          </span>
        </Match>
        <Match when={props.presentation.mode === "message" && props.presentation.message}>
          {(message) => (
            <span class="dynamic-island-surface-leading-anchor dynamic-island-surface-compact-identity">
              <IslandAvatar bot={message().bot} />
              <span class="dynamic-island-surface-compact-name" data-island-motion-content>
                {message().bot.name}
              </span>
            </span>
          )}
        </Match>
        <Match when={props.presentation.mode === "question" && props.presentation.attention[0]}>
          {(item) => (
            <span class="dynamic-island-surface-leading-anchor dynamic-island-surface-compact-identity">
              <IslandAvatar bot={item().bot} />
              <span class="dynamic-island-surface-compact-name" data-island-motion-content>
                {item().bot.name}
              </span>
            </span>
          )}
        </Match>
        <Match when={props.presentation.mode === "approval" && props.presentation.attention[0]}>
          {(item) => (
            <span class="dynamic-island-surface-leading-anchor dynamic-island-surface-compact-identity">
              <IslandAvatar bot={item().bot} />
              <span class="dynamic-island-surface-compact-name" data-island-motion-content>
                {item().bot.name}
              </span>
            </span>
          )}
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
          <span class="dynamic-island-surface-count" data-island-motion-content>
            {props.presentation.activeCount}
          </span>
        </Match>
        <Match when={props.presentation.mode === "message"}>
          <Badge
            variant="info-light"
            class="dynamic-island-surface-message-badge"
            data-island-motion-content
            aria-hidden="true"
          >
            <MessageCircle
              data-icon="inline-start"
              class="dynamic-island-surface-message-badge-icon"
              aria-hidden="true"
            />
            <span>Message</span>
          </Badge>
        </Match>
        <Match when={props.presentation.mode === "question"}>
          <Badge variant="info-light" class="dynamic-island-surface-question-badge" data-island-motion-content>
            <MessageCircleQuestionMark
              data-icon="inline-start"
              class="dynamic-island-surface-question-badge-icon"
              aria-hidden="true"
            />
            <span>Questions</span>
          </Badge>
        </Match>
        <Match when={props.presentation.mode === "approval"}>
          <Badge
            variant="warning-light"
            class="dynamic-island-surface-approval-badge"
            data-island-motion-content
            aria-hidden="true"
          >
            <Check data-icon="inline-start" class="dynamic-island-surface-approval-badge-icon" aria-hidden="true" />
            <span>Approve</span>
          </Badge>
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
                      <Show when={index === 0} fallback={<IslandAvatar bot={item().bot} />}>
                        <span class="dynamic-island-surface-working-avatar-slot" aria-hidden="true" />
                      </Show>
                      <IslandContentSwap contentKey={`${item().bot.id}:${item().task}`}>
                        <span class="dynamic-island-surface-row-copy" data-island-motion-content>
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
          <article class="dynamic-island-message-first-panel">
            <div class="dynamic-island-message-first-summary">
              <span class="dynamic-island-message-first-avatar-slot" aria-hidden="true" />
              <div class="dynamic-island-message-first-copy" data-island-motion-content>
                <header class="dynamic-island-message-first-heading">
                  <h1>
                    <span>{message().bot.name}</span>
                    <small>replied</small>
                  </h1>
                  <time datetime={message().createdAt}>now</time>
                </header>
                <IslandContentSwap contentKey={message().messageId} block>
                  <p>{message().text}</p>
                </IslandContentSwap>
              </div>
            </div>
            <footer class="dynamic-island-message-first-footer" data-island-motion-content>
              <span class="dynamic-island-message-first-unread">{props.presentation.unreadCount} unread</span>
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
            </footer>
          </article>
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
  const [questionTransitioning, setQuestionTransitioning] = createSignal(false);
  const [questionLineLayout, setQuestionLineLayout] = createSignal<"single" | "multiple">("multiple");
  let questionPrompt: HTMLParagraphElement | undefined;
  let questionStep: HTMLDivElement | undefined;
  let questionAnimations: Animation[] = [];
  let questionDisposed = false;
  let questionTransitionVersion = 0;
  createEffect(
    () => `${props.item.id}:${props.item.questions?.map((question) => question.id).join(",") ?? ""}`,
    () => {
      questionTransitionVersion += 1;
      cancelQuestionAnimations();
      clearQuestionHidden(questionTransitionElements());
      setQuestionTransitioning(false);
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
  const openInOpenBot = () =>
    props.onAction({
      type: "review-attention",
      serverId: props.serverId,
      botId: props.item.bot.id,
      requestId: props.item.requestId,
    });

  function answerWith(label: string): void {
    const question = currentQuestion();
    if (!question || !directAnswerAvailable() || questionTransitioning()) return;
    const nextAnswers = { ...answers(), [question.id]: [label] };
    if (questionIndex() < questions().length - 1) {
      void showNextQuestion(nextAnswers);
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

  async function showNextQuestion(nextAnswers: Record<string, string[]>): Promise<void> {
    const elements = questionTransitionElements();
    if (elements.length === 0) {
      setAnswers(nextAnswers);
      setQuestionIndex((index) => index + 1);
      return;
    }

    setQuestionTransitioning(true);
    const transitionVersion = ++questionTransitionVersion;
    const exitAnimations = animateQuestionElements(elements, "exit");
    if (!exitAnimations) {
      setAnswers(nextAnswers);
      setQuestionIndex((index) => index + 1);
      setQuestionTransitioning(false);
      return;
    }
    questionAnimations = exitAnimations;
    await waitForQuestionAnimations(questionAnimations);
    if (questionDisposed || transitionVersion !== questionTransitionVersion) return;
    setQuestionHidden(elements);
    cancelQuestionAnimations();
    setAnswers(nextAnswers);
    setQuestionIndex((index) => index + 1);
    await nextAnimationFrame();
    if (questionDisposed || transitionVersion !== questionTransitionVersion) return;
    questionAnimations = animateQuestionElements(elements, "enter") ?? [];
    await waitForQuestionAnimations(questionAnimations);
    if (questionDisposed || transitionVersion !== questionTransitionVersion) return;
    clearQuestionHidden(elements);
    cancelQuestionAnimations();
    setQuestionTransitioning(false);
  }

  function questionTransitionElements(): HTMLElement[] {
    const elements: Array<HTMLElement | undefined> = [questionPrompt, questionStep];
    return elements.filter((element): element is HTMLElement => element !== undefined);
  }

  function cancelQuestionAnimations(): void {
    for (const animation of questionAnimations) animation.cancel();
    questionAnimations = [];
  }

  onCleanup(() => {
    questionDisposed = true;
    questionTransitionVersion += 1;
    cancelQuestionAnimations();
    clearQuestionHidden(questionTransitionElements());
  });

  onSettled(() => {
    const prompt = questionPrompt;
    if (!prompt) return;
    const updateLineLayout = (): void => {
      const lineHeight = Number.parseFloat(getComputedStyle(prompt).lineHeight);
      if (!Number.isFinite(lineHeight)) return;
      setQuestionLineLayout(prompt.getBoundingClientRect().height < lineHeight * 1.5 ? "single" : "multiple");
    };
    const observer = new ResizeObserver(updateLineLayout);
    observer.observe(prompt);
    updateLineLayout();
    return () => observer.disconnect();
  });

  return (
    <Show
      when={props.item.kind === "prompt"}
      fallback={
        <div class="dynamic-island-surface-panel dynamic-island-surface-attention-panel">
          <div class="dynamic-island-surface-approval-summary">
            <span
              class="dynamic-island-surface-shared-leading-slot dynamic-island-surface-approval-avatar-slot"
              aria-hidden="true"
            />
            <div class="dynamic-island-surface-approval-copy" data-island-motion-content>
              <h1>{props.item.bot.name} needs approval</h1>
              <p>{props.item.approval?.reason ?? props.item.detail ?? "Review the requested action before it runs."}</p>
            </div>
          </div>
          <IslandContentSwap contentKey={`${props.item.id}:${props.item.detail ?? ""}`} block>
            <div class="dynamic-island-surface-request-copy" data-island-motion-content>
              <ApprovalContext item={props.item} />
              <Show when={props.remainingCount > 0}>
                <small class="dynamic-island-surface-more">
                  +{props.remainingCount} more {props.remainingCount === 1 ? "request" : "requests"}
                </small>
              </Show>
            </div>
          </IslandContentSwap>
          <div class="dynamic-island-surface-actions" data-island-motion-content>
            <Button size="sm" variant="ghost" onClick={openInOpenBot}>
              Review in OpenBot
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
          <div
            class="dynamic-island-surface-question-copy"
            data-question-lines={questionLineLayout()}
            data-island-motion-content
          >
            <header class="dynamic-island-surface-question-heading">
              <h1>
                <span class="dynamic-island-surface-question-bot-name">{props.item.bot.name}</span>
                <span class="dynamic-island-surface-question-asks">asks</span>
              </h1>
            </header>
            <p ref={questionPrompt} class="dynamic-island-surface-question-prompt">
              {questionText()}
            </p>
          </div>
          <Show when={directAnswerAvailable() && questions().length > 1}>
            <span data-island-motion-content>
              <QuestionProgress current={questionIndex() + 1} total={questions().length} />
            </span>
          </Show>
        </div>
        <div data-island-motion-content>
          <div ref={questionStep} class="dynamic-island-surface-question-step">
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
        </div>
        <div class="dynamic-island-surface-actions dynamic-island-surface-question-actions" data-island-motion-content>
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

function QuestionProgress(props: { current: number; total: number }): JSX.Element {
  let stack: HTMLSpanElement | undefined;
  let currentDigit: HTMLSpanElement | undefined;
  let outgoingDigit: HTMLSpanElement | undefined;
  let previous = props.current;
  let transitionVersion = 0;
  let animations: Animation[] = [];

  const cancelTransition = (): void => {
    for (const animation of animations) animation.cancel();
    animations = [];
    outgoingDigit?.remove();
    outgoingDigit = undefined;
  };

  createEffect(
    () => props.current,
    (current) => {
      const outgoing = previous;
      previous = current;
      if (current === outgoing || !stack || !currentDigit) return;

      const version = ++transitionVersion;
      cancelTransition();
      const direction = current > outgoing ? 1 : -1;
      outgoingDigit = document.createElement("span");
      outgoingDigit.className = "dynamic-island-surface-question-progress-digit is-outgoing";
      outgoingDigit.textContent = String(outgoing);
      outgoingDigit.setAttribute("aria-hidden", "true");
      stack.prepend(outgoingDigit);

      const animateOutgoing = outgoingDigit.animate?.bind(outgoingDigit);
      const animateCurrent = currentDigit.animate?.bind(currentDigit);
      if (!animateOutgoing || !animateCurrent) {
        cancelTransition();
        return;
      }

      const visibleFrame: Keyframe = { opacity: 1, filter: "blur(0px)", transform: "translateY(0)" };
      const hiddenOpacity = 0.35;
      animations = [
        animateOutgoing(
          [
            visibleFrame,
            {
              opacity: hiddenOpacity,
              filter: `blur(${QUESTION_PROGRESS_BLUR}px)`,
              transform: `translateY(${direction * -70}%)`,
            },
          ],
          {
            duration: QUESTION_PROGRESS_DURATION,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            fill: "both",
          },
        ),
        animateCurrent(
          [
            {
              opacity: hiddenOpacity,
              filter: `blur(${QUESTION_PROGRESS_BLUR}px)`,
              transform: `translateY(${direction * 70}%)`,
            },
            visibleFrame,
          ],
          {
            duration: QUESTION_PROGRESS_DURATION,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            fill: "both",
          },
        ),
      ];

      void waitForQuestionAnimations(animations).then(() => {
        if (version !== transitionVersion) return;
        cancelTransition();
      });
    },
  );

  onCleanup(() => {
    transitionVersion += 1;
    cancelTransition();
  });

  return (
    <span class="dynamic-island-surface-question-progress">
      <span class="sr-only">
        Question {props.current} of {props.total}
      </span>
      <span ref={stack} class="dynamic-island-surface-question-progress-stack" aria-hidden="true">
        <span ref={currentDigit} class="dynamic-island-surface-question-progress-digit">
          {props.current}
        </span>
      </span>
      <span aria-hidden="true"> / {props.total}</span>
    </span>
  );
}

type QuestionSwapPhase = "exit" | "enter";

function animateQuestionElements(elements: HTMLElement[], phase: QuestionSwapPhase): Animation[] | undefined {
  const entering = phase === "enter";
  const hiddenFrame: Keyframe = {
    opacity: QUESTION_SWAP_MIDPOINT_OPACITY,
    filter: `blur(${QUESTION_SWAP_BLUR}px)`,
    transform: "none",
  };
  const visibleFrame: Keyframe = { opacity: 1, filter: "blur(0px)", transform: "none" };
  const animations: Animation[] = [];
  for (const element of elements) {
    const animate = element.animate?.bind(element);
    if (!animate) {
      for (const animation of animations) animation.cancel();
      return undefined;
    }
    animations.push(
      animate(entering ? [hiddenFrame, visibleFrame] : [visibleFrame, hiddenFrame], {
        duration: entering ? QUESTION_SWAP_ENTER_DURATION : QUESTION_SWAP_EXIT_DURATION,
        easing: entering ? "cubic-bezier(0.22, 1, 0.36, 1)" : "cubic-bezier(0.4, 0, 0.6, 1)",
        fill: "both",
      }),
    );
  }
  return animations;
}

function waitForQuestionAnimations(animations: Animation[]): Promise<undefined[]> {
  return Promise.all(animations.map((animation) => animation.finished.then(() => undefined).catch(() => undefined)));
}

function setQuestionHidden(elements: HTMLElement[]): void {
  for (const element of elements) {
    element.style.opacity = String(QUESTION_SWAP_MIDPOINT_OPACITY);
    element.style.filter = `blur(${QUESTION_SWAP_BLUR}px)`;
    element.style.transform = "none";
  }
}

function clearQuestionHidden(elements: HTMLElement[]): void {
  for (const element of elements) {
    element.style.removeProperty("opacity");
    element.style.removeProperty("filter");
    element.style.removeProperty("transform");
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function ApprovalContext(props: { item: DynamicIslandAttentionItem }): JSX.Element {
  return (
    <Show when={props.item.kind === "approval" && props.item.approval}>
      {(approval) => (
        <>
          <Show when={approval().command}>
            {(command) => (
              <div class="dynamic-island-surface-command">
                <div class="dynamic-island-surface-command-meta">
                  <small>Command</small>
                  <Show when={approval().cwd}>{(cwd) => <span>{cwd()}</span>}</Show>
                </div>
                <code title={command()}>{command()}</code>
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
      data-island-motion-content
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

function IslandAvatar(props: { bot: DynamicIslandBotIdentity }): JSX.Element {
  return (
    <AgentAvatar
      bot={props.bot}
      motion="idle"
      ignoreReducedMotion
      shape="cercle"
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
