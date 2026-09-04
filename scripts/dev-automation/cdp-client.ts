// Connects to the already-running dev app over CDP. Never launches Electron
// itself: `bun run dev` owns the API, the seed and the SQLite profile, and a
// second instance would fight it for ports and the single-instance lock.

import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { Logger } from "@openbot/logging";
import { type Browser, chromium, type Page } from "playwright-core";

export const DEFAULT_DEV_AUTOMATION_PORT = 9_333;

export function readAutomationPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DEV_AUTOMATION_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("OPENBOT_DEV_REMOTE_DEBUGGING_PORT must be an integer from 1024 to 65535.");
  }
  return port;
}

export interface AutomationSession {
  browser: Browser;
  page: Page;
  close: () => Promise<void>;
}

async function describeTargets(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`CDP answered ${response.status}.`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("CDP answered without a target list.");
  return payload
    .filter(isDynamicRecord)
    .filter((target) => target.type === "page")
    .map(
      (target) => `- ${isString(target.title) ? target.title : "untitled"} ${isString(target.url) ? target.url : ""}`,
    )
    .join("\n");
}

export async function connectToDevApp(port: number, logger: Logger): Promise<AutomationSession> {
  let targets: string;
  try {
    targets = await describeTargets(port);
  } catch {
    throw new Error(
      `No dev app answers on 127.0.0.1:${port}. Reuse the running instance (` +
        "`bun run dev`) instead of starting a second one; " +
        "it owns the API, the seed and the dev profile.",
    );
  }
  logger.info(`CDP targets on :${port}`, targets || "(no pages yet)");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  // The dev app opens helper surfaces (Dynamic Island popups) beside the main
  // window, in no guaranteed order. Prefer the bare app URL; the popups carry
  // a `surface=` query param.
  const page = pages.find((candidate) => !candidate.url().includes("surface=")) ?? pages[0];
  if (!page) {
    await browser.close();
    throw new Error(`Connected over CDP but found no open window on :${port}. Focus the dev app and retry.`);
  }
  logger.info(`driving ${page.url()}`);
  page.on("console", (message) => {
    logger.debug(`renderer console [${message.type()}]`, message.text().slice(0, 500));
  });
  page.on("pageerror", (error) => {
    logger.warn("renderer pageerror", error instanceof Error ? error.message : String(error));
  });
  return {
    browser,
    page,
    close: () => browser.close(),
  };
}
