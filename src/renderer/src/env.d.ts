/// <reference types="vite/client" />

import type { OpenBotDesktopApi } from "../../shared/ipc";

declare global {
  interface Window {
    openbot: OpenBotDesktopApi;
  }
}
