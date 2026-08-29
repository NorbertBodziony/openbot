import { AppLogo } from "@openbot/brand";
import type {
  DynamicIslandAction,
  DynamicIslandApprovalItem,
  DynamicIslandBotIdentity,
  DynamicIslandFailureItem,
  DynamicIslandPresentation,
  DynamicIslandPromptItem,
  DynamicIslandTakeoverItem,
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
  children as resolveChildren,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { AgentAvatar } from "./AgentAvatar";
import {
  animateModeLayers,
  type CapturedModeLayerState,
  captureModeLayerStates,
  clearPrimedModeLayerPositions,
  type IslandModeSwapSlot,
  type ModeSwapPoint,
  type ModeSwapSize,
  modeSourceAnchors,
  modeSwapElementSize,
  prefersReducedMotion,
  primeCompactModeLayerPositions,
  restoreModeTransitionFocus,
  waitForAnimations,
} from "./openbot-dynamic-island-motion";
import {
  Badge,
  Button,
  Check,
  DynamicIsland,
  DynamicIslandIdentity,
  type DynamicIslandStateChangeReason,
  type DynamicIslandViewState,
  ExternalLink,
  MessageCircle,
  MessageCircleQuestionMark,
  Monitor,
  OctagonX,
  Spinner,
} from "./ui";

export interface OpenBotDynamicIslandProps {
  presentation: DynamicIslandPresentation;
  state: DynamicIslandViewState;
  displayMode?: "notch" | "island";
  extendedHoverArea?: boolean;
  suppressInitialHover?: boolean;
  onStateChange: (state: DynamicIslandViewState, reason: DynamicIslandStateChangeReason) => void;
  onAction: (action: DynamicIslandAction) => void | Promise<void>;
  onHaptic?: () => void;
}

const COMPACT_INDICES = [0, 1, 2] as const;
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
const STATUS_COMPACT_BASE_WIDTH = { notch: 412, island: 280 } as const;
const STATUS_COMPACT_NOTCH_WIDTH = 192;
const STATUS_COMPACT_AVATAR_WIDTH = 20;
const STATUS_COMPACT_IDENTITY_GAP = 6;
const STATUS_COMPACT_AVATAR_OVERLAP = 6;
const STATUS_COMPACT_NOTCH_EDGE_PADDING = 12;
const STATUS_COMPACT_ISLAND_INLINE_PADDING = 8;
const STATUS_COMPACT_BADGE_CHROME_WIDTH = 32;
const STATUS_COMPACT_NOTCH_MIN_WIDTH = 360;
const STATUS_COMPACT_ISLAND_MIN_WIDTH = 212;
const STATUS_COMPACT_NAME_MAX_WIDTH = { notch: 72, island: 96 } as const;

interface SharedLeadingMotion {
  notch: { x: number; y: number; scale: number };
  island: { x: number; y: number; scale: number };
}

interface StatusCompactGeometry {
  notch: { width: number };
  island: { width: number };
}

interface IslandModeSwapProps {
  slot: IslandModeSwapSlot;
  presentation: DynamicIslandPresentation;
  outgoingPresentation: DynamicIslandPresentation | undefined;
  block?: boolean;
  children: JSX.Element;
  renderOutgoing: (presentation: DynamicIslandPresentation) => JSX.Element;
}

type StatusMode = Extract<
  DynamicIslandPresentation["mode"],
  "working" | "message" | "question" | "approval" | "takeover" | "failed"
>;

interface OpenBotIslandModeConfig {
  label: string;
  ariaLive?: "polite";
  badge?: {
    label: string;
    variant: "success-light" | "info-light" | "warning-light" | "destructive-light";
    icon: () => JSX.Element;
    className: string;
  };
}

const WORKING_SHARED_LEADING: SharedLeadingMotion = {
  notch: { x: 29, y: 52, scale: 32 / COMPACT_LEADING_SIZE },
  island: { x: -52, y: 52, scale: 32 / COMPACT_LEADING_SIZE },
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
  },
  working: {
    label: "OpenBot working status",
    badge: {
      label: "Working",
      variant: "success-light",
      icon: () => (
        <Spinner
          data-icon="inline-start"
          class="dynamic-island-surface-status-badge-icon"
          size="sm"
          role="presentation"
          aria-hidden="true"
        />
      ),
      className: "dynamic-island-surface-working-badge",
    },
  },
  message: {
    label: "OpenBot chat update",
    badge: {
      label: "Message",
      variant: "info-light",
      icon: () => (
        <MessageCircle data-icon="inline-start" class="dynamic-island-surface-status-badge-icon" aria-hidden="true" />
      ),
      className: "dynamic-island-surface-message-badge",
    },
  },
  question: {
    label: "OpenBot question from AI",
    badge: {
      label: "Questions",
      variant: "info-light",
      icon: () => (
        <MessageCircleQuestionMark
          data-icon="inline-start"
          class="dynamic-island-surface-status-badge-icon"
          aria-hidden="true"
        />
      ),
      className: "dynamic-island-surface-question-badge",
    },
  },
  approval: {
    label: "OpenBot approval request",
    ariaLive: "polite",
    badge: {
      label: "Approval",
      variant: "warning-light",
      icon: () => (
        <Check data-icon="inline-start" class="dynamic-island-surface-status-badge-icon" aria-hidden="true" />
      ),
      className: "dynamic-island-surface-approval-badge",
    },
  },
  takeover: {
    label: "OpenBot browser takeover",
    ariaLive: "polite",
    badge: {
      label: "Take over",
      variant: "warning-light",
      icon: () => (
        <Monitor data-icon="inline-start" class="dynamic-island-surface-status-badge-icon" aria-hidden="true" />
      ),
      className: "dynamic-island-surface-takeover-badge",
    },
  },
  failed: {
    label: "OpenBot task failed",
    ariaLive: "polite",
    badge: {
      label: "Failed",
      variant: "destructive-light",
      icon: () => (
        <OctagonX data-icon="inline-start" class="dynamic-island-surface-status-badge-icon" aria-hidden="true" />
      ),
      className: "dynamic-island-surface-failed-badge",
    },
  },
};

function compactStatusGeometry(presentation: DynamicIslandPresentation): StatusCompactGeometry | undefined {
  const mode = statusMode(presentation.mode);
  if (!mode) return undefined;

  const bot = compactStatusBot(presentation);
  const workingAvatarCount =
    presentation.mode === "working" ? Math.min(COMPACT_INDICES.length, presentation.working.length) : 0;
  if (!bot && workingAvatarCount === 0) return undefined;

  const badge = OPENBOT_ISLAND_MODE_CONFIG[mode].badge;
  if (!badge) return undefined;
  const badgeWidth = Math.ceil(measureCompactText(badge.label, 600) + STATUS_COMPACT_BADGE_CHROME_WIDTH);
  const measuredNameWidth = bot ? measureCompactText(bot.name, 600) : 0;
  const notchNameWidth = Math.min(STATUS_COMPACT_NAME_MAX_WIDTH.notch, Math.ceil(measuredNameWidth));
  const islandNameWidth = Math.min(STATUS_COMPACT_NAME_MAX_WIDTH.island, Math.ceil(measuredNameWidth));
  const workingAvatarStackWidth =
    STATUS_COMPACT_AVATAR_WIDTH +
    Math.max(0, workingAvatarCount - 1) * (STATUS_COMPACT_AVATAR_WIDTH - STATUS_COMPACT_AVATAR_OVERLAP);
  const notchLeadingContentWidth = bot
    ? STATUS_COMPACT_AVATAR_WIDTH + STATUS_COMPACT_IDENTITY_GAP + notchNameWidth
    : workingAvatarStackWidth;
  const islandLeadingContentWidth = bot
    ? STATUS_COMPACT_AVATAR_WIDTH + STATUS_COMPACT_IDENTITY_GAP + islandNameWidth
    : workingAvatarStackWidth;
  const notchLeadingWidth = STATUS_COMPACT_NOTCH_EDGE_PADDING + notchLeadingContentWidth;
  const notchTrailingWidth = STATUS_COMPACT_NOTCH_EDGE_PADDING + badgeWidth;
  const notchWidth = clampCompactWidth(
    STATUS_COMPACT_NOTCH_WIDTH + 2 * Math.max(notchLeadingWidth, notchTrailingWidth),
    STATUS_COMPACT_NOTCH_MIN_WIDTH,
    STATUS_COMPACT_BASE_WIDTH.notch,
  );
  const islandSideWidth = Math.max(islandLeadingContentWidth, badgeWidth);
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
  const initialPresentation = untrack(() => props.presentation);
  const [visiblePresentation, setVisiblePresentation] = createSignal(initialPresentation);
  const config = () => OPENBOT_ISLAND_MODE_CONFIG[visiblePresentation().mode];
  const [compactLayoutPresentation, setCompactLayoutPresentation] = createSignal(initialPresentation);
  const [outgoingPresentation, setOutgoingPresentation] = createSignal<DynamicIslandPresentation>();
  const [modeTransitioning, setModeTransitioning] = createSignal(false);
  let transitionRoot: HTMLDivElement | undefined;
  let modeAnimations: Animation[] = [];
  let modeTransitionVersion = 0;
  let modeTransitionFrame: number | undefined;
  let modeTransitionDisposed = false;
  const compactGeometry = createMemo(() => compactStatusGeometry(compactLayoutPresentation()));
  const compactWidth = () => {
    const geometry = compactGeometry();
    if (!geometry) return undefined;
    return props.displayMode === "island" ? geometry.island.width : geometry.notch.width;
  };
  const sharedLeading = createMemo(() => {
    const mode = statusMode(visiblePresentation().mode);
    const motion = mode === "working" ? WORKING_SHARED_LEADING : mode ? QUESTION_SHARED_LEADING : undefined;
    const geometry = compactGeometry();
    if (!motion || !geometry) return motion;
    return adjustSharedMotion(motion, geometry, "leading");
  });
  const sharedTrailing = createMemo(() => {
    const motion = statusMode(visiblePresentation().mode) ? STATUS_SHARED_TRAILING : undefined;
    const geometry = compactGeometry();
    if (!motion || !geometry) return motion;
    return adjustSharedMotion(motion, geometry, "trailing");
  });

  createEffect(
    () => ({ presentation: visiblePresentation(), state: props.state, transitioning: modeTransitioning() }),
    ({ presentation, state, transitioning }) => {
      if (state === "compact" && !transitioning) setCompactLayoutPresentation(presentation);
    },
  );

  createEffect(
    () => ({ nextPresentation: props.presentation, currentPresentation: visiblePresentation() }),
    ({ nextPresentation, currentPresentation }) => {
      if (nextPresentation.mode === currentPresentation.mode) {
        setVisiblePresentation(nextPresentation);
        if (props.state === "compact") setCompactLayoutPresentation(nextPresentation);
        return;
      }

      const capturedLayers = captureModeLayerStates(transitionRoot);
      const sourceAnchors = modeSourceAnchors(capturedLayers, currentPresentation.mode);
      const sourceSize = modeSwapElementSize(transitionRoot?.querySelector<HTMLElement>(".dynamic-island-shell"));
      restoreModeTransitionFocus(transitionRoot);
      cancelModeTransition();
      const transitionVersion = ++modeTransitionVersion;
      setOutgoingPresentation(currentPresentation);
      setVisiblePresentation(nextPresentation);
      setModeTransitioning(true);

      scheduleModeTransitionFrame(transitionVersion, () => {
        if (props.state === "compact") {
          setCompactLayoutPresentation(nextPresentation);
          const primedOffsets = primeCompactModeLayerPositions(transitionRoot, sourceAnchors, sourceSize);
          scheduleModeTransitionFrame(transitionVersion, () =>
            startModeTransition(transitionVersion, capturedLayers, sourceAnchors, sourceSize, primedOffsets),
          );
          return;
        }
        setCompactLayoutPresentation(nextPresentation);
        startModeTransition(transitionVersion, capturedLayers, sourceAnchors, sourceSize, new Map());
      });
    },
  );

  function scheduleModeTransitionFrame(transitionVersion: number, callback: () => void): void {
    modeTransitionFrame = requestAnimationFrame(() => {
      modeTransitionFrame = undefined;
      if (modeTransitionDisposed || transitionVersion !== modeTransitionVersion) return;
      callback();
    });
  }

  function startModeTransition(
    transitionVersion: number,
    capturedLayers: Map<string, CapturedModeLayerState>,
    sourceAnchors: Map<IslandModeSwapSlot, ModeSwapPoint>,
    sourceSize: ModeSwapSize | undefined,
    primedOffsets: ReadonlyMap<HTMLElement, ModeSwapPoint>,
  ): void {
    if (modeTransitionDisposed || transitionVersion !== modeTransitionVersion) return;
    modeAnimations = animateModeLayers(
      transitionRoot,
      capturedLayers,
      sourceAnchors,
      sourceSize,
      primedOffsets,
      prefersReducedMotion(),
    );
    clearPrimedModeLayerPositions(transitionRoot);
    if (modeAnimations.length === 0) {
      finishModeTransition(transitionVersion);
      return;
    }
    void waitForAnimations(modeAnimations).then(() => finishModeTransition(transitionVersion));
  }

  function cancelModeTransition(): void {
    if (modeTransitionFrame !== undefined) {
      cancelAnimationFrame(modeTransitionFrame);
      modeTransitionFrame = undefined;
    }
    for (const animation of modeAnimations) animation.cancel();
    modeAnimations = [];
    clearPrimedModeLayerPositions(transitionRoot);
  }

  function finishModeTransition(version: number): void {
    if (modeTransitionDisposed || version !== modeTransitionVersion) return;
    const completedAnimations = modeAnimations;
    modeAnimations = [];
    setOutgoingPresentation(undefined);
    setModeTransitioning(false);
    queueMicrotask(() => {
      for (const animation of completedAnimations) animation.cancel();
    });
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
      <DynamicIsland
        label={`${config().label}${props.displayMode === "island" ? " on external display" : ""}`}
        ariaLive={config().ariaLive}
        state={props.state}
        displayMode={props.displayMode}
        extendedHoverArea={props.extendedHoverArea}
        suppressInitialHover={props.suppressInitialHover}
        onStateChange={changeState}
        compactWidth={compactWidth()}
        sharedMotion={{
          leading: sharedLeading()?.[props.displayMode === "island" ? "island" : "notch"],
          trailing: sharedTrailing()?.[props.displayMode === "island" ? "island" : "notch"],
        }}
        hoverBehavior={config().badge ? "expand" : "grow"}
        hoverContentMotion={OPENBOT_COMPACT_HOVER_MOTION}
        pointerToggle={config().badge ? false : undefined}
        class={[
          "openbot-dynamic-island",
          `dynamic-island-${visiblePresentation().mode === "message" ? "message-first" : visiblePresentation().mode}`,
          config().badge ? "dynamic-island-status" : undefined,
          visiblePresentation().mode !== "idle" && visiblePresentation().mode !== "working"
            ? "dynamic-island-panel-wide"
            : undefined,
        ]
          .filter(Boolean)
          .join(" ")}
        compactLeading={
          <IslandModeSwap
            slot="compact-leading"
            presentation={visiblePresentation()}
            outgoingPresentation={outgoingPresentation()}
            renderOutgoing={(presentation) => (
              <CompactLeading presentation={presentation} displayMode={props.displayMode} />
            )}
          >
            <CompactLeading presentation={visiblePresentation()} displayMode={props.displayMode} />
          </IslandModeSwap>
        }
        compactTrailing={
          <IslandModeSwap
            slot="compact-trailing"
            presentation={visiblePresentation()}
            outgoingPresentation={outgoingPresentation()}
            renderOutgoing={(presentation) => <CompactTrailing presentation={presentation} />}
          >
            <CompactTrailing presentation={visiblePresentation()} />
          </IslandModeSwap>
        }
        expandedContent={
          <IslandModeSwap
            slot="expanded"
            presentation={visiblePresentation()}
            outgoingPresentation={outgoingPresentation()}
            block
            renderOutgoing={(presentation) => (
              <ExpandedContent
                presentation={presentation}
                displayMode={props.displayMode}
                onAction={props.onAction}
                onHaptic={props.onHaptic}
                onClose={() => props.onStateChange("compact", "pointer")}
              />
            )}
          >
            <ExpandedContent
              presentation={visiblePresentation()}
              displayMode={props.displayMode}
              onAction={props.onAction}
              onHaptic={props.onHaptic}
              onClose={() => props.onStateChange("compact", "pointer")}
            />
          </IslandModeSwap>
        }
      />
    </div>
  );
}

function IslandModeSwap(props: IslandModeSwapProps): JSX.Element {
  const incoming = resolveChildren(() => props.children);
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
        {incoming()}
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
            {props.renderOutgoing(outgoing())}
          </Dynamic>
        )}
      </Show>
    </Dynamic>
  );
}

function CompactLeading(props: {
  presentation: DynamicIslandPresentation;
  displayMode?: "notch" | "island";
}): JSX.Element {
  const statusBot = () => compactStatusBot(props.presentation);
  const working = () => (props.presentation.mode === "working" ? props.presentation.working : []);
  return (
    <span class="dynamic-island-surface-content-swap dynamic-island-surface-compact-swap">
      <Switch
        fallback={
          <span class="dynamic-island-surface-leading-anchor" data-island-spatial-anchor="center">
            <AppLogo variant="production" animation="blink" class="dynamic-island-surface-logo" />
          </span>
        }
      >
        <Match when={props.presentation.mode === "working"}>
          <span
            class="dynamic-island-surface-leading-anchor dynamic-island-surface-compact-identity"
            data-island-spatial-anchor="center"
          >
            <span class="dynamic-island-surface-avatar-stack">
              <For each={COMPACT_INDICES}>
                {(index) => (
                  <Show when={working()[index]}>
                    {(item) => (
                      <span class="dynamic-island-surface-avatar-stack-item">
                        <IslandAvatar bot={item().bot} working />
                      </span>
                    )}
                  </Show>
                )}
              </For>
            </span>
            <Show when={working().length === 1 ? working()[0] : undefined}>
              {(item) => <CompactBotName name={item().bot.name} displayMode={props.displayMode} />}
            </Show>
          </span>
        </Match>
        <Match when={statusBot()}>{(bot) => <CompactBotIdentity bot={bot()} displayMode={props.displayMode} />}</Match>
      </Switch>
    </span>
  );
}

function CompactTrailing(props: { presentation: DynamicIslandPresentation }): JSX.Element {
  return (
    <IslandContentSwap contentKey={props.presentation.mode} class="dynamic-island-surface-compact-swap">
      <Switch>
        <Match when={statusMode(props.presentation.mode)}>{(mode) => <CompactStatusBadge mode={mode()} />}</Match>
        <Match when={props.presentation.mode === "idle"}>
          <IdleGreetingEmoji />
        </Match>
      </Switch>
    </IslandContentSwap>
  );
}

function CompactBotIdentity(props: {
  bot: DynamicIslandBotIdentity;
  displayMode?: "notch" | "island";
  working?: boolean;
}): JSX.Element {
  return (
    <span
      class="dynamic-island-surface-leading-anchor dynamic-island-surface-compact-identity"
      data-island-spatial-anchor="center"
    >
      <IslandAvatar bot={props.bot} working={props.working} />
      <CompactBotName name={props.bot.name} displayMode={props.displayMode} />
    </span>
  );
}

function CompactBotName(props: { name: string; displayMode?: "notch" | "island" }): JSX.Element {
  const nameMaxWidth = () =>
    props.displayMode === "island" ? STATUS_COMPACT_NAME_MAX_WIDTH.island : STATUS_COMPACT_NAME_MAX_WIDTH.notch;
  return (
    <span
      class="dynamic-island-surface-compact-name"
      style={{ "max-width": `${nameMaxWidth()}px` }}
      data-island-motion-content
    >
      {props.name}
    </span>
  );
}

function CompactStatusBadge(props: { mode: StatusMode }): JSX.Element {
  const config = () => OPENBOT_ISLAND_MODE_CONFIG[props.mode].badge;
  return (
    <Show when={config()}>
      {(badge) => (
        <Badge
          variant={badge().variant}
          class={["dynamic-island-surface-status-badge", badge().className].join(" ")}
          data-island-spatial-anchor="end"
          data-island-motion-content
          aria-hidden="true"
        >
          {badge().icon()}
          <span class="dynamic-island-surface-status-badge-label">{badge().label}</span>
        </Badge>
      )}
    </Show>
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
    <span
      class="dynamic-island-surface-idle-greeting"
      data-active-slot={activeSlot()}
      data-island-motion-content
      data-island-spatial-anchor="end"
      aria-hidden="true"
    >
      <span class="dynamic-island-surface-idle-greeting-layer">{firstEmoji()}</span>
      <span class="dynamic-island-surface-idle-greeting-layer">{secondEmoji()}</span>
    </span>
  );
}

function ExpandedContent(props: {
  presentation: DynamicIslandPresentation;
  displayMode?: "notch" | "island";
  onAction: (action: DynamicIslandAction) => void | Promise<void>;
  onHaptic?: () => void;
  onClose: () => void;
}): JSX.Element {
  const working = () => (props.presentation.mode === "working" ? props.presentation.working : []);
  const unreadCount = () => (props.presentation.mode === "message" ? props.presentation.unreadCount : 0);
  return (
    <Switch>
      <Match when={props.presentation.mode === "working"}>
        <div class="dynamic-island-surface-panel">
          <div class="dynamic-island-surface-list">
            <For each={ROW_INDICES}>
              {(index) => (
                <Show when={working()[index]}>
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
                      <span class="dynamic-island-surface-working-avatar-slot" aria-hidden="true" />
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
      <Match when={props.presentation.mode === "message" ? props.presentation.message : undefined}>
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
              <span class="dynamic-island-message-first-unread">{unreadCount()} unread</span>
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
      <Match when={props.presentation.mode === "takeover" ? props.presentation.item : undefined}>
        {(item) => <TakeoverContent item={item()} serverId={props.presentation.serverId} onAction={props.onAction} />}
      </Match>
      <Match when={props.presentation.mode === "failed" ? props.presentation.item : undefined}>
        {(item) => <FailureContent item={item()} serverId={props.presentation.serverId} onAction={props.onAction} />}
      </Match>
      <Match when={props.presentation.mode === "question" ? props.presentation : undefined}>
        {(presentation) => (
          <QuestionContent
            item={presentation().item}
            serverId={presentation().serverId}
            remainingCount={presentation().remainingCount}
            onAction={props.onAction}
            onHaptic={props.onHaptic}
            onClose={props.onClose}
          />
        )}
      </Match>
      <Match when={props.presentation.mode === "approval" ? props.presentation : undefined}>
        {(presentation) => (
          <ApprovalContent
            item={presentation().item}
            serverId={presentation().serverId}
            remainingCount={presentation().remainingCount}
            onAction={props.onAction}
          />
        )}
      </Match>
    </Switch>
  );
}

function FailureContent(props: {
  item: DynamicIslandFailureItem;
  serverId: string;
  onAction: (action: DynamicIslandAction) => void | Promise<void>;
}): JSX.Element {
  return (
    <NotificationContent
      contentKey={`${props.item.turnId}:${props.item.detail ?? ""}`}
      name={props.item.bot.name}
      status="failed"
      description={props.item.detail ?? "The task stopped before it could finish."}
      action={
        <Button
          size="sm"
          onClick={() =>
            props.onAction({
              type: "open-failure",
              serverId: props.serverId,
              botId: props.item.bot.id,
              turnId: props.item.turnId,
            })
          }
        >
          <ExternalLink aria-hidden="true" /> Open details
        </Button>
      }
    />
  );
}

function TakeoverContent(props: {
  item: DynamicIslandTakeoverItem;
  serverId: string;
  onAction: (action: DynamicIslandAction) => void | Promise<void>;
}): JSX.Element {
  return (
    <NotificationContent
      contentKey={`${props.item.requestId}:${props.item.detail ?? ""}`}
      name={props.item.bot.name}
      status="needs you"
      description={props.item.detail ?? "Complete the browser step so the bot can continue."}
      action={
        <Button
          size="sm"
          onClick={() =>
            props.onAction({
              type: "review-attention",
              serverId: props.serverId,
              botId: props.item.bot.id,
              requestId: props.item.requestId,
            })
          }
        >
          <Monitor aria-hidden="true" /> Take over
        </Button>
      }
    />
  );
}

function NotificationContent(props: {
  contentKey: string;
  name: string;
  status: string;
  description: string;
  action: JSX.Element;
}): JSX.Element {
  return (
    <div class="dynamic-island-surface-panel dynamic-island-surface-attention-panel">
      <IslandContentSwap contentKey={props.contentKey} block>
        <DynamicIslandIdentity name={props.name} status={props.status} description={props.description} />
      </IslandContentSwap>
      <div class="dynamic-island-surface-actions" data-island-motion-content>
        {props.action}
      </div>
    </div>
  );
}

function ApprovalContent(props: {
  item: DynamicIslandApprovalItem;
  serverId: string;
  remainingCount: number;
  onAction: (action: DynamicIslandAction) => void | Promise<void>;
}): JSX.Element {
  const openInOpenBot = () =>
    props.onAction({
      type: "review-attention",
      serverId: props.serverId,
      botId: props.item.bot.id,
      requestId: props.item.requestId,
    });

  return (
    <div class="dynamic-island-surface-panel dynamic-island-surface-attention-panel">
      <DynamicIslandIdentity
        name={props.item.bot.name}
        status="needs approval"
        description={props.item.approval.reason ?? props.item.detail ?? "Review the requested action before it runs."}
      />
      <IslandContentSwap contentKey={`${props.item.requestId}:${props.item.detail ?? ""}`} block>
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
        <Button size="sm" onClick={openInOpenBot}>
          Review in OpenBot
        </Button>
      </div>
    </div>
  );
}

function QuestionContent(props: {
  item: DynamicIslandPromptItem;
  serverId: string;
  remainingCount: number;
  onAction: (action: DynamicIslandAction) => void | Promise<void>;
  onHaptic?: () => void;
  onClose: () => void;
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
    () => `${props.item.requestId}:${props.item.questions.map((question) => question.id).join(",")}`,
    () => {
      questionTransitionVersion += 1;
      cancelQuestionAnimations();
      clearQuestionHidden(questionTransitionElements());
      setQuestionTransitioning(false);
      setQuestionIndex(0);
      setAnswers({});
    },
  );
  const questions = () => props.item.questions;
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
      props.onHaptic?.();
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
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Later
        </Button>
        <Button size="sm" onClick={openInOpenBot}>
          Answer in OpenBot
        </Button>
      </div>
    </div>
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

function ApprovalContext(props: { item: DynamicIslandApprovalItem }): JSX.Element {
  const approval = () => props.item.approval;
  return (
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
  );
}

function IslandAvatar(props: { bot: DynamicIslandBotIdentity; working?: boolean }): JSX.Element {
  return (
    <AgentAvatar
      bot={props.bot}
      motion={props.working ? "working" : "idle"}
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

function compactStatusBot(presentation: DynamicIslandPresentation): DynamicIslandBotIdentity | undefined {
  if (presentation.mode === "idle") return undefined;
  if (presentation.mode === "working")
    return presentation.working.length === 1 ? presentation.working[0]?.bot : undefined;
  if (presentation.mode === "message") return presentation.message.bot;
  return presentation.item.bot;
}

function statusMode(mode: DynamicIslandPresentation["mode"]): StatusMode | undefined {
  return mode === "idle" ? undefined : mode;
}

function permissionSummary(permissions: NonNullable<DynamicIslandApprovalItem["approval"]["permissions"]>) {
  const parts = [
    permissions.fileSystem.read.length > 0 ? "read files" : null,
    permissions.fileSystem.write.length > 0 ? "write files" : null,
    permissions.network ? "use network" : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Limited agent access";
}
