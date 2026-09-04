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
  // A `--page=` selector. This is dev: every window is fair game, including a
  // Dynamic Island surface and an embedded browser view showing a real site,
  // because those flows have to be testable too. The app window is only the
  // default, so a command nobody aimed cannot land in an OAuth page by
  // accident; naming a target overrides both the route filter and the preload
  // bridge probe.
  pageSelector?: string | null;
}

export interface PageChoice {
  targetId: string;
  target: string;
}

// CDP's own identifier for a page, and what `pages` prints for aiming at one.
// An array position cannot do that job: every command opens its own CDP
// connection, so a window that closed in between shifts each later page down
// and `--page=1` would drive a target nobody printed - a Dynamic Island
// surface, or an embedded view showing a real site. A target id names the same
// page in the next command or nothing at all.
export type TargetIdReader<T> = (page: T) => Promise<string>;

export async function readTargetId(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    // Playwright types this reply against the CDP protocol, so the id needs no
    // validation: it comes from the browser we already confirmed is OpenBot,
    // not from a file another account could write.
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

export async function describeDevPages<T extends { url: () => string }>(
  pages: T[],
  readId: TargetIdReader<T>,
): Promise<PageChoice[]> {
  const choices: PageChoice[] = [];
  for (const page of pages) {
    choices.push({ targetId: await readId(page), target: describeTarget(page.url()) });
  }
  return choices;
}

// A target id from `dev:automation pages`, or a case-insensitive substring of
// the target URL. The substring is matched locally against what the developer
// typed, so it never reaches a log.
export async function matchPages<T extends { url: () => string }>(
  pages: T[],
  selector: string,
  readId: TargetIdReader<T>,
): Promise<T[]> {
  const needle = selector.trim().toLowerCase();
  for (const page of pages) {
    let id = "";
    try {
      id = await readId(page);
    } catch {
      // A page closing while we ask for its id cannot be the one we were aimed
      // at, and the URL match below still gets its chance.
      continue;
    }
    if (id !== "" && id.toLowerCase() === needle) return [page];
  }
  return pages.filter((page) => page.url().toLowerCase().includes(needle));
}

export async function openDevBrowser(port: number, logger: Logger): Promise<Browser> {
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
  return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}

export function devBrowserPages(browser: Browser): Page[] {
  return browser.contexts().flatMap((context) => context.pages());
}

export async function connectToDevApp(
  port: number,
  logger: Logger,
  options: ConnectOptions = {},
): Promise<AutomationSession> {
  const browser = await openDevBrowser(port, logger);
  const expectedRendererPort = options.expectedRendererPort ?? null;
  const selector = options.pageSelector ?? null;
  const pages = devBrowserPages(browser);
  const [page, ...ambiguous] =
    selector === null
      ? await findRendererPages(pages, expectedRendererPort)
      : await matchPages(pages, selector, readTargetId);
  if (!page) {
    await browser.close();
    if (selector !== null) {
      throw new Error(
        `No page on :${port} matches --page=${selector}. Run \`bun run dev:automation pages\` ` +
          "for the current targets and their ids.",
      );
    }
    throw new Error(
      `Connected over CDP but found no OpenBot main window on :${port}` +
        (expectedRendererPort === null ? ". " : ` serving renderer :${expectedRendererPort}. `) +
        (expectedRendererPort === null
          ? "Open the app window, or aim at another target with --page=<target-id|url-substring> " +
            "from `bun run dev:automation pages`."
          : "That port now belongs to a different dev instance. Re-run `bun run dev:automation instances` " +
            "and name the instance you mean."),
    );
  }
  if (ambiguous.length > 0) {
    const choices = await describeDevPages(pages, readTargetId);
    await browser.close();
    throw new Error(
      `Found ${ambiguous.length + 1} matching pages on :${port}, so the target is ambiguous. ` +
        "Narrow it with --page=<target-id|url-substring>, or name the instance with its own --port=. " +
        `Targets on :${port}:\n${choices.map((choice) => `- ${choice.targetId}: ${choice.target}`).join("\n")}`,
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
