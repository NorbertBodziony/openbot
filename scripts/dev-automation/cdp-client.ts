// Connects to the already-running dev app over CDP. Never launches Electron
// itself: `bun run dev` owns the API, the seed and the SQLite profile, and a
// second instance would fight it for ports and the single-instance lock.

import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { Logger } from "@openbot/logging";
import { type Browser, chromium, type Page } from "playwright-core";
import { describeTarget, findMainPages } from "./page-url";

export const DEFAULT_DEV_AUTOMATION_PORT = 9_333;
export const MIN_DEV_AUTOMATION_PORT = 1_024;
export const MAX_DEV_AUTOMATION_PORT = 65_535;

// Thrown when the port answers but the browser behind it is not OpenBot.
// A class instead of a message prefix: the reconnect hint below must not
// swallow this one, and matching on wording breaks the moment it is reworded.
export class ForeignBrowserError extends Error {}

export interface ResolvedAutomationPort {
  port: number;
  explicit: boolean;
}

// An explicit `--port=` or `OPENBOT_DEV_REMOTE_DEBUGGING_PORT` names one
// instance outright. A bare default is a guess: on a machine where several
// worktrees run dev, 9333 belongs to whichever started first. The caller uses
// `explicit` to keep such a guess read-only.
export function resolveAutomationPort(
  flag: string | undefined,
  environment: string | undefined,
): ResolvedAutomationPort {
  const source = flag ?? environment;
  if (source === undefined || source.trim() === "") {
    return { port: DEFAULT_DEV_AUTOMATION_PORT, explicit: false };
  }
  const port = Number(source);
  if (!Number.isInteger(port) || port < MIN_DEV_AUTOMATION_PORT || port > MAX_DEV_AUTOMATION_PORT) {
    throw new Error(
      `OPENBOT_DEV_REMOTE_DEBUGGING_PORT must be an integer from ${MIN_DEV_AUTOMATION_PORT} to ${MAX_DEV_AUTOMATION_PORT}.`,
    );
  }
  return { port, explicit: true };
}

export interface MutationGate {
  command: string;
  allowMutations: boolean;
  // True when the target was named: an explicit port, an explicit
  // `--instance=`, or the registry record of the worktree this command runs
  // in. False for a default port and for the lone instance of some other
  // worktree, both of which are inferences.
  instanceNamed: boolean;
  // How the target was reached, for the refusal message. Empty when nothing
  // resolved.
  target?: string;
}

// The whole safety story of `click` and `type`: they need an opt-in, and the
// instance they will change has to be named rather than inferred, because
// several worktrees run dev side by side and a typed message or a click lands
// in a real profile.
export function assertMutationAllowed(gate: MutationGate): void {
  if (!gate.allowMutations) {
    throw new Error(
      `${gate.command} changes the live dev app. Re-run with --allow-mutations. ` +
        "Snapshots and screenshots stay available without it.",
    );
  }
  if (!gate.instanceNamed) {
    throw new Error(
      `${gate.command} changes the live dev app, and the instance was inferred${
        gate.target ? ` (${gate.target})` : ""
      }, not named. Run \`bun run dev:automation instances\` and re-run with ` +
        "--instance=<id> or --port=<OPENBOT_DEV_REMOTE_DEBUGGING_PORT>.",
    );
  }
}

export interface AutomationSession {
  browser: Browser;
  page: Page;
  close: () => Promise<void>;
}

// A port on the shared dev machine can belong to another Chromium. Refuse
// anything that does not identify as OpenBot before a mutation can reach it.
export function isOpenBotBrowser(userAgent: string): boolean {
  return userAgent.includes("OpenBot/");
}

// The URL shape alone cannot separate the app from an embedded browser tab:
// `BrowserHost.open` accepts any http(s) address, so a visited local
// development server can present the same loopback origin and bare path. Only
// the app window carries the preload bridge, which `contextBridge` exposes as
// `window.openbot` and no visited page can fake, so the bridge is the identity
// check a click or a keystroke is gated on.
export interface RendererCandidate {
  url: () => string;
  evaluate: (probe: string) => Promise<unknown>;
}

// Evaluated inside the page, so it is a string rather than a closure: this
// file is typechecked against Node's globals and knows nothing about `window`.
const BRIDGE_PROBE = "typeof window.openbot";

export async function findRendererPages<T extends RendererCandidate>(
  pages: T[],
  expectedRendererPort: number | null = null,
): Promise<T[]> {
  const confirmed: T[] = [];
  for (const candidate of findMainPages(pages, expectedRendererPort)) {
    try {
      if ((await candidate.evaluate(BRIDGE_PROBE)) === "object") confirmed.push(candidate);
    } catch {
      // A page navigating or closing while we probe is not the app we want.
    }
  }
  return confirmed;
}

async function describeBrowser(port: number): Promise<{ targets: string; userAgent: string }> {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!version.ok) throw new Error(`CDP answered ${version.status}.`);
  const info = await version.json();
  const userAgent = isDynamicRecord(info) && isString(info["User-Agent"]) ? info["User-Agent"] : "";
  if (!isOpenBotBrowser(userAgent)) {
    throw new ForeignBrowserError(
      `Port ${port} does not belong to OpenBot (User-Agent: ${userAgent || "unknown"}). ` +
        "Pass --port=<OPENBOT_DEV_REMOTE_DEBUGGING_PORT> of the instance you mean to drive.",
    );
  }
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`CDP answered ${response.status}.`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("CDP answered without a target list.");
  const targets = payload
    .filter(isDynamicRecord)
    .filter((target) => target.type === "page")
    .map((target) => `- ${describeTarget(isString(target.url) ? target.url : "")}`)
    .join("\n");
  return { targets, userAgent };
}

export interface ConnectOptions {
  // Set from the instance registry. Null means nothing published this port, so
  // the only check left is the OpenBot User-Agent.
  expectedRendererPort?: number | null;
}

export async function connectToDevApp(
  port: number,
  logger: Logger,
  options: ConnectOptions = {},
): Promise<AutomationSession> {
  let targets: string;
  try {
    targets = (await describeBrowser(port)).targets;
  } catch (error) {
    if (error instanceof ForeignBrowserError) throw error;
    throw new Error(
      `No dev app answers on 127.0.0.1:${port}. Reuse the running instance (` +
        "`bun run dev`) instead of starting a second one; " +
        "it owns the API, the seed and the dev profile.",
    );
  }
  logger.info(`CDP targets on :${port}`, targets || "(no pages yet)");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const expectedRendererPort = options.expectedRendererPort ?? null;
  const [page, ...ambiguous] = await findRendererPages(
    browser.contexts().flatMap((context) => context.pages()),
    expectedRendererPort,
  );
  if (!page) {
    await browser.close();
    throw new Error(
      `Connected over CDP but found no OpenBot main window on :${port}` +
        (expectedRendererPort === null ? ". " : ` serving renderer :${expectedRendererPort}. `) +
        (expectedRendererPort === null
          ? "Open the app window (helper surfaces and pages without the OpenBot preload bridge are never driven) and retry."
          : "That port now belongs to a different dev instance. Re-run `bun run dev:automation instances` " +
            "and name the instance you mean."),
    );
  }
  if (ambiguous.length > 0) {
    await browser.close();
    throw new Error(
      `Found ${ambiguous.length + 1} candidate main windows on :${port}, so the target is ambiguous. ` +
        "Close the extra window, or drive the instance you mean with its own --port=.",
    );
  }
  logger.info(`driving ${describeTarget(page.url())}`);
  page.on("console", (message) => {
    logger.debug(`renderer console [${message.type()}]`, message.text().slice(0, 500));
  });
  page.on("pageerror", (error) => {
    logger.warn("renderer pageerror", error instanceof Error ? error.message : String(error));
  });
  return {
    browser,
    page,
    // Closing a browser obtained through `connectOverCDP` closes the WebSocket
    // transport only - Playwright never sends `Browser.close` on this path - so
    // the dev app keeps running after every command.
    close: () => browser.close(),
  };
}
