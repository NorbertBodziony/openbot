import type { JSX } from "@solidjs/web";
import { ChevronUp } from "lucide-solid";
import { createEffect, createSignal, createUniqueId, onCleanup, onSettled, Show, untrack } from "solid-js";
import { cx } from "./utils";

export type DynamicIslandTone = "neutral" | "working" | "attention";
export type DynamicIslandViewState = "compact" | "expanded";
export type DynamicIslandHoverBehavior = "none" | "grow" | "expand";
export type DynamicIslandContentMotion = "morph" | "spring";
export type DynamicIslandDisplayMode = "notch" | "island";
export type DynamicIslandStateChangeReason = "pointer" | "keyboard" | "hover" | "hover-exit" | "escape";

export interface DynamicIslandHoverContentMotion {
  leadingScale: number;
  trailingScale: number;
  outwardTranslateX: number;
  translateY: number;
}

export interface DynamicIslandProps {
  label: string;
  compactLeading?: JSX.Element;
  compactTrailing?: JSX.Element;
  expandedContent: JSX.Element;
  state?: DynamicIslandViewState;
  defaultState?: DynamicIslandViewState;
  onStateChange?: (state: DynamicIslandViewState, reason: DynamicIslandStateChangeReason) => void;
  hoverBehavior?: DynamicIslandHoverBehavior;
  hoverContentMotion?: DynamicIslandHoverContentMotion;
  pointerToggle?: boolean;
  contentMotion?: DynamicIslandContentMotion;
  sharedLeadingMotion?: boolean;
  sharedLeadingExpandedX?: number;
  sharedLeadingExpandedY?: number;
  sharedLeadingExpandedScale?: number;
  sharedTrailingMotion?: boolean;
  sharedTrailingExpandedX?: number;
  sharedTrailingExpandedY?: number;
  sharedTrailingExpandedScale?: number;
  displayMode?: DynamicIslandDisplayMode;
  tone?: DynamicIslandTone;
  class?: string;
}

const HOVER_EXPAND_DELAY = 300;
const HOVER_EXIT_DELAY = 100;
const HOVER_WIDTH_GROWTH = 32;
const HOVER_HEIGHT_GROWTH = 8;
const CONTENT_EXIT_LEAD = 90;
const PANEL_EXIT_DURATION = CONTENT_EXIT_LEAD + 450;
const OPEN_SPRING = { response: 0.42, dampingFraction: 1 } as const;
const CLOSE_SPRING = { response: 0.45, dampingFraction: 1 } as const;
const HOVER_SPRING = {
  response: 0.5 / 1.2,
  dampingFraction: 0.7,
} as const;
const CONTENT_SPRING = { response: 0.34, dampingFraction: 0.88 } as const;
const CONTENT_EXIT_DURATION = 280;
const CONTENT_BLUR = 4;
const CONTENT_ENTER_DELAY = 90;
const CONTENT_BLUR_OPEN_DURATION = 460;
const CONTENT_BLUR_CLOSE_DURATION = 450;
const COMPACT_RETURN_DURATION = 450;
const REDUCED_CONTENT_FADE_DURATION = 150;
const DEFAULT_HOVER_CONTENT_MOTION: DynamicIslandHoverContentMotion = {
  leadingScale: 1.08,
  trailingScale: 1.08,
  outwardTranslateX: 10,
  translateY: 6,
};

/**
 * A macOS-notch adaptation of SmoothUI's Dynamic Island pattern.
 * Source: https://smoothui.dev/r/dynamic-island.json
 */
export function DynamicIsland(props: DynamicIslandProps): JSX.Element {
  const local = props;
  const [internalState, setInternalState] = createSignal<DynamicIslandViewState>(
    untrack(() => local.defaultState ?? "compact"),
  );
  const panelId = `dynamic-island-${createUniqueId()}`;
  let shell: HTMLDivElement | undefined;
  let sizeTarget: HTMLDivElement | undefined;
  let silhouetteRoot: HTMLSpanElement | undefined;
  let silhouetteBody: HTMLSpanElement | undefined;
  let leadingShoulder: SVGSVGElement | undefined;
  let trailingShoulder: SVGSVGElement | undefined;
  let leadingContent: HTMLSpanElement | undefined;
  let trailingContent: HTMLSpanElement | undefined;
  let hoverLeadingContent: HTMLSpanElement | undefined;
  let hoverTrailingContent: HTMLSpanElement | undefined;
  let panelContent: HTMLDivElement | undefined;
  let toggleButton: HTMLButtonElement | undefined;
  let hoverExpandTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverExitTimer: ReturnType<typeof setTimeout> | undefined;
  let panelExitTimer: ReturnType<typeof setTimeout> | undefined;
  let layoutCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let pointerInside = false;
  let hoverOpenedState: Exclude<DynamicIslandViewState, "compact"> | null = null;
  const [isHovering, setIsHovering] = createSignal(false);

  const viewState = () => local.state ?? internalState();
  const isExpanded = () => viewState() === "expanded";
  const initialViewState = untrack(viewState);
  const [layoutState, setLayoutState] = createSignal<DynamicIslandViewState>(initialViewState);
  const [renderedPanelState, setRenderedPanelState] = createSignal<Exclude<DynamicIslandViewState, "compact"> | null>(
    initialViewState === "compact" ? null : initialViewState,
  );

  function setState(next: DynamicIslandViewState, reason: DynamicIslandStateChangeReason): void {
    if (next === viewState()) return;
    if (local.state === undefined) setInternalState(next);
    local.onStateChange?.(next, reason);
  }

  function clearHoverTimers(): void {
    if (hoverExpandTimer !== undefined) clearTimeout(hoverExpandTimer);
    if (hoverExitTimer !== undefined) clearTimeout(hoverExitTimer);
    hoverExpandTimer = undefined;
    hoverExitTimer = undefined;
  }

  function toggle(reason: "pointer" | "keyboard"): void {
    clearHoverTimers();
    hoverOpenedState = null;
    setState(isExpanded() ? "compact" : "expanded", reason);
  }

  function handlePointerEnter(event: PointerEvent): void {
    if (event.pointerType && event.pointerType !== "mouse") return;
    beginHover();
  }

  function beginHover(): void {
    if (pointerInside) return;
    pointerInside = true;
    setIsHovering(true);
    if (hoverExitTimer !== undefined) clearTimeout(hoverExitTimer);
    hoverExitTimer = undefined;
    const hoverBehavior = local.hoverBehavior ?? "none";
    if (hoverBehavior !== "expand" || viewState() === "expanded") return;

    if (hoverExpandTimer !== undefined) clearTimeout(hoverExpandTimer);
    hoverExpandTimer = setTimeout(() => {
      hoverExpandTimer = undefined;
      if (!isHovering() || viewState() === "expanded") return;
      hoverOpenedState = "expanded";
      setState("expanded", "hover");
    }, HOVER_EXPAND_DELAY);
  }

  function handlePointerLeave(event: PointerEvent): void {
    if (event.pointerType && event.pointerType !== "mouse") return;
    endHover();
  }

  function endHover(): void {
    if (!pointerInside) return;
    pointerInside = false;
    if (hoverExpandTimer !== undefined) clearTimeout(hoverExpandTimer);
    hoverExpandTimer = undefined;
    const openedState = hoverOpenedState;

    if (hoverExitTimer !== undefined) clearTimeout(hoverExitTimer);
    hoverExitTimer = setTimeout(() => {
      hoverExitTimer = undefined;
      if (pointerInside) return;
      setIsHovering(false);
      if (!openedState || hoverOpenedState !== openedState || viewState() !== openedState) return;
      hoverOpenedState = null;
      setState("compact", "hover-exit");
    }, HOVER_EXIT_DELAY);
  }

  createEffect(
    () => ({
      layout: layoutState(),
      rendered: renderedPanelState(),
      state: viewState(),
    }),
    ({ layout, rendered, state }) => {
      if (hoverOpenedState && state !== hoverOpenedState) hoverOpenedState = null;

      if (layoutCloseTimer !== undefined) clearTimeout(layoutCloseTimer);
      layoutCloseTimer = undefined;
      if (state !== "compact") {
        setLayoutState(state);
        return;
      }

      const shouldStageClose =
        (local.contentMotion ?? "morph") === "spring" && layout === "expanded" && rendered === "expanded";
      if (!shouldStageClose) {
        setLayoutState("compact");
        return;
      }

      layoutCloseTimer = setTimeout(() => {
        layoutCloseTimer = undefined;
        if (viewState() === "compact") setLayoutState("compact");
      }, CONTENT_EXIT_LEAD);
    },
  );

  createEffect(
    () => ({ rendered: renderedPanelState(), state: viewState() }),
    ({ rendered, state }) => {
      if (panelExitTimer !== undefined) clearTimeout(panelExitTimer);
      panelExitTimer = undefined;
      if (state !== "compact") {
        setRenderedPanelState(state);
        return;
      }
      if (!rendered) return;
      panelExitTimer = setTimeout(() => {
        panelExitTimer = undefined;
        setRenderedPanelState(null);
      }, PANEL_EXIT_DURATION);
    },
  );

  createSmoothSizeResize({
    container: () => shell,
    content: () => sizeTarget,
    silhouette: () => ({
      root: silhouetteRoot,
      body: silhouetteBody,
      leadingShoulder,
      trailingShoulder,
    }),
    silhouetteTarget: () => islandSilhouetteTarget(viewState(), isHovering(), local.displayMode ?? "notch"),
    sharedLeading: () => leadingContent,
    sharedLeadingEnabled: () => local.sharedLeadingMotion ?? false,
    sharedLeadingTarget: () =>
      sharedLeadingTarget(
        viewState(),
        local.sharedLeadingExpandedX ?? 27,
        local.sharedLeadingExpandedY ?? 54,
        local.sharedLeadingExpandedScale ?? 2.4,
      ),
    sharedTrailing: () => trailingContent,
    sharedTrailingEnabled: () => local.sharedTrailingMotion ?? false,
    sharedTrailingTarget: () =>
      sharedLeadingTarget(
        viewState(),
        local.sharedTrailingExpandedX ?? 0,
        local.sharedTrailingExpandedY ?? 0,
        local.sharedTrailingExpandedScale ?? 1,
      ),
  });
  createHoverContentMotion({
    leading: () => hoverLeadingContent,
    trailing: () => hoverTrailingContent,
    active: () => isHovering() && viewState() !== "expanded" && (local.hoverBehavior ?? "none") !== "none",
    state: viewState,
    motion: () => local.hoverContentMotion ?? DEFAULT_HOVER_CONTENT_MOTION,
  });
  createSpringContentTransition({
    content: () => panelContent,
    root: () => shell,
    enabled: () => (local.contentMotion ?? "morph") === "spring",
    state: viewState,
    renderedState: renderedPanelState,
  });
  onCleanup(() => {
    clearHoverTimers();
    if (panelExitTimer !== undefined) clearTimeout(panelExitTimer);
    if (layoutCloseTimer !== undefined) clearTimeout(layoutCloseTimer);
  });

  return (
    <section
      class={cx("dynamic-island", local.class)}
      data-slot="dynamic-island"
      data-state={viewState()}
      data-layout-state={layoutState()}
      data-tone={local.tone ?? "neutral"}
      data-hovered={isHovering() ? "true" : undefined}
      data-content-motion={local.contentMotion ?? "morph"}
      data-shared-leading={local.sharedLeadingMotion ? "true" : undefined}
      data-shared-trailing={local.sharedTrailingMotion ? "true" : undefined}
      data-display-mode={local.displayMode ?? "notch"}
      data-pointer-toggle={local.pointerToggle === false ? "false" : undefined}
      aria-label={local.label}
      aria-live={local.tone === "attention" ? "polite" : undefined}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onMouseEnter={beginHover}
      onMouseLeave={endHover}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || viewState() === "compact") return;
        event.preventDefault();
        event.stopPropagation();
        clearHoverTimers();
        hoverOpenedState = null;
        setState("compact", "escape");
        queueMicrotask(() => toggleButton?.focus());
      }}
    >
      <div
        ref={shell}
        class="dynamic-island-shell"
        data-state={viewState()}
        data-content-motion={local.contentMotion ?? "morph"}
      >
        <span ref={silhouetteRoot} class="dynamic-island-silhouette" aria-hidden="true">
          <span ref={silhouetteBody} class="dynamic-island-silhouette-body" />
          <svg
            ref={leadingShoulder}
            class="dynamic-island-shoulder dynamic-island-shoulder-leading"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d="M 0 0 Q 1 0 1 1 L 1 0 Z" />
          </svg>
          <svg
            ref={trailingShoulder}
            class="dynamic-island-shoulder dynamic-island-shoulder-trailing"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d="M 1 0 Q 0 0 0 1 L 0 0 Z" />
          </svg>
        </span>
        <div ref={sizeTarget} class="dynamic-island-size-target">
          <button
            ref={toggleButton}
            class="dynamic-island-toggle"
            type="button"
            aria-controls={panelId}
            aria-expanded={isExpanded() ? "true" : "false"}
            aria-label={`${isExpanded() ? "Collapse" : "Expand"} ${local.label}`}
            onClick={(event) => {
              if (event.detail > 0 && local.pointerToggle === false) return;
              toggle(event.detail === 0 ? "keyboard" : "pointer");
            }}
          >
            <span class="dynamic-island-ear dynamic-island-ear-leading" aria-hidden="true">
              <span ref={leadingContent} class="dynamic-island-ear-content">
                <span ref={hoverLeadingContent} class="dynamic-island-hover-content dynamic-island-hover-leading">
                  {local.compactLeading}
                </span>
              </span>
            </span>
            <span class="dynamic-island-notch-safe-zone" aria-hidden="true" />
            <span class="dynamic-island-ear dynamic-island-ear-trailing" aria-hidden="true">
              <span ref={trailingContent} class="dynamic-island-ear-content dynamic-island-trailing-content">
                <span class="dynamic-island-trailing-compact">
                  <span ref={hoverTrailingContent} class="dynamic-island-hover-content dynamic-island-hover-trailing">
                    {local.compactTrailing}
                  </span>
                </span>
                <span class="dynamic-island-trailing-expanded">
                  <ChevronUp class="dynamic-island-collapse-icon" />
                </span>
              </span>
            </span>
          </button>

          <Show keyed when={renderedPanelState()}>
            {(contentState) => (
              <div
                id={panelId}
                class="dynamic-island-panel"
                data-slot="dynamic-island-panel"
                data-phase={
                  viewState() === "compact" ? (layoutState() === "compact" ? "leaving" : "exiting") : "entering"
                }
                data-content-state={contentState}
                aria-hidden={viewState() === "compact" ? "true" : undefined}
              >
                <div ref={panelContent} class="dynamic-island-content" data-content-state={contentState}>
                  {local.expandedContent}
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}

interface SmoothSizeResizeOptions {
  container: () => HTMLElement | undefined;
  content: () => HTMLElement | undefined;
  silhouette: () => {
    root: HTMLSpanElement | undefined;
    body: HTMLSpanElement | undefined;
    leadingShoulder: SVGSVGElement | undefined;
    trailingShoulder: SVGSVGElement | undefined;
  };
  silhouetteTarget: () => IslandSilhouetteGeometry;
  sharedLeading: () => HTMLSpanElement | undefined;
  sharedLeadingEnabled: () => boolean;
  sharedLeadingTarget: () => SharedElementTransform;
  sharedTrailing: () => HTMLSpanElement | undefined;
  sharedTrailingEnabled: () => boolean;
  sharedTrailingTarget: () => SharedElementTransform;
}

interface IslandSilhouetteGeometry {
  topRadius: number;
  bottomRadius: number;
  capsuleRadius?: number;
}

function islandSilhouetteTarget(
  state: DynamicIslandViewState,
  hovering: boolean,
  displayMode: DynamicIslandDisplayMode,
): IslandSilhouetteGeometry {
  if (displayMode === "island") {
    if (state === "expanded") return { topRadius: 0, bottomRadius: 0, capsuleRadius: 24 };
    if (hovering) return { topRadius: 0, bottomRadius: 0, capsuleRadius: 16 };
    return { topRadius: 0, bottomRadius: 0, capsuleRadius: 16 };
  }
  if (state === "expanded") return { topRadius: 19, bottomRadius: 24 };
  if (hovering) return { topRadius: 6, bottomRadius: 14 };
  return { topRadius: 6, bottomRadius: 14 };
}

interface SharedElementTransform {
  x: number;
  y: number;
  scale: number;
}

function sharedLeadingTarget(
  state: DynamicIslandViewState,
  expandedX: number,
  expandedY: number,
  expandedScale: number,
): SharedElementTransform {
  if (state === "expanded") return { x: expandedX, y: expandedY, scale: expandedScale };
  return { x: 0, y: 0, scale: 1 };
}

interface HoverContentMotionOptions {
  leading: () => HTMLSpanElement | undefined;
  trailing: () => HTMLSpanElement | undefined;
  active: () => boolean;
  state: () => DynamicIslandViewState;
  motion: () => DynamicIslandHoverContentMotion;
}

function createHoverContentMotion(options: HoverContentMotionOptions): void {
  let leadingAnimation: Animation | undefined;
  let trailingAnimation: Animation | undefined;

  createEffect(
    () => ({ active: options.active(), motion: options.motion(), state: options.state() }),
    ({ active, motion, state }) => {
      const leading = options.leading();
      const trailing = options.trailing();
      if (!leading || !trailing) return;

      const leadingTarget = active
        ? { x: -motion.outwardTranslateX, y: motion.translateY, scale: motion.leadingScale }
        : { x: 0, y: 0, scale: 1 };
      const trailingTarget = active
        ? { x: motion.outwardTranslateX, y: motion.translateY, scale: motion.trailingScale }
        : { x: 0, y: 0, scale: 1 };
      const spring = state === "expanded" ? OPEN_SPRING : HOVER_SPRING;
      const leadingStart = readCurrentTransform(leading, { x: 0, y: 0, scale: 1 });
      const trailingStart = readCurrentTransform(trailing, { x: 0, y: 0, scale: 1 });

      leadingAnimation?.cancel();
      trailingAnimation?.cancel();
      leadingAnimation = animateHoverContent(leading, leadingStart, leadingTarget, spring);
      trailingAnimation = animateHoverContent(trailing, trailingStart, trailingTarget, spring);
    },
  );

  onCleanup(() => {
    leadingAnimation?.cancel();
    trailingAnimation?.cancel();
  });
}

function animateHoverContent(
  element: HTMLElement,
  start: SharedElementTransform,
  target: SharedElementTransform,
  spring: Spring,
): Animation | undefined {
  writeSharedTransform(element, target);
  const animate = element.animate?.bind(element);
  if (prefersReducedMotion() || !animate || transformsMatch(start, target)) return undefined;
  const animation = animate(sharedElementKeyframes(start, target, spring), {
    duration: spring.response * 1_000,
    easing: "linear",
  });
  void animation.finished.catch(() => undefined);
  return animation;
}

function transformsMatch(left: SharedElementTransform, right: SharedElementTransform): boolean {
  return (
    Math.abs(left.x - right.x) < 0.01 && Math.abs(left.y - right.y) < 0.01 && Math.abs(left.scale - right.scale) < 0.001
  );
}

function createSmoothSizeResize(options: SmoothSizeResizeOptions): void {
  let animations: Animation[] = [];
  let previousSize: { width: number; height: number } | undefined;
  let previousSilhouette: IslandSilhouetteGeometry | undefined;
  let previousSharedLeading: SharedElementTransform | undefined;
  let previousSharedTrailing: SharedElementTransform | undefined;
  let targetSilhouette = untrack(options.silhouetteTarget);
  let targetSharedLeading = untrack(options.sharedLeadingTarget);
  let targetSharedTrailing = untrack(options.sharedTrailingTarget);
  let sharedLeadingEnabled = untrack(options.sharedLeadingEnabled);
  let sharedTrailingEnabled = untrack(options.sharedTrailingEnabled);

  createEffect(options.silhouetteTarget, (target) => {
    targetSilhouette = target;
  });
  createEffect(
    () => ({
      enabled: options.sharedLeadingEnabled(),
      target: options.sharedLeadingTarget(),
    }),
    ({ enabled, target }) => {
      sharedLeadingEnabled = enabled;
      targetSharedLeading = target;
    },
  );
  createEffect(
    () => ({
      enabled: options.sharedTrailingEnabled(),
      target: options.sharedTrailingTarget(),
    }),
    ({ enabled, target }) => {
      sharedTrailingEnabled = enabled;
      targetSharedTrailing = target;
    },
  );
  function finishAnimation(current?: Animation[]): void {
    if (current && animations !== current) return;
    animations = [];
    const container = options.container();
    container?.removeAttribute("data-resizing");
    container?.removeAttribute("data-resize-direction");
  }

  onSettled(() => {
    const observer = new ResizeObserver(() => {
      const container = options.container();
      const content = options.content();
      if (!container || !content) return;
      const contentRect = content.getBoundingClientRect();
      const nextSize = { width: contentRect.width, height: contentRect.height };
      const previous = previousSize;
      const silhouette = options.silhouette();
      const targetGeometry = targetSilhouette;
      const previousGeometry = previousSilhouette;
      const sharedLeading = sharedLeadingEnabled ? options.sharedLeading() : undefined;
      const sharedTrailing = sharedTrailingEnabled ? options.sharedTrailing() : undefined;
      const previousLeadingTransform = previousSharedLeading;
      const previousTrailingTransform = previousSharedTrailing;
      previousSize = nextSize;
      previousSilhouette = targetGeometry;
      previousSharedLeading = targetSharedLeading;
      previousSharedTrailing = targetSharedTrailing;
      if (!previous) {
        writeContainerSize(container, nextSize);
        writeSilhouetteGeometry(silhouette, targetGeometry);
        if (sharedLeading) writeSharedTransform(sharedLeading, targetSharedLeading);
        if (sharedTrailing) writeSharedTransform(sharedTrailing, targetSharedTrailing);
        return;
      }
      if (sizesMatch(previous, nextSize) && silhouetteGeometryMatches(previousGeometry, targetGeometry)) return;
      const computed = getComputedStyle(container);
      const animatedWidth = Number.parseFloat(computed.width);
      const animatedHeight = Number.parseFloat(computed.height);
      const start =
        animations.length > 0 && Number.isFinite(animatedWidth) && Number.isFinite(animatedHeight)
          ? { width: animatedWidth, height: animatedHeight }
          : previous;
      const startGeometry =
        animations.length > 0
          ? readCurrentSilhouette(silhouette.root, silhouette.body, previousGeometry ?? targetGeometry)
          : (previousGeometry ?? targetGeometry);
      const startLeadingTransform =
        animations.length > 0
          ? readCurrentTransform(sharedLeading, previousLeadingTransform ?? targetSharedLeading)
          : (previousLeadingTransform ?? targetSharedLeading);
      const startTrailingTransform =
        animations.length > 0
          ? readCurrentTransform(sharedTrailing, previousTrailingTransform ?? targetSharedTrailing)
          : (previousTrailingTransform ?? targetSharedTrailing);

      for (const active of animations) active.cancel();
      writeContainerSize(container, nextSize);
      writeSilhouetteGeometry(silhouette, targetGeometry);
      if (sharedLeading) writeSharedTransform(sharedLeading, targetSharedLeading);
      if (sharedTrailing) writeSharedTransform(sharedTrailing, targetSharedTrailing);
      if (prefersReducedMotion()) {
        finishAnimation();
        return;
      }
      container.setAttribute("data-resizing", "true");
      const opening =
        nextSize.width > start.width ||
        nextSize.height > start.height ||
        (targetGeometry.capsuleRadius ?? 0) > (startGeometry.capsuleRadius ?? 0);
      container.setAttribute("data-resize-direction", opening ? "opening" : "closing");
      const spring = resizeSpring(container, start, nextSize, opening);
      const animationOptions: KeyframeAnimationOptions = {
        duration: spring.response * 1_000,
        easing: "linear",
      };
      const current = [container.animate(resizeKeyframes(start, nextSize, spring), animationOptions)];
      if (silhouette.body && silhouette.leadingShoulder && silhouette.trailingShoulder) {
        current.push(
          silhouette.body.animate(silhouetteBodyKeyframes(startGeometry, targetGeometry, spring), animationOptions),
          silhouette.leadingShoulder.animate(
            shoulderKeyframes(startGeometry, targetGeometry, spring),
            animationOptions,
          ),
          silhouette.trailingShoulder.animate(
            shoulderKeyframes(startGeometry, targetGeometry, spring),
            animationOptions,
          ),
        );
      }
      if (silhouette.root && startGeometry.capsuleRadius !== undefined && targetGeometry.capsuleRadius !== undefined) {
        current.push(
          silhouette.root.animate(capsuleRadiusKeyframes(startGeometry, targetGeometry, spring), animationOptions),
        );
      }
      if (sharedLeading) {
        current.push(
          sharedLeading.animate(
            sharedElementKeyframes(startLeadingTransform, targetSharedLeading, spring),
            animationOptions,
          ),
        );
      }
      if (sharedTrailing) {
        current.push(
          sharedTrailing.animate(
            sharedElementKeyframes(startTrailingTransform, targetSharedTrailing, spring),
            animationOptions,
          ),
        );
      }
      animations = current;
      void Promise.all(current.map((active) => active.finished))
        .then(() => {
          if (animations !== current) return;
          for (const active of current) active.cancel();
          finishAnimation(current);
        })
        .catch(() => undefined);
    });
    const content = options.content();
    if (content) observer.observe(content);
    return () => observer.disconnect();
  });

  onCleanup(() => {
    for (const active of animations) active.cancel();
    finishAnimation();
  });
}

function writeContainerSize(container: HTMLElement, size: { width: number; height: number }): void {
  container.style.width = `${size.width}px`;
  container.style.height = `${size.height}px`;
}

function writeSilhouetteGeometry(
  silhouette: {
    root: HTMLSpanElement | undefined;
    body: HTMLSpanElement | undefined;
    leadingShoulder: SVGSVGElement | undefined;
    trailingShoulder: SVGSVGElement | undefined;
  },
  geometry: IslandSilhouetteGeometry,
): void {
  if (silhouette.root && geometry.capsuleRadius !== undefined) {
    silhouette.root.style.borderRadius = `${geometry.capsuleRadius}px`;
  }
  if (silhouette.body) {
    silhouette.body.style.insetInlineStart = `${geometry.topRadius}px`;
    silhouette.body.style.insetInlineEnd = `${geometry.topRadius}px`;
    silhouette.body.style.borderBottomLeftRadius = `${geometry.bottomRadius}px`;
    silhouette.body.style.borderBottomRightRadius = `${geometry.bottomRadius}px`;
  }
  for (const shoulder of [silhouette.leadingShoulder, silhouette.trailingShoulder]) {
    if (!shoulder) continue;
    shoulder.style.width = `${geometry.topRadius}px`;
    shoulder.style.height = `${geometry.topRadius}px`;
  }
}

function writeSharedTransform(element: HTMLElement, transform: SharedElementTransform): void {
  element.style.transform = `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`;
}

function readCurrentTransform(
  element: HTMLElement | undefined,
  fallback: SharedElementTransform,
): SharedElementTransform {
  if (!element) return fallback;
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === "none") return { x: 0, y: 0, scale: 1 };
  return parseTransformFunctions(transform) ?? fallback;
}

function parseTransformFunctions(transform: string): SharedElementTransform | undefined {
  const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (matrix3d) {
    const values = matrix3d[1]?.split(",").map(Number);
    if (values?.length === 16 && values.every(Number.isFinite)) {
      return { x: values[12] ?? 0, y: values[13] ?? 0, scale: values[0] ?? 1 };
    }
  }

  const matrix = transform.match(/^matrix\(([^)]+)\)$/);
  if (matrix) {
    const values = matrix[1]?.split(",").map(Number);
    if (values?.length === 6 && values.every(Number.isFinite)) {
      return { x: values[4] ?? 0, y: values[5] ?? 0, scale: values[0] ?? 1 };
    }
  }

  const translate = transform.match(/translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px,\s*-?[\d.]+(?:px)?\s*\)/);
  const scale = transform.match(/scale\(\s*(-?[\d.]+)\s*\)/);
  if (!translate && !scale) return undefined;
  return {
    x: Number(translate?.[1] ?? 0),
    y: Number(translate?.[2] ?? 0),
    scale: Number(scale?.[1] ?? 1),
  };
}

function readCurrentSilhouette(
  root: HTMLElement | undefined,
  body: HTMLElement | undefined,
  fallback: IslandSilhouetteGeometry,
): IslandSilhouetteGeometry {
  const capsuleRadius = root ? Number.parseFloat(getComputedStyle(root).borderTopLeftRadius) : Number.NaN;
  if (!body) {
    return {
      ...fallback,
      capsuleRadius: Number.isFinite(capsuleRadius) ? capsuleRadius : fallback.capsuleRadius,
    };
  }
  const style = getComputedStyle(body);
  const topRadius = Number.parseFloat(style.insetInlineStart || style.left);
  const bottomRadius = Number.parseFloat(style.borderBottomLeftRadius);
  return {
    topRadius: Number.isFinite(topRadius) ? topRadius : fallback.topRadius,
    bottomRadius: Number.isFinite(bottomRadius) ? bottomRadius : fallback.bottomRadius,
    capsuleRadius: Number.isFinite(capsuleRadius) ? capsuleRadius : fallback.capsuleRadius,
  };
}

function sizesMatch(left: { width: number; height: number }, right: { width: number; height: number }): boolean {
  return Math.abs(left.width - right.width) < 0.5 && Math.abs(left.height - right.height) < 0.5;
}

function silhouetteGeometryMatches(
  left: IslandSilhouetteGeometry | undefined,
  right: IslandSilhouetteGeometry,
): boolean {
  if (!left) return false;
  return (
    Math.abs(left.topRadius - right.topRadius) < 0.5 &&
    Math.abs(left.bottomRadius - right.bottomRadius) < 0.5 &&
    Math.abs((left.capsuleRadius ?? 0) - (right.capsuleRadius ?? 0)) < 0.5
  );
}

function resizeKeyframes(
  start: { width: number; height: number },
  end: { width: number; height: number },
  spring: { response: number; dampingFraction: number },
): Keyframe[] {
  const sampleCount = 24;
  const finalProgress = springProgress(spring.response, spring);
  return Array.from({ length: sampleCount + 1 }, (_, index) => {
    const offset = index / sampleCount;
    const rawProgress = springProgress(offset * spring.response, spring);
    const progress = index === sampleCount ? 1 : rawProgress / finalProgress;
    return {
      width: `${start.width + (end.width - start.width) * progress}px`,
      height: `${start.height + (end.height - start.height) * progress}px`,
      offset,
    };
  });
}

function silhouetteBodyKeyframes(
  start: IslandSilhouetteGeometry,
  end: IslandSilhouetteGeometry,
  spring: Spring,
): Keyframe[] {
  return springKeyframes(spring, (progress) => ({
    insetInlineStart: `${mix(start.topRadius, end.topRadius, progress)}px`,
    insetInlineEnd: `${mix(start.topRadius, end.topRadius, progress)}px`,
    borderBottomLeftRadius: `${mix(start.bottomRadius, end.bottomRadius, progress)}px`,
    borderBottomRightRadius: `${mix(start.bottomRadius, end.bottomRadius, progress)}px`,
  }));
}

function shoulderKeyframes(start: IslandSilhouetteGeometry, end: IslandSilhouetteGeometry, spring: Spring): Keyframe[] {
  return springKeyframes(spring, (progress) => {
    const radius = mix(start.topRadius, end.topRadius, progress);
    return {
      width: `${radius}px`,
      height: `${radius}px`,
    };
  });
}

function capsuleRadiusKeyframes(
  start: IslandSilhouetteGeometry,
  end: IslandSilhouetteGeometry,
  spring: Spring,
): Keyframe[] {
  const startRadius = start.capsuleRadius ?? end.capsuleRadius ?? 0;
  const endRadius = end.capsuleRadius ?? startRadius;
  return springKeyframes(spring, (progress) => ({
    borderRadius: `${mix(startRadius, endRadius, progress)}px`,
  }));
}

function sharedElementKeyframes(
  start: SharedElementTransform,
  end: SharedElementTransform,
  spring: Spring,
): Keyframe[] {
  return springKeyframes(spring, (progress) => ({
    transform: `translate3d(${mix(start.x, end.x, progress)}px, ${mix(start.y, end.y, progress)}px, 0) scale(${mix(start.scale, end.scale, progress)})`,
  }));
}

interface Spring {
  response: number;
  dampingFraction: number;
}

function springKeyframes(spring: Spring, frame: (progress: number) => Keyframe): Keyframe[] {
  const sampleCount = 32;
  const finalProgress = springProgress(spring.response, spring);
  return Array.from({ length: sampleCount + 1 }, (_, index) => {
    const offset = index / sampleCount;
    const rawProgress = springProgress(offset * spring.response, spring);
    const progress = index === sampleCount ? 1 : rawProgress / finalProgress;
    return { ...frame(progress), offset };
  });
}

function mix(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function resizeSpring(
  container: HTMLElement,
  start: { width: number; height: number },
  end: { width: number; height: number },
  opening: boolean,
) {
  const isHoverResize =
    container.dataset.state === "compact" &&
    Math.abs(end.height - start.height) <= HOVER_HEIGHT_GROWTH + 0.5 &&
    Math.abs(end.width - start.width) <= HOVER_WIDTH_GROWTH + 0.5;
  if (isHoverResize) return HOVER_SPRING;
  return opening ? OPEN_SPRING : CLOSE_SPRING;
}

interface SpringContentTransitionOptions {
  content: () => HTMLDivElement | undefined;
  root: () => HTMLDivElement | undefined;
  enabled: () => boolean;
  state: () => DynamicIslandViewState;
  renderedState: () => Exclude<DynamicIslandViewState, "compact"> | null;
}

function createSpringContentTransition(options: SpringContentTransitionOptions): void {
  let animations: Animation[] = [];
  let knownContent: HTMLDivElement | undefined;
  let previousPhase = "";

  createEffect(
    () => {
      const state = options.state();
      const renderedState = options.renderedState();
      return {
        enabled: options.enabled(),
        entering: state !== "compact",
        phase: `${state}:${renderedState ?? "none"}`,
      };
    },
    ({ enabled, entering, phase }) => {
      if (!enabled || phase === previousPhase) return;
      previousPhase = phase;
      const content = options.content();
      if (!content) return;

      const isNewContent = knownContent !== content;
      const style = getComputedStyle(content);
      const startOpacity = isNewContent && entering ? 0 : Number.parseFloat(style.opacity);
      const startScale = isNewContent && entering ? 0.965 : computedScale(style.transform);
      const expandedTargets = islandMotionTargets(content);
      const compactTargets = islandMotionTargets(options.root()?.querySelector(".dynamic-island-toggle") ?? undefined);
      const currentBlurs = captureIslandBlurs([...expandedTargets, ...compactTargets]);
      knownContent = content;
      for (const active of animations) active.cancel();
      animations = [];
      const animate = content.animate?.bind(content);
      if (!animate) return;

      const reducedMotion = prefersReducedMotion();
      const current: Animation[] = [];

      if (reducedMotion) {
        for (const target of [...expandedTargets, ...compactTargets]) target.style.removeProperty("filter");
        current.push(
          animate(
            [
              { opacity: startOpacity, transform: "none" },
              { opacity: entering ? 1 : 0, transform: "none" },
            ],
            {
              duration: REDUCED_CONTENT_FADE_DURATION,
              delay: entering && isNewContent ? CONTENT_ENTER_DELAY : 0,
              easing: "linear",
              fill: "both",
            },
          ),
        );
      } else {
        current.push(
          entering
            ? animate(springContentEntranceKeyframes(startOpacity, startScale), {
                duration: CONTENT_SPRING.response * 1_000,
                delay: isNewContent ? CONTENT_ENTER_DELAY : 0,
                easing: "linear",
                fill: "both",
              })
            : animate(
                [
                  { opacity: startOpacity, transform: `translateY(0px) scale(${startScale})` },
                  { opacity: 0, transform: "translateY(-4px) scale(0.985)" },
                ],
                {
                  duration: CONTENT_EXIT_DURATION,
                  easing: "ease-in-out",
                  fill: "both",
                },
              ),
        );

        if (entering) {
          current.push(
            ...animateIslandBlur(expandedTargets, 0, {
              duration: CONTENT_BLUR_OPEN_DURATION,
              delay: isNewContent ? CONTENT_ENTER_DELAY : 0,
              initialBlur: CONTENT_BLUR,
            }),
            ...animateIslandBlur(compactTargets, CONTENT_BLUR, {
              duration: CONTENT_BLUR_OPEN_DURATION,
              initialBlurs: currentBlurs,
            }),
          );
        } else {
          current.push(
            ...animateIslandBlur(expandedTargets, CONTENT_BLUR, {
              duration: CONTENT_BLUR_CLOSE_DURATION,
              initialBlurs: currentBlurs,
            }),
            ...animateIslandBlur(compactTargets, 0, {
              duration: COMPACT_RETURN_DURATION,
              delay: CONTENT_EXIT_LEAD,
              initialBlurs: currentBlurs,
            }),
          );
        }
      }
      animations = current;
      void Promise.all(current.map((active) => active.finished))
        .then(() => {
          if (animations !== current) return;
          for (const target of expandedTargets) {
            if (entering) target.style.removeProperty("filter");
            else target.style.filter = `blur(${CONTENT_BLUR}px)`;
          }
          for (const target of compactTargets) {
            if (entering && !reducedMotion) target.style.filter = `blur(${CONTENT_BLUR}px)`;
            else target.style.removeProperty("filter");
          }
          animations = [];
          for (const active of current) active.cancel();
        })
        .catch(() => undefined);
    },
  );

  onCleanup(() => {
    for (const active of animations) active.cancel();
  });
}

function springContentEntranceKeyframes(startOpacity: number, startScale: number): Keyframe[] {
  const sampleCount = 20;
  const finalProgress = springProgress(CONTENT_SPRING.response, CONTENT_SPRING);
  return Array.from({ length: sampleCount + 1 }, (_, index) => {
    const offset = index / sampleCount;
    const rawProgress = springProgress(offset * CONTENT_SPRING.response, CONTENT_SPRING);
    const progress = index === sampleCount ? 1 : rawProgress / finalProgress;
    return {
      opacity: Math.min(1, startOpacity + (1 - startOpacity) * progress),
      transform: `scale(${startScale + (1 - startScale) * progress})`,
      offset,
    };
  });
}

interface IslandBlurAnimationOptions {
  duration: number;
  delay?: number;
  initialBlur?: number;
  initialBlurs?: ReadonlyMap<HTMLElement, number>;
}

function islandMotionTargets(root: ParentNode | undefined): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-island-motion-content]"));
}

function animateIslandBlur(targets: HTMLElement[], endBlur: number, options: IslandBlurAnimationOptions): Animation[] {
  const animations: Animation[] = [];
  const smoothBlur = "ease-in-out";
  for (const target of targets) {
    const animate = target.animate?.bind(target);
    if (!animate) continue;
    const resolvedStartBlur =
      options.initialBlur ?? options.initialBlurs?.get(target) ?? computedBlur(getComputedStyle(target).filter);
    const keyframes: Keyframe[] = [
      { filter: `blur(${resolvedStartBlur}px)`, offset: 0, easing: smoothBlur },
      { filter: `blur(${endBlur}px)`, offset: 1 },
    ];
    animations.push(
      animate(keyframes, {
        duration: options.duration,
        delay: options.delay ?? 0,
        easing: "linear",
        fill: "both",
      }),
    );
  }
  return animations;
}

function captureIslandBlurs(targets: HTMLElement[]): Map<HTMLElement, number> {
  return new Map(targets.map((target) => [target, computedBlur(getComputedStyle(target).filter)]));
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function computedScale(transform: string): number {
  if (!transform || transform === "none") return 1;
  const match = transform.match(/^matrix\(([^,]+)/);
  const scale = match ? Number.parseFloat(match[1]) : Number.NaN;
  return Number.isFinite(scale) ? scale : 1;
}

function computedBlur(filter: string): number {
  if (!filter || filter === "none") return 0;
  const match = filter.match(/blur\(([-\d.]+)px\)/);
  const blur = match ? Number.parseFloat(match[1]) : Number.NaN;
  return Number.isFinite(blur) ? blur : 0;
}

function springProgress(time: number, spring: { response: number; dampingFraction: number }): number {
  const angularFrequency = (2 * Math.PI) / spring.response;
  const damping = spring.dampingFraction;
  if (damping === 1) {
    const phase = angularFrequency * time;
    return 1 - Math.exp(-phase) * (1 + phase);
  }

  const dampedFrequency = angularFrequency * Math.sqrt(1 - damping * damping);
  const envelope = Math.exp(-damping * angularFrequency * time);
  const phase = dampedFrequency * time;
  return 1 - envelope * (Math.cos(phase) + (damping * Math.sin(phase)) / Math.sqrt(1 - damping * damping));
}
