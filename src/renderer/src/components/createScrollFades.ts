import { createStore } from "solid-js";

/** Slack in pixels before an edge counts as reached, absorbing sub-pixel scroll positions. */
const EDGE_EPSILON = 2;

/**
 * Tracks whether a scrollable element has content hidden above or below it, as the one
 * `scroll-fade-top` / `scroll-fade-bottom` pair every list in the app styles against. The two
 * booleans are measured together and held in one store, so a scroll that only reveals the bottom
 * edge does not invalidate readers of the top one, and the class names live here rather than being
 * retyped at each call site.
 *
 * Bind the element with `ref={fades.bind}`, pass `measure` to `onScroll`, and call `remeasure`
 * from an effect over whatever changes the content's height. A caller that already runs its own
 * `ResizeObserver` uses `adopt` instead and keeps `measure` in its existing callback order — a
 * second observer on the same element would race the one that scrolls it.
 */
export function createScrollFades() {
  const [fades, setFades] = createStore({ bottom: false, top: false });
  let element: Element | undefined;
  let resizeObserver: ResizeObserver | undefined;

  function measure(): void {
    if (!element) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    const top = element.scrollTop > EDGE_EPSILON;
    const bottom = remaining > EDGE_EPSILON;
    setFades((state) => {
      state.top = top;
      state.bottom = bottom;
    });
  }

  function remeasure(): void {
    window.requestAnimationFrame(measure);
  }

  function adopt(next: Element): void {
    element = next;
  }

  function bind(next: Element): void {
    adopt(next);
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(next);
    remeasure();
  }

  function classes(): Record<string, boolean> {
    return { "scroll-fade-top": fades.top, "scroll-fade-bottom": fades.bottom };
  }

  function stop(): void {
    resizeObserver?.disconnect();
    resizeObserver = undefined;
  }

  return { adopt, bind, classes, measure, remeasure, stop };
}
