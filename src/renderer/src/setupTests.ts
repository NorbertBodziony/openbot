import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

export class TestResizeObserver implements ResizeObserver {
  static readonly instances = new Set<TestResizeObserver>();

  readonly #callback: ResizeObserverCallback;
  readonly #elements = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    TestResizeObserver.instances.add(this);
  }

  disconnect(): void {
    this.#elements.clear();
    TestResizeObserver.instances.delete(this);
  }

  observe(element: Element): void {
    this.#elements.add(element);
  }

  unobserve(element: Element): void {
    this.#elements.delete(element);
  }

  trigger(element: Element): void {
    if (!this.#elements.has(element)) return;
    this.#callback([], this);
  }
}

export function triggerResize(element: Element): void {
  for (const observer of TestResizeObserver.instances) observer.trigger(element);
}

globalThis.ResizeObserver = TestResizeObserver;
globalThis.scrollTo = () => undefined;

const htmlElement = globalThis.HTMLElement;
if (htmlElement && !htmlElement.prototype.scrollIntoView) {
  htmlElement.prototype.scrollIntoView = () => undefined;
}

afterEach(() => {
  cleanup();
  TestResizeObserver.instances.clear();
});
