/// <reference types="vite/client" />

import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

declare global {
  interface Window {
    openbot: OpenBotDesktopApi;
  }
}
