/// <reference types="vite/client" />

import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

declare global {
  interface HighlightRegistry {
    set(name: string, highlight: Highlight): this;
    delete(name: string): boolean;
  }

  interface Window {
    openbot: OpenBotDesktopApi;
  }
}
