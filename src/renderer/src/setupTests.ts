import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

export class TestResizeObserver implements ResizeObserver {
  /**
   * The observers that are currently watching something.
   *
   * Membership follows the observed elements rather than construction, because
   * the browser keeps an observer alive only while it has a target: one that has
   * released every element holds nothing open and is collected. Counting
   * constructed instances instead would report a leak for any library that
   * releases with `unobserve` rather than `disconnect` - `@tanstack/virtual-core`
   * is one - and miss nothing in return.
   */
  static readonly instances = new Set<TestResizeObserver>();

  readonly #elements = new Set<Element>();

  // No constructor: the callback is discarded, because no test drives a resize.
  // They only assert on `instances`.

  disconnect(): void {
    this.#elements.clear();
    TestResizeObserver.instances.delete(this);
  }

  observe(element: Element): void {
    this.#elements.add(element);
    TestResizeObserver.instances.add(this);
  }

  unobserve(element: Element): void {
    this.#elements.delete(element);
    if (this.#elements.size === 0) TestResizeObserver.instances.delete(this);
  }
}

globalThis.ResizeObserver = TestResizeObserver;
globalThis.scrollTo = () => undefined;

const htmlElement = globalThis.HTMLElement;
if (htmlElement && !htmlElement.prototype.scrollIntoView) {
  htmlElement.prototype.scrollIntoView = () => undefined;
}
if (htmlElement && !htmlElement.prototype.scrollTo) {
  htmlElement.prototype.scrollTo = () => undefined;
}

afterEach(() => {
  cleanup();
  TestResizeObserver.instances.clear();
});
