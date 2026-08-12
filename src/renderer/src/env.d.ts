/// <reference types="vite/client" />

import type { InfeldDesktopApi } from "../../shared/ipc";

declare global {
  interface Window {
    infeld: InfeldDesktopApi;
  }
}
