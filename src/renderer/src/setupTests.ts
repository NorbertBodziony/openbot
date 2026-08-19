import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

globalThis.ResizeObserver = TestResizeObserver;
globalThis.scrollTo = () => undefined;

const htmlElement = globalThis.HTMLElement;
if (htmlElement && !htmlElement.prototype.scrollIntoView) {
  htmlElement.prototype.scrollIntoView = () => undefined;
}

afterEach(() => cleanup());
