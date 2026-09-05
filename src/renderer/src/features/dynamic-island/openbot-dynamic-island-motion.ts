import type { DynamicIslandPresentation } from "@openbot/contracts/ipc";

const MODE_SWAP_EXIT_DURATION = 160;
const MODE_SWAP_STATIC_DURATION = 240;
const MODE_SWAP_EXPAND_DURATION = 420;
const MODE_SWAP_CONTRACT_DURATION = 450;
const MODE_SWAP_REDUCED_DURATION = 120;
const MODE_SWAP_BLUR = 4;
const MODE_SWAP_OUTGOING_SCALE = 0.985;
const MODE_SWAP_INCOMING_SCALE = 0.965;
const MODE_SWAP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const MODE_SWAP_SPRING_SAMPLE_COUNT = 24;

export type IslandModeSwapSlot = "compact-leading" | "compact-trailing" | "expanded";

export interface CapturedModeLayerState {
  opacity: number;
  scale: number;
  contentBlurs: number[];
  anchor?: ModeSwapPoint;
}

export interface ModeSwapPoint {
  x: number;
  y: number;
}

export interface ModeSwapSize {
  width: number;
  height: number;
}

export function captureModeLayerStates(root: HTMLElement | undefined): Map<string, CapturedModeLayerState> {
  const captured = new Map<string, CapturedModeLayerState>();
  if (!root) return captured;
  for (const slot of root.querySelectorAll<HTMLElement>("[data-island-mode-slot]")) {
    const slotName = slot.dataset.islandModeSlot;
    if (!isModeSwapSlot(slotName)) continue;
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
        anchor: modeLayerAnchor(layer),
      });
    }
  }
  return captured;
}

export function modeSourceAnchors(
  captured: Map<string, CapturedModeLayerState>,
  mode: DynamicIslandPresentation["mode"],
): Map<IslandModeSwapSlot, ModeSwapPoint> {
  const anchors = new Map<IslandModeSwapSlot, ModeSwapPoint>();
  for (const slot of ["compact-leading", "compact-trailing"] as const) {
    const anchor = captured.get(`${slot}:${mode}`)?.anchor;
    if (anchor) anchors.set(slot, anchor);
  }
  return anchors;
}

export function restoreModeTransitionFocus(root: HTMLElement | undefined): void {
  if (!root || !(document.activeElement instanceof HTMLElement)) return;
  const activeLayer = document.activeElement.closest<HTMLElement>("[data-island-mode-layer]");
  if (!activeLayer || !root.contains(activeLayer)) return;
  root.querySelector<HTMLButtonElement>(".dynamic-island-toggle")?.focus();
}

export function primeCompactModeLayerPositions(
  root: HTMLElement | undefined,
  sourceAnchors: Map<IslandModeSwapSlot, ModeSwapPoint>,
  sourceSize: ModeSwapSize | undefined,
): Map<HTMLElement, ModeSwapPoint> {
  const offsets = new Map<HTMLElement, ModeSwapPoint>();
  if (!root) return offsets;
  const targetSize = modeSwapElementSize(root.querySelector<HTMLElement>(".dynamic-island-size-target"));
  if (!modeSwapGeometryChanged(sourceSize, targetSize)) return offsets;

  for (const slot of root.querySelectorAll<HTMLElement>("[data-island-mode-slot]")) {
    const slotName = slot.dataset.islandModeSlot;
    if (slotName !== "compact-leading" && slotName !== "compact-trailing") continue;
    const sourceAnchor = sourceAnchors.get(slotName);
    for (const layer of slot.querySelectorAll<HTMLElement>(":scope > [data-island-mode-layer]")) {
      const offset = modeSwapSpatialOffset(sourceAnchor, modeLayerAnchor(layer));
      offsets.set(layer, offset);
      layer.style.transform = modeSwapTransform(offset, 1);
      layer.dataset.islandModePrimed = "true";
    }
  }
  return offsets;
}

export function clearPrimedModeLayerPositions(root: HTMLElement | undefined): void {
  if (!root) return;
  for (const layer of root.querySelectorAll<HTMLElement>("[data-island-mode-primed]")) {
    layer.style.removeProperty("transform");
    delete layer.dataset.islandModePrimed;
  }
}

export function animateModeLayers(
  root: HTMLElement | undefined,
  captured: Map<string, CapturedModeLayerState>,
  sourceAnchors: Map<IslandModeSwapSlot, ModeSwapPoint>,
  sourceSize: ModeSwapSize | undefined,
  primedOffsets: ReadonlyMap<HTMLElement, ModeSwapPoint>,
  reducedMotion: boolean,
): Animation[] {
  if (!root) return [];
  const animations: Animation[] = [];
  const expanded = root.querySelector<HTMLElement>(".dynamic-island")?.dataset.layoutState === "expanded";
  const targetSize = modeSwapElementSize(root.querySelector<HTMLElement>(".dynamic-island-size-target"));
  const geometryChanged = !expanded && modeSwapGeometryChanged(sourceSize, targetSize);
  const enterDuration = modeSwapEnterDuration(expanded, geometryChanged, sourceSize, targetSize);
  const surfaceStartTime = expanded || reducedMotion || !geometryChanged ? undefined : modeSwapSurfaceStartTime(root);
  for (const slot of root.querySelectorAll<HTMLElement>("[data-island-mode-slot]")) {
    const slotName = slot.dataset.islandModeSlot;
    if (!isModeSwapSlot(slotName)) continue;
    for (const layer of slot.querySelectorAll<HTMLElement>(":scope > [data-island-mode-layer]")) {
      const role = layer.dataset.islandModeLayer;
      const mode = layer.dataset.islandMode;
      const animate = layer.animate?.bind(layer);
      if (!role || !mode || !animate) continue;
      const previous = captured.get(`${slotName}:${mode}`);
      const outgoing = role === "outgoing";
      const preserveSpatialPosition = expanded && slotName === "compact-leading";
      const compactSpatialSwap = !expanded && slotName !== "expanded";
      const startOpacity = previous?.opacity ?? (outgoing ? 1 : 0);
      const startScale =
        preserveSpatialPosition || compactSpatialSwap
          ? 1
          : (previous?.scale ?? (outgoing ? 1 : MODE_SWAP_INCOMING_SCALE));
      const endOpacity = outgoing ? 0 : 1;
      const endScale = preserveSpatialPosition || compactSpatialSwap ? 1 : outgoing ? MODE_SWAP_OUTGOING_SCALE : 1;
      const capturedSpatialOffset = compactSpatialSwap
        ? (primedOffsets.get(layer) ?? modeSwapSpatialOffset(sourceAnchors.get(slotName), modeLayerAnchor(layer)))
        : { x: 0, y: 0 };
      const spatialOffset = geometryChanged || outgoing ? capturedSpatialOffset : { x: 0, y: 0 };
      const duration = reducedMotion ? MODE_SWAP_REDUCED_DURATION : outgoing ? MODE_SWAP_EXIT_DURATION : enterDuration;
      const layerAnimation = animate(
        reducedMotion
          ? [
              { opacity: startOpacity, transform: "none" },
              { opacity: endOpacity, transform: "none" },
            ]
          : outgoing
            ? [
                {
                  opacity: startOpacity,
                  transform: preserveSpatialPosition ? "none" : modeSwapTransform(spatialOffset, startScale),
                },
                {
                  opacity: endOpacity,
                  transform: preserveSpatialPosition ? "none" : modeSwapTransform(spatialOffset, endScale),
                },
              ]
            : modeSwapEntranceKeyframes(startOpacity, startScale, preserveSpatialPosition, spatialOffset),
        { duration, easing: reducedMotion || outgoing ? MODE_SWAP_EASING : "linear", fill: "both" },
      );
      synchronizeModeAnimation(layerAnimation, surfaceStartTime);
      animations.push(layerAnimation);

      if (reducedMotion) continue;
      const contentElements = layer.querySelectorAll<HTMLElement>("[data-island-motion-content]");
      for (const [index, content] of Array.from(contentElements).entries()) {
        const animateContent = content.animate?.bind(content);
        if (!animateContent) continue;
        const startBlur = previous?.contentBlurs[index] ?? (outgoing ? 0 : MODE_SWAP_BLUR);
        const endBlur = outgoing ? MODE_SWAP_BLUR : 0;
        const contentAnimation = animateContent(
          outgoing
            ? [{ filter: `blur(${startBlur}px)` }, { filter: `blur(${endBlur}px)` }]
            : modeSwapBlurEntranceKeyframes(startBlur),
          { duration, easing: outgoing ? MODE_SWAP_EASING : "linear", fill: "both" },
        );
        synchronizeModeAnimation(contentAnimation, surfaceStartTime);
        animations.push(contentAnimation);
      }
    }
  }
  return animations;
}

export function modeSwapElementSize(element: HTMLElement | undefined | null): ModeSwapSize | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

export function waitForAnimations(animations: Animation[]): Promise<undefined[]> {
  return Promise.all(animations.map((animation) => animation.finished.then(() => undefined).catch(() => undefined)));
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function modeSwapEnterDuration(
  expanded: boolean,
  geometryChanged: boolean,
  sourceSize: ModeSwapSize | undefined,
  targetSize: ModeSwapSize | undefined,
): typeof MODE_SWAP_STATIC_DURATION | typeof MODE_SWAP_EXPAND_DURATION | typeof MODE_SWAP_CONTRACT_DURATION {
  if (expanded) return MODE_SWAP_EXPAND_DURATION;
  if (!geometryChanged) return MODE_SWAP_STATIC_DURATION;
  if (!sourceSize || !targetSize) return MODE_SWAP_EXPAND_DURATION;
  return targetSize.width * targetSize.height < sourceSize.width * sourceSize.height
    ? MODE_SWAP_CONTRACT_DURATION
    : MODE_SWAP_EXPAND_DURATION;
}

function modeSwapGeometryChanged(source: ModeSwapSize | undefined, target: ModeSwapSize | undefined): boolean {
  if (!source || !target) return true;
  return Math.abs(target.width - source.width) > 0.5 || Math.abs(target.height - source.height) > 0.5;
}

function modeSwapSurfaceStartTime(root: HTMLElement): CSSNumberish | undefined {
  const shell = root.querySelector<HTMLElement>(".dynamic-island-shell[data-resizing]");
  return shell?.getAnimations().find((animation) => animation.playState !== "finished")?.startTime ?? undefined;
}

function synchronizeModeAnimation(animation: Animation, startTime: CSSNumberish | undefined): void {
  if (startTime !== undefined) animation.startTime = startTime;
}

function modeSwapEntranceKeyframes(
  startOpacity: number,
  startScale: number,
  preserveSpatialPosition: boolean,
  spatialOffset: ModeSwapPoint,
): Keyframe[] {
  return modeSwapSpringKeyframes((progress) => ({
    opacity: mixModeSwapValue(startOpacity, 1, progress),
    transform: preserveSpatialPosition
      ? "none"
      : modeSwapTransform(
          {
            x: mixModeSwapValue(spatialOffset.x, 0, progress),
            y: mixModeSwapValue(spatialOffset.y, 0, progress),
          },
          mixModeSwapValue(startScale, 1, progress),
        ),
  }));
}

function modeSwapBlurEntranceKeyframes(startBlur: number): Keyframe[] {
  return modeSwapSpringKeyframes((progress) => ({ filter: `blur(${mixModeSwapValue(startBlur, 0, progress)}px)` }));
}

function modeSwapSpringKeyframes(frame: (progress: number) => Keyframe): Keyframe[] {
  const finalProgress = criticalModeSwapSpringProgress(1);
  return Array.from({ length: MODE_SWAP_SPRING_SAMPLE_COUNT + 1 }, (_, index) => {
    const offset = index / MODE_SWAP_SPRING_SAMPLE_COUNT;
    const progress =
      index === MODE_SWAP_SPRING_SAMPLE_COUNT ? 1 : criticalModeSwapSpringProgress(offset) / finalProgress;
    return { ...frame(progress), offset };
  });
}

function criticalModeSwapSpringProgress(offset: number): number {
  const phase = 2 * Math.PI * offset;
  return 1 - Math.exp(-phase) * (1 + phase);
}

function mixModeSwapValue(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function modeLayerAnchor(layer: HTMLElement): ModeSwapPoint | undefined {
  const anchor = layer.querySelector<HTMLElement>("[data-island-spatial-anchor]");
  if (!anchor) return undefined;
  const rect = anchor.getBoundingClientRect();
  return {
    x: anchor.dataset.islandSpatialAnchor === "end" ? rect.right : rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function isModeSwapSlot(value: string | undefined): value is IslandModeSwapSlot {
  return value === "compact-leading" || value === "compact-trailing" || value === "expanded";
}

function modeSwapSpatialOffset(start: ModeSwapPoint | undefined, end: ModeSwapPoint | undefined): ModeSwapPoint {
  if (!start || !end) return { x: 0, y: 0 };
  return { x: start.x - end.x, y: start.y - end.y };
}

function modeSwapTransform(offset: ModeSwapPoint, scale: number): string {
  return `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`;
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
