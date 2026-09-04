// Connects to the already-running dev app over CDP. Never launches Electron
// itself: `bun run dev` owns the API, the seed and the SQLite profile, and a
// second instance would fight it for ports and the single-instance lock.

import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { Logger } from "@openbot/logging";
import { type Browser, chromium, type Page } from "playwright-core";

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

// CDP exposes no per-profile identity (`OPENBOT_DEV_INSTANCE_ID` only changes
// the user-data directory), so two OpenBot instances are indistinguishable
// over the protocol. The caller uses `explicit` to demand `--port=` before
// any mutation, keeping a defaulted port read-only.
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
  portExplicit: boolean;
}

// The whole safety story of `click` and `type`: they need an opt-in, and they
// need the caller to name the instance, because CDP exposes no per-profile
// identity and another agent's dev app may be listening on the default port.
export function assertMutationAllowed(gate: MutationGate): void {
  if (!gate.allowMutations) {
    throw new Error(
      `${gate.command} changes the live dev app. Re-run with --allow-mutations. ` +
        "Snapshots and screenshots stay available without it.",
    );
  }
  if (!gate.portExplicit) {
    throw new Error(
      `${gate.command} changes the live dev app, and CDP cannot tell OpenBot profiles apart. ` +
        "Re-run with --port=<OPENBOT_DEV_REMOTE_DEBUGGING_PORT> naming the instance you mean to drive.",
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

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

// A page title or a full URL can carry an OAuth code, a signed download URL or
// the contents of a visited site, and log redaction recognizes none of those
// shapes. Diagnostics therefore report where a target lives, never what it
// says: an embedded browser collapses to its origin, and no title is logged.
export function describeTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "(unparseable target)";
  }
  if (!isLoopbackHost(parsed.hostname)) return `${parsed.protocol}//${parsed.hostname} (external)`;
  const surface = parsed.searchParams.get("surface");
  return `${parsed.origin}${parsed.pathname}${surface === null ? "" : ` [surface]`}`;
}

// The dev app opens helper surfaces (Dynamic Island popups) and embedded
// browser views beside the main window, in no guaranteed order. Only the bare
// renderer route on a loopback origin is the app itself - an embedded view
// showing an external site must never be a candidate, because `click` and
// `type` would land on that site instead of OpenBot.
export function isMainAppUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!isLoopbackHost(parsed.hostname)) return false;
  if (parsed.searchParams.has("surface")) return false;
  return parsed.pathname === "/" || parsed.pathname === "/index.html";
}

export function findMainPages<T extends { url: () => string }>(pages: T[]): T[] {
  return pages.filter((candidate) => isMainAppUrl(candidate.url()));
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

export async function connectToDevApp(port: number, logger: Logger): Promise<AutomationSession> {
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
  const [page, ...ambiguous] = findMainPages(browser.contexts().flatMap((context) => context.pages()));
  if (!page) {
    await browser.close();
    throw new Error(
      `Connected over CDP but found no OpenBot main window on :${port}. ` +
        "Open the app window (helper surfaces and embedded browser views are never driven) and retry.",
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
