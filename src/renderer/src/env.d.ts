/// <reference types="vite/client" />

import type { OpenbotDesktopApi } from "../../shared/ipc";

declare global {
  interface Window {
    openbot: OpenbotDesktopApi;
  }
}
