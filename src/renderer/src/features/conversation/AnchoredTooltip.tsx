import { Portal } from "@solidjs/web";
import { createSignal, onSettled } from "solid-js";

const TOOLTIP_GAP = 8;
const TOOLTIP_VIEWPORT_MARGIN = 8;

export interface TooltipRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface TooltipPosition {
  top: number;
  left: number;
  placement: "top" | "bottom";
}

export function anchoredTooltipPosition(
  anchor: TooltipRect,
  tooltip: Pick<TooltipRect, "width" | "height">,
  viewport: { width: number; height: number },
): TooltipPosition {
  const maximumLeft = Math.max(TOOLTIP_VIEWPORT_MARGIN, viewport.width - tooltip.width - TOOLTIP_VIEWPORT_MARGIN);
  const left = clamp(anchor.left + (anchor.width - tooltip.width) / 2, TOOLTIP_VIEWPORT_MARGIN, maximumLeft);
  const topPosition = anchor.top - TOOLTIP_GAP - tooltip.height;
  const bottomPosition = anchor.bottom + TOOLTIP_GAP;
  const bottomFits = bottomPosition + tooltip.height <= viewport.height - TOOLTIP_VIEWPORT_MARGIN;
  const placement = topPosition >= TOOLTIP_VIEWPORT_MARGIN || !bottomFits ? "top" : "bottom";
  const preferredTop = placement === "top" ? topPosition : bottomPosition;
  const maximumTop = Math.max(TOOLTIP_VIEWPORT_MARGIN, viewport.height - tooltip.height - TOOLTIP_VIEWPORT_MARGIN);
  return {
    left,
    top: clamp(preferredTop, TOOLTIP_VIEWPORT_MARGIN, maximumTop),
    placement,
  };
}

export function AnchoredTooltip(props: { id: string; anchor: HTMLElement; content: string; light?: boolean }) {
  const [position, setPosition] = createSignal<TooltipPosition | null>(null);
  let tooltip: HTMLSpanElement | undefined;
  let animationFrame: number | undefined;

  const updatePosition = () => {
    if (!tooltip || !props.anchor.isConnected) return;
    const anchorBounds = props.anchor.getBoundingClientRect();
    const tooltipBounds = tooltip.getBoundingClientRect();
    setPosition(
      anchoredTooltipPosition(anchorBounds, tooltipBounds, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  };
  const schedulePosition = () => {
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(() => {
      animationFrame = undefined;
      updatePosition();
    });
  };

  onSettled(() => {
    const observer = new ResizeObserver(schedulePosition);
    observer.observe(props.anchor);
    if (tooltip) observer.observe(tooltip);
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, true);
    schedulePosition();
    return () => {
      observer.disconnect();
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", schedulePosition);
      window.removeEventListener("scroll", schedulePosition, true);
    };
  });

  return (
    <Portal>
      <span
        ref={(element) => (tooltip = element)}
        id={props.id}
        class={props.light ? "anchored-tooltip anchored-tooltip-light" : "anchored-tooltip"}
        role="tooltip"
        data-placement={position()?.placement ?? "top"}
        data-ready={position() ? "true" : "false"}
        style={{
          left: `${position()?.left ?? 0}px`,
          top: `${position()?.top ?? 0}px`,
        }}
      >
        {props.content}
      </span>
    </Portal>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
