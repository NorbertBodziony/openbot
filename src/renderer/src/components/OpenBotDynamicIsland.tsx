import { AppLogo } from "@openbot/brand";
import type {
  DynamicIslandAction,
  DynamicIslandAttentionItem,
  DynamicIslandBotIdentity,
  DynamicIslandPresentation,
} from "@openbot/contracts/ipc";
import { Dynamic, type JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { AgentAvatar } from "./AgentAvatar";
import {
  Badge,
  Button,
  Check,
  DynamicIsland,
  type DynamicIslandHoverContentMotion,
  DynamicIslandIdentity,
  type DynamicIslandStateChangeReason,
  type DynamicIslandViewState,
  MessageCircle,
  MessageCircleQuestionMark,
} from "./ui";

export interface OpenBotDynamicIslandProps {
  presentation: DynamicIslandPresentation;
  state: DynamicIslandViewState;
  displayMode?: "notch" | "island";
  suppressInitialHover?: boolean;
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
const MODE_SWAP_EXIT_DURATION = 160;
const MODE_SWAP_ENTER_DELAY = 40;
const MODE_SWAP_ENTER_DURATION = 240;
const MODE_SWAP_REDUCED_DURATION = 120;
const MODE_SWAP_BLUR = 4;
const MODE_SWAP_OUTGOING_SCALE = 0.985;
const MODE_SWAP_INCOMING_SCALE = 0.965;
const MODE_SWAP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const STATUS_COMPACT_BASE_WIDTH = { notch: 412, island: 280 } as const;
const STATUS_COMPACT_NOTCH_WIDTH = 192;
const STATUS_COMPACT_AVATAR_WIDTH = 20;
const STATUS_COMPACT_IDENTITY_GAP = 6;
const STATUS_COMPACT_NOTCH_EDGE_PADDING = 12;
const STATUS_COMPACT_ISLAND_INLINE_PADDING = 8;
const STATUS_COMPACT_BADGE_CHROME_WIDTH = 32;
const STATUS_COMPACT_NOTCH_MIN_WIDTH = 360;
const STATUS_COMPACT_ISLAND_MIN_WIDTH = 212;
const STATUS_COMPACT_NAME_MAX_WIDTH = { notch: 72, island: 96 } as const;

interface OpenBotDynamicIslandFrameProps {
  label: string;
  tone: "neutral" | "working" | "attention";
  state: DynamicIslandViewState;
  displayMode?: "notch" | "island";
  suppressInitialHover?: boolean;
  compactLeading: JSX.Element;
  compactTrailing: JSX.Element;
  expandedContent: JSX.Element;
  compactWidth?: number;
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

interface StatusCompactGeometry {
  notch: { width: number };
  island: { width: number };
}

type IslandModeSwapSlot = "compact-leading" | "compact-trailing" | "expanded";

interface CapturedModeLayerState {
  opacity: number;
  scale: number;
  contentBlurs: number[];
}

interface IslandModeSwapProps {
  slot: IslandModeSwapSlot;
  presentation: DynamicIslandPresentation;
  outgoingPresentation: DynamicIslandPresentation | undefined;
  block?: boolean;
  render: (presentation: DynamicIslandPresentation) => JSX.Element;
}

type StatusMode = Extract<DynamicIslandPresentation["mode"], "message" | "question" | "approval">;

interface OpenBotIslandModeConfig {
  label: string;
  tone: OpenBotDynamicIslandFrameProps["tone"];
  className: string;
  panelWidth: NonNullable<OpenBotDynamicIslandFrameProps["panelWidth"]>;
  sharedLeading?: SharedLeadingMotion;
  sharedTrailing?: SharedLeadingMotion;
  autoExpand: boolean;
  status: boolean;
}

const WORKING_SHARED_LEADING: SharedLeadingMotion = {
  notch: { x: -58, y: 76, scale: 32 / COMPACT_LEADING_SIZE },
  island: { x: -86, y: 76, scale: 32 / COMPACT_LEADING_SIZE },
};

const QUESTION_SHARED_LEADING: SharedLeadingMotion = {
  notch: { x: -54.5, y: 49.5, scale: 35 / COMPACT_LEADING_SIZE },
  island: { x: -115, y: 51, scale: 38 / COMPACT_LEADING_SIZE },
};

const STATUS_SHARED_TRAILING: SharedLeadingMotion = {
  notch: { x: 33.75, y: 49.5, scale: 1.08 },
  island: { x: 124, y: 51, scale: 1.08 },
};

const OPENBOT_ISLAND_MODE_CONFIG: Record<DynamicIslandPresentation["mode"], OpenBotIslandModeConfig> = {
  idle: {
    label: "Open OpenBot",
    tone: "neutral",
    className: "dynamic-island-idle",
    panelWidth: "standard",
    autoExpand: false,
    status: false,
  },
  working: {
    label: "OpenBot working status",
    tone: "working",
    className: "dynamic-island-working",
    panelWidth: "standard",
    sharedLeading: WORKING_SHARED_LEADING,
    autoExpand: true,
    status: false,
  },
  message: {
    label: "OpenBot chat update",
    tone: "neutral",
    className: "dynamic-island-message-first",
    panelWidth: "wide",
    sharedLeading: QUESTION_SHARED_LEADING,
    sharedTrailing: STATUS_SHARED_TRAILING,
    autoExpand: true,
    status: true,
  },
  question: {
    label: "OpenBot question from AI",
    tone: "neutral",
    className: "dynamic-island-question",
    panelWidth: "wide",
    sharedLeading: QUESTION_SHARED_LEADING,
    sharedTrailing: STATUS_SHARED_TRAILING,
    autoExpand: true,
    status: true,
  },
  approval: {
    label: "OpenBot approval request",
    tone: "attention",
    className: "dynamic-island-approval",
    panelWidth: "wide",
    sharedLeading: QUESTION_SHARED_LEADING,
    sharedTrailing: STATUS_SHARED_TRAILING,
    autoExpand: true,
    status: true,
  },
};

const STATUS_BADGE_CONFIG = {
  message: {
    label: "Message",
    variant: "info-light",
    icon: MessageCircle,
    className: "dynamic-island-surface-message-badge",
  },
  question: {
    label: "Questions",
    variant: "info-light",
    icon: MessageCircleQuestionMark,
    className: "dynamic-island-surface-question-badge",
  },
  approval: {
    label: "Approve",
    variant: "warning-light",
    icon: Check,
    className: "dynamic-island-surface-approval-badge",
  },
} as const;

function compactStatusGeometry(presentation: DynamicIslandPresentation): StatusCompactGeometry | undefined {
  const mode = statusMode(presentation.mode);
  const bot = compactStatusBot(presentation);
  if (!mode || !bot) return undefined;

  const badgeLabel = STATUS_BADGE_CONFIG[mode].label;
  const badgeWidth = Math.ceil(measureCompactText(badgeLabel, 600) + STATUS_COMPACT_BADGE_CHROME_WIDTH);
  const measuredNameWidth = measureCompactText(bot.name, 500);
  const notchNameWidth = Math.min(STATUS_COMPACT_NAME_MAX_WIDTH.notch, Math.ceil(measuredNameWidth));
  const islandNameWidth = Math.min(STATUS_COMPACT_NAME_MAX_WIDTH.island, Math.ceil(measuredNameWidth));
  const notchLeadingWidth =
    STATUS_COMPACT_NOTCH_EDGE_PADDING + STATUS_COMPACT_AVATAR_WIDTH + STATUS_COMPACT_IDENTITY_GAP + notchNameWidth;
  const notchTrailingWidth = STATUS_COMPACT_NOTCH_EDGE_PADDING + badgeWidth;
  const notchWidth = clampCompactWidth(
    STATUS_COMPACT_NOTCH_WIDTH + 2 * Math.max(notchLeadingWidth, notchTrailingWidth),
    STATUS_COMPACT_NOTCH_MIN_WIDTH,
    STATUS_COMPACT_BASE_WIDTH.notch,
  );
  const islandSideWidth = Math.max(
    STATUS_COMPACT_AVATAR_WIDTH + STATUS_COMPACT_IDENTITY_GAP + islandNameWidth,
    badgeWidth,
  );
  const islandWidth = clampCompactWidth(
    STATUS_COMPACT_ISLAND_INLINE_PADDING * 2 + islandSideWidth * 2,
    STATUS_COMPACT_ISLAND_MIN_WIDTH,
    STATUS_COMPACT_BASE_WIDTH.island,
  );

  return { notch: { width: notchWidth }, island: { width: islandWidth } };
}

function adjustSharedMotion(
  motion: SharedLeadingMotion,
  geometry: StatusCompactGeometry,
  side: "leading" | "trailing",
): SharedLeadingMotion {
  const direction = side === "leading" ? -1 : 1;
  return {
    notch: {
      ...motion.notch,
      x: motion.notch.x + direction * ((STATUS_COMPACT_BASE_WIDTH.notch - geometry.notch.width) / 2),
    },
    island: {
      ...motion.island,
      x: motion.island.x + direction * ((STATUS_COMPACT_BASE_WIDTH.island - geometry.island.width) / 2),
    },
  };
}

function clampCompactWidth(width: number, minimum: number, maximum: number): number {
  const evenWidth = Math.ceil(width / 2) * 2;
  return Math.min(maximum, Math.max(minimum, evenWidth));
}

function measureCompactText(text: string, weight: number): number {
  const hasCanvas = !navigator.userAgent.includes("jsdom");
  if (hasCanvas) {
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (context) {
        context.font = `${weight} 11px Inter, -apple-system, BlinkMacSystemFont, sans-serif`;
        return context.measureText(text).width;
      }
    } catch {
      // Test renderers can omit the Canvas 2D context. The estimate below keeps geometry deterministic.
    }
  }
  return Array.from(text).reduce((width, character) => {
    if (character === " ") return width + 3;
    if (/[ilI1.,'`]/.test(character)) return width + 3.5;
    if (/[mwMW@%]/.test(character)) return width + 8.5;
    return width + 6;
  }, 0);
}

export function OpenBotDynamicIsland(props: OpenBotDynamicIslandProps): JSX.Element {
  const config = () => OPENBOT_ISLAND_MODE_CONFIG[props.presentation.mode];
  const [visiblePresentation, setVisiblePresentation] = createSignal(untrack(() => props.presentation));
  const [outgoingPresentation, setOutgoingPresentation] = createSignal<DynamicIslandPresentation>();
  const [modeTransitioning, setModeTransitioning] = createSignal(false);
  let transitionRoot: HTMLDivElement | undefined;
  let modeAnimations: Animation[] = [];
  let modeTransitionVersion = 0;
  let modeTransitionFrame: number | undefined;
  let modeTransitionDisposed = false;
  const compactGeometry = createMemo(() => compactStatusGeometry(visiblePresentation()));
  const compactWidth = () => {
    const geometry = compactGeometry();
    if (!geometry) return undefined;
    return props.displayMode === "island" ? geometry.island.width : geometry.notch.width;
  };
  const sharedLeading = createMemo(() => {
    const motion = config().sharedLeading;
    const geometry = compactGeometry();
    if (!motion || !geometry || !config().status) return motion;
    return adjustSharedMotion(motion, geometry, "leading");
  });
  const sharedTrailing = createMemo(() => {
    const motion = config().sharedTrailing;
    const geometry = compactGeometry();
    if (!motion || !geometry || !config().status) return motion;
    return adjustSharedMotion(motion, geometry, "trailing");
  });

  createEffect(
    () => ({ nextPresentation: props.presentation, currentPresentation: visiblePresentation() }),
    ({ nextPresentation, currentPresentation }) => {
      if (nextPresentation.mode === currentPresentation.mode) {
        setVisiblePresentation(nextPresentation);
        return;
      }

      const capturedLayers = captureModeLayerStates(transitionRoot);
      restoreModeTransitionFocus(transitionRoot);
      cancelModeTransition();
      const transitionVersion = ++modeTransitionVersion;
      setOutgoingPresentation(currentPresentation);
      setVisiblePresentation(nextPresentation);
      setModeTransitioning(true);

      modeTransitionFrame = requestAnimationFrame(() => {
        modeTransitionFrame = undefined;
        if (modeTransitionDisposed || transitionVersion !== modeTransitionVersion) return;
        modeAnimations = animateModeLayers(transitionRoot, capturedLayers, prefersReducedMotion());
        if (modeAnimations.length === 0) {
          finishModeTransition(transitionVersion);
          return;
        }
        void waitForAnimations(modeAnimations).then(() => finishModeTransition(transitionVersion));
      });
    },
  );

  function cancelModeTransition(): void {
    if (modeTransitionFrame !== undefined) {
      cancelAnimationFrame(modeTransitionFrame);
      modeTransitionFrame = undefined;
    }
    for (const animation of modeAnimations) animation.cancel();
    modeAnimations = [];
  }

  function finishModeTransition(version: number): void {
    if (modeTransitionDisposed || version !== modeTransitionVersion) return;
    cancelModeTransition();
    setOutgoingPresentation(undefined);
    setModeTransitioning(false);
  }

  onCleanup(() => {
    modeTransitionDisposed = true;
    modeTransitionVersion += 1;
    cancelModeTransition();
  });

  function changeState(next: DynamicIslandViewState, reason: DynamicIslandStateChangeReason): void {
    if (props.presentation.mode === "idle" && next === "expanded") {
      void props.onAction({ type: "open-app" });
      return;
    }
    props.onStateChange(next, reason);
  }

  return (
    <div
      ref={transitionRoot}
      class="openbot-dynamic-island-transition-root"
      data-mode-transitioning={modeTransitioning() ? "true" : undefined}
    >
      <OpenBotDynamicIslandFrame
        label={`${config().label}${props.displayMode === "island" ? " on external display" : ""}`}
        tone={config().tone}
        state={props.state}
        displayMode={props.displayMode}
        suppressInitialHover={props.suppressInitialHover}
        onStateChange={changeState}
        compactWidth={compactWidth()}
        panelWidth={config().panelWidth}
        sharedLeading={sharedLeading()}
        sharedTrailing={sharedTrailing()}
        autoExpand={config().autoExpand}
        hoverContentMotion={OPENBOT_COMPACT_HOVER_MOTION}
        class={[config().className, config().status ? "dynamic-island-status" : undefined].filter(Boolean).join(" ")}
        compactLeading={
          <IslandModeSwap
            slot="compact-leading"
            presentation={visiblePresentation()}
            outgoingPresentation={outgoingPresentation()}
            render={(presentation) => <CompactLeading presentation={presentation} displayMode={props.displayMode} />}
          />
        }
        compactTrailing={
          <IslandModeSwap
            slot="compact-trailing"
            presentation={visiblePresentation()}
            outgoingPresentation={outgoingPresentation()}
            render={(presentation) => <CompactTrailing presentation={presentation} />}
          />
        }
        expandedContent={
          <IslandModeSwap
            slot="expanded"
            presentation={visiblePresentation()}
            outgoingPresentation={outgoingPresentation()}
            block
            render={(presentation) => (
              <ExpandedContent
                presentation={presentation}
                displayMode={props.displayMode}
                onAction={props.onAction}
                onLater={() => {
                  props.onLater();
                  props.onStateChange("compact", "pointer");
                }}
              />
            )}
          />
        }
      />
    </div>
  );
}

function IslandModeSwap(props: IslandModeSwapProps): JSX.Element {
  return (
    <Dynamic
      component={props.block ? "div" : "span"}
      class={["dynamic-island-mode-swap", props.block ? "dynamic-island-mode-swap-block" : undefined]
        .filter(Boolean)
        .join(" ")}
      data-island-mode-slot={props.slot}
    >
      <Dynamic
        component={props.block ? "div" : "span"}
        class="dynamic-island-mode-layer"
        data-island-mode-layer="incoming"
        data-island-mode={props.presentation.mode}
      >
        {props.render(props.presentation)}
      </Dynamic>
      <Show when={props.outgoingPresentation}>
        {(outgoing) => (
          <Dynamic
            component={props.block ? "div" : "span"}
            class="dynamic-island-mode-layer dynamic-island-mode-layer-outgoing"
            data-island-mode-layer="outgoing"
            data-island-mode={outgoing().mode}
            aria-hidden="true"
            inert={true}
          >
            {props.render(outgoing())}
          </Dynamic>
        )}
      </Show>
    </Dynamic>
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
      suppressInitialHover={props.suppressInitialHover}
      compactWidth={props.compactWidth}
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

function CompactLeading(props: {
  presentation: DynamicIslandPresentation;
  displayMode?: "notch" | "island";
}): JSX.Element {
  const key = () => compactLeadingKey(props.presentation);
  const statusBot = () => compactStatusBot(props.presentation);
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
        <Match when={statusBot()}>{(bot) => <CompactBotIdentity bot={bot()} displayMode={props.displayMode} />}</Match>
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
        <Match when={statusMode(props.presentation.mode)}>{(mode) => <CompactStatusBadge mode={mode()} />}</Match>
        <Match when={props.presentation.mode === "idle"}>
          <IdleGreetingEmoji />
        </Match>
      </Switch>
    </IslandContentSwap>
  );
}

function CompactBotIdentity(props: { bot: DynamicIslandBotIdentity; displayMode?: "notch" | "island" }): JSX.Element {
  const nameMaxWidth = () =>
    props.displayMode === "island" ? STATUS_COMPACT_NAME_MAX_WIDTH.island : STATUS_COMPACT_NAME_MAX_WIDTH.notch;
  return (
    <span class="dynamic-island-surface-leading-anchor dynamic-island-surface-compact-identity">
      <IslandAvatar bot={props.bot} />
      <span
        class="dynamic-island-surface-compact-name"
        style={{ "max-width": `${nameMaxWidth()}px` }}
        data-island-motion-content
      >
        {props.bot.name}
      </span>
    </span>
  );
}

function CompactStatusBadge(props: { mode: StatusMode }): JSX.Element {
  const config = () => STATUS_BADGE_CONFIG[props.mode];
  return (
    <Badge
      variant={config().variant}
      class={["dynamic-island-surface-status-badge", config().className].join(" ")}
      data-island-motion-content
      aria-hidden="true"
    >
      <Dynamic
        component={config().icon}
        data-icon="inline-start"
        class="dynamic-island-surface-status-badge-icon"
        aria-hidden="true"
      />
      <span>{config().label}</span>
    </Badge>
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
                    <Button
                      variant="ghost"
                      class="dynamic-island-surface-row dynamic-island-surface-animated-row"
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
                    </Button>
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
            <IslandContentSwap contentKey={message().messageId} block>
              <DynamicIslandIdentity
                name={message().bot.name}
                status="replied"
                description={message().text}
                trailing={<time datetime={message().createdAt}>now</time>}
              />
            </IslandContentSwap>
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
  let questionPrompt: HTMLSpanElement | undefined;
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

  return (
    <Show
      when={props.item.kind === "prompt"}
      fallback={
        <div class="dynamic-island-surface-panel dynamic-island-surface-attention-panel">
          <DynamicIslandIdentity
            name={props.item.bot.name}
            status="needs approval"
            description={
              props.item.approval?.reason ?? props.item.detail ?? "Review the requested action before it runs."
            }
          />
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
        <DynamicIslandIdentity
          name={props.item.bot.name}
          status="asks"
          description={questionText()}
          descriptionRef={(element) => {
            questionPrompt = element;
          }}
          trailing={
            <Show when={directAnswerAvailable() && questions().length > 1}>
              <QuestionProgress current={questionIndex() + 1} total={questions().length} />
            </Show>
          }
        />
        <div data-island-motion-content>
          <div ref={questionStep} class="dynamic-island-surface-question-step">
            <Show when={directAnswerAvailable()}>
              <ul class="dynamic-island-surface-question-options" aria-label="Suggested answers">
                <For each={currentQuestion()?.options ?? []}>
                  {(option, index) => (
                    <li>
                      <Button
                        variant="ghost"
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
                      </Button>
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

function compactStatusBot(presentation: DynamicIslandPresentation): DynamicIslandBotIdentity | undefined {
  if (presentation.mode === "message") return presentation.message?.bot;
  if (presentation.mode === "question" || presentation.mode === "approval") {
    return presentation.attention[0]?.bot;
  }
  return undefined;
}

function statusMode(mode: DynamicIslandPresentation["mode"]): StatusMode | undefined {
  return mode === "message" || mode === "question" || mode === "approval" ? mode : undefined;
}

function compactTrailingKey(presentation: DynamicIslandPresentation): string {
  if (presentation.mode === "working") return `working:${presentation.activeCount}`;
  if (presentation.mode === "message" || presentation.mode === "question" || presentation.mode === "approval") {
    return presentation.mode;
  }
  return "idle";
}

function captureModeLayerStates(root: HTMLElement | undefined): Map<string, CapturedModeLayerState> {
  const captured = new Map<string, CapturedModeLayerState>();
  if (!root) return captured;
  for (const slot of root.querySelectorAll<HTMLElement>("[data-island-mode-slot]")) {
    const slotName = slot.dataset.islandModeSlot;
    if (!slotName) continue;
    for (const layer of slot.querySelectorAll<HTMLElement>(":scope > [data-island-mode-layer]")) {
      const mode = layer.dataset.islandMode;
      if (!mode) continue;
      const style = getComputedStyle(layer);
      const contentBlurs = Array.from(layer.querySelectorAll<HTMLElement>("[data-island-motion-content]"), (content) =>
        readBlur(getComputedStyle(content).filter),
      );
      captured.set(`${slotName}:${mode}`, {
        opacity: readOpacity(style.opacity),
        scale: readScale(style.transform),
        contentBlurs,
      });
    }
  }
  return captured;
}

function restoreModeTransitionFocus(root: HTMLElement | undefined): void {
  if (!root || !(document.activeElement instanceof HTMLElement)) return;
  const activeLayer = document.activeElement.closest<HTMLElement>("[data-island-mode-layer]");
  if (!activeLayer || !root.contains(activeLayer)) return;
  root.querySelector<HTMLButtonElement>(".dynamic-island-toggle")?.focus();
}

function animateModeLayers(
  root: HTMLElement | undefined,
  captured: Map<string, CapturedModeLayerState>,
  reducedMotion: boolean,
): Animation[] {
  if (!root) return [];
  const animations: Animation[] = [];
  for (const slot of root.querySelectorAll<HTMLElement>("[data-island-mode-slot]")) {
    const slotName = slot.dataset.islandModeSlot;
    if (!slotName) continue;
    for (const layer of slot.querySelectorAll<HTMLElement>(":scope > [data-island-mode-layer]")) {
      const role = layer.dataset.islandModeLayer;
      const mode = layer.dataset.islandMode;
      const animate = layer.animate?.bind(layer);
      if (!role || !mode || !animate) continue;
      const previous = captured.get(`${slotName}:${mode}`);
      const outgoing = role === "outgoing";
      const startOpacity = previous?.opacity ?? (outgoing ? 1 : 0);
      const startScale = previous?.scale ?? (outgoing ? 1 : MODE_SWAP_INCOMING_SCALE);
      const endOpacity = outgoing ? 0 : 1;
      const endScale = outgoing ? MODE_SWAP_OUTGOING_SCALE : 1;
      const duration = reducedMotion
        ? MODE_SWAP_REDUCED_DURATION
        : outgoing
          ? MODE_SWAP_EXIT_DURATION
          : MODE_SWAP_ENTER_DURATION;
      const delay = reducedMotion || outgoing ? 0 : MODE_SWAP_ENTER_DELAY;
      animations.push(
        animate(
          reducedMotion
            ? [{ opacity: startOpacity }, { opacity: endOpacity }]
            : [
                { opacity: startOpacity, transform: `scale(${startScale})` },
                { opacity: endOpacity, transform: `scale(${endScale})` },
              ],
          { duration, delay, easing: MODE_SWAP_EASING, fill: "both" },
        ),
      );

      if (reducedMotion) continue;
      const contentElements = layer.querySelectorAll<HTMLElement>("[data-island-motion-content]");
      for (const [index, content] of Array.from(contentElements).entries()) {
        const animateContent = content.animate?.bind(content);
        if (!animateContent) continue;
        const startBlur = previous?.contentBlurs[index] ?? (outgoing ? 0 : MODE_SWAP_BLUR);
        const endBlur = outgoing ? MODE_SWAP_BLUR : 0;
        animations.push(
          animateContent([{ filter: `blur(${startBlur}px)` }, { filter: `blur(${endBlur}px)` }], {
            duration,
            delay,
            easing: MODE_SWAP_EASING,
            fill: "both",
          }),
        );
      }
    }
  }
  return animations;
}

function waitForAnimations(animations: Animation[]): Promise<undefined[]> {
  return Promise.all(animations.map((animation) => animation.finished.then(() => undefined).catch(() => undefined)));
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function readOpacity(value: string): number {
  const opacity = Number.parseFloat(value);
  return Number.isFinite(opacity) ? opacity : 1;
}

function readScale(transform: string): number {
  if (!transform || transform === "none") return 1;
  const matrix = transform.match(/^matrix\(([^)]+)\)$/)?.[1]?.split(",");
  if (!matrix) return 1;
  const scale = Number.parseFloat(matrix[0] ?? "1");
  return Number.isFinite(scale) ? scale : 1;
}

function readBlur(filter: string): number {
  const blur = filter.match(/blur\(([-\d.]+)px\)/)?.[1];
  if (!blur) return 0;
  const value = Number.parseFloat(blur);
  return Number.isFinite(value) ? value : 0;
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
