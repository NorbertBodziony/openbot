import { isFunction } from "@openbot/contracts/runtime-values";
import { createSignal, onSettled } from "solid-js";

interface PanelResizerProps {
  label: string;
  controls: string;
  direction: "left" | "right";
  value: number;
  defaultValue: number;
  min: number;
  max: number | (() => number);
  onResize: (value: number) => void;
  onResizeEnd: (value: number) => void;
  snap?: {
    compactValue: number;
    compact: boolean;
    collapseThreshold: number;
    expandThreshold: number;
    onCompactChange: (compact: boolean) => void;
  };
  class?: string;
}

export function PanelResizer(props: PanelResizerProps) {
  let cleanupDrag: (() => void) | undefined;
  let handle: HTMLHRElement | undefined;
  let parentResizeObserver: ResizeObserver | undefined;
  const [isResizing, setIsResizing] = createSignal(false);

  const maximum = () => Math.max(props.min, isFunction(props.max) ? props.max() : props.max);
  const clamp = (value: number) => Math.round(Math.min(maximum(), Math.max(props.min, value)));
  const displayedValue = () => (props.snap?.compact ? props.snap.compactValue : props.value);
  const resolve = (value: number) => {
    const snap = props.snap;
    if (!snap) return { compact: false, value: clamp(value) };
    if (snap.compact) {
      return value < snap.expandThreshold
        ? { compact: true, value: snap.compactValue }
        : { compact: false, value: clamp(Math.max(props.min, value)) };
    }
    return value < snap.collapseThreshold
      ? { compact: true, value: snap.compactValue }
      : { compact: false, value: clamp(value) };
  };
  const resize = (value: number) => {
    const next = resolve(value);
    if (props.snap && next.compact !== props.snap.compact) {
      props.snap.onCompactChange(next.compact);
    }
    if (!next.compact) props.onResize(next.value);
    return next;
  };
  const commit = (value: number) => {
    const next = resize(value);
    if (!next.compact) props.onResizeEnd(next.value);
  };
  const withoutTransition = (action: () => void) => {
    document.documentElement.classList.add("panel-resizing");
    action();
    requestAnimationFrame(() => document.documentElement.classList.remove("panel-resizing"));
  };

  const enforceBounds = () => {
    const next = clamp(props.value);
    if (next !== props.value) commit(next);
  };

  onSettled(() => {
    window.addEventListener("resize", enforceBounds);
    if (handle?.parentElement) {
      parentResizeObserver = new ResizeObserver(enforceBounds);
      parentResizeObserver.observe(handle.parentElement);
    }
    return () => {
      cleanupDrag?.();
      parentResizeObserver?.disconnect();
      window.removeEventListener("resize", enforceBounds);
    };
  });

  const beginDrag = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startValue = displayedValue();
    let latestValue = startValue;
    setIsResizing(true);
    document.documentElement.classList.add("panel-resizing");

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const delta = moveEvent.clientX - startX;
      latestValue = startValue + (props.direction === "left" ? delta : -delta);
      resize(latestValue);
    };
    const finish = (finishEvent?: PointerEvent) => {
      if (finishEvent && finishEvent.pointerId !== event.pointerId) return;
      if (finishEvent) {
        const delta = finishEvent.clientX - startX;
        latestValue = startValue + (props.direction === "left" ? delta : -delta);
      }
      commit(latestValue);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      document.documentElement.classList.remove("panel-resizing");
      setIsResizing(false);
      cleanupDrag = undefined;
      if (handle.hasPointerCapture?.(event.pointerId))
        handle.releasePointerCapture(event.pointerId);
    };
    const cancel = () => finish();

    cleanupDrag?.();
    cleanupDrag = cancel;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    let next: number | undefined;
    if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      withoutTransition(() => {
        props.snap?.onCompactChange(true);
        if (!props.snap) commit(props.min);
      });
      return;
    } else if (event.key === "End") next = maximum();
    else if (event.key === "ArrowRight" && props.snap?.compact) next = props.min;
    else if (event.key === "ArrowLeft" && props.snap && props.value <= props.min) {
      event.preventDefault();
      event.stopPropagation();
      withoutTransition(() => props.snap?.onCompactChange(true));
      return;
    } else if (event.key === "ArrowLeft")
      next = props.value + (props.direction === "right" ? 12 : -12);
    else if (event.key === "ArrowRight")
      next = props.value + (props.direction === "left" ? 12 : -12);
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    withoutTransition(() => commit(next));
  };

  return (
    <hr
      ref={(element) => (handle = element)}
      class={`panel-resizer no-drag ${isResizing() ? "panel-resizer-active" : ""} ${props.class ?? ""}`}
      tabindex={0}
      aria-label={props.label}
      aria-controls={props.controls}
      aria-orientation="vertical"
      aria-valuemin={props.snap?.compactValue ?? props.min}
      aria-valuemax={maximum()}
      aria-valuenow={displayedValue()}
      aria-valuetext={
        props.snap?.compact ? `Compact (${props.snap.compactValue}px)` : `${props.value}px`
      }
      onPointerDown={beginDrag}
      onKeyDown={handleKeyDown}
      onDblClick={(event) => {
        event.preventDefault();
        commit(props.defaultValue);
      }}
    />
  );
}

export function readPanelWidth(key: string, fallback: number, min: number, max: number): number {
  const stored = Number.parseFloat(window.localStorage.getItem(key) ?? "");
  return Number.isFinite(stored) ? Math.min(max, Math.max(min, stored)) : fallback;
}

export function savePanelWidth(key: string, value: number) {
  window.localStorage.setItem(key, String(Math.round(value)));
}
