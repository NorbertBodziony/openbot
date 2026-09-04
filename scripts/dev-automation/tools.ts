import { lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { dummyLogger, type Logger, redactText } from "@openbot/logging";
import type { Page } from "playwright-core";
import { describeTarget } from "./page-url";

const MAX_SNAPSHOT_LENGTH = 20_000;

// The runtime list is the only copy; the type comes from Playwright, so a
// misspelled or removed role fails to compile instead of failing deep
// inside a locator call.
export type AutomationRole = Parameters<Page["getByRole"]>[0];

const AUTOMATION_ROLES: readonly AutomationRole[] = [
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "meter",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
];

export function parseAutomationRole(value: string): AutomationRole {
  for (const role of AUTOMATION_ROLES) {
    if (role === value) return role;
  }
  throw new Error(`Unknown role "${value}". Expected one of: ${AUTOMATION_ROLES.join(", ")}.`);
}

export interface WaitTarget {
  role: AutomationRole;
  name: string;
}

// `--wait-for=<role>,<name>`. Only the first comma is structural, because an
// accessible name legitimately contains one ("Send to Alice, Bob").
export function parseWaitTarget(value: string): WaitTarget {
  const separator = value.indexOf(",");
  if (separator < 1) {
    throw new Error('--wait-for must be <role>,<name>, for example --wait-for=button,"New thread".');
  }
  const name = value.slice(separator + 1).trim();
  if (name === "") throw new Error("--wait-for needs an accessible name after the role.");
  return { role: parseAutomationRole(value.slice(0, separator).trim()), name };
}

// Without this every command was a race: a click returns as soon as the event
// is dispatched, so the snapshot that follows shows the state before the
// update landed, and the only workaround was re-running snapshot in a loop.
// Waiting on an accessible role and name is the same contract the assertions
// in this repository use - never on the clock.
export async function waitForRole(
  page: Page,
  target: WaitTarget,
  timeoutMs: number,
  logger: Logger = dummyLogger,
): Promise<void> {
  logger.info(`wait-for role=${target.role} name=${target.name}`);
  await page.getByRole(target.role, { name: target.name }).first().waitFor({ state: "visible", timeout: timeoutMs });
}

export interface AutomationSnapshot {
  url: string;
  title: string;
  accessibility: string;
}

export async function snapshotPage(page: Page, logger: Logger = dummyLogger): Promise<AutomationSnapshot> {
  // Redacted before truncation, so a secret cannot survive in the part that is
  // kept. The document leaves this process on stdout and lands in an agent
  // transcript, which is the same kind of path as a log line: a page showing
  // an API token exports it otherwise. `screenshot` is where you look when the
  // literal value is the thing under test.
  const yaml = redactText(await page.ariaSnapshot({ depth: 30 }));
  const snapshot: AutomationSnapshot = {
    // The sanitized location, not `page.url()`: the snapshot is a document an
    // agent prints and pastes, and a query string on the app route can carry
    // an OAuth code the redactor would not recognize.
    url: describeTarget(page.url()),
    title: redactText(await page.title()),
    accessibility: yaml.length > MAX_SNAPSHOT_LENGTH ? `${yaml.slice(0, MAX_SNAPSHOT_LENGTH)}…` : yaml,
  };
  logger.info(`snapshot ${snapshot.url}`, snapshot.title);
  return snapshot;
}

export async function clickByRole(page: Page, role: AutomationRole, name: string, timeoutMs: number): Promise<void> {
  await page.getByRole(role, { name }).click({ timeout: timeoutMs });
}

export async function typeByRole(
  page: Page,
  role: AutomationRole,
  name: string,
  text: string,
  timeoutMs: number,
  submit: boolean,
): Promise<void> {
  const control = page.getByRole(role, { name });
  await control.fill(text, { timeout: timeoutMs });
  if (submit) await control.press("Enter", { timeout: timeoutMs });
}

// `screenshot` is one of the two read-only commands, so its destination must
// stay inside the build directory: `--out=src/main/index.ts` would otherwise
// overwrite tracked code without `--allow-mutations`, and `screenshotTo`
// creates missing parents on the way.
export function resolveScreenshotPath(root: string, requested: string | null, now: number): string {
  const base = resolve(root);
  if (requested === null) return resolve(base, `screenshot-${now}.png`);
  if (requested === "") throw new Error("--out=<path> cannot be empty.");
  const target = resolve(base, requested);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`--out must stay inside ${base}. Screenshots never write outside the build directory.`);
  }
  if (!target.endsWith(".png")) throw new Error("--out must name a .png file.");
  assertNoSymlinkOnPath(base, target);
  return target;
}

// The containment check above is lexical, and `page.screenshot` follows links:
// a symlink at the destination, or on any directory below the build root,
// would let a read-only command overwrite a file outside it without
// `--allow-mutations`. Components that do not exist yet are the normal case
// and are fine - `mkdir` will create real directories for them.
function assertNoSymlinkOnPath(base: string, target: string): void {
  const steps = relative(base, target).split(sep);
  let current = base;
  for (const step of [".", ...steps]) {
    current = step === "." ? base : resolve(current, step);
    let link = false;
    try {
      link = lstatSync(current).isSymbolicLink();
    } catch {
      // Nothing there yet, so nothing can redirect the write.
      return;
    }
    if (link) {
      throw new Error(
        `${current} is a symbolic link, so writing through it would leave ${base}. ` +
          "Screenshots never follow a link out of the build directory.",
      );
    }
  }
}

// The absolute path carries the home directory, which is a checkout location
// the developer chose - the same reason `instances` redacts `projectRoot`. A
// path relative to the worktree drops that prefix and is still what an agent
// needs to open the file. If what is left would be redacted, the caller could
// not reopen it, so say so instead of handing back an unusable path.
export function reportableScreenshotPath(out: string, workspace: string): string {
  const reportable = relative(workspace, out);
  const redacted = redactText(reportable);
  if (redacted !== reportable) {
    throw new Error(
      `--out=${reportable} would be redacted on the way out, so the saved file could not be reopened. ` +
        "Pick a name without a credential or an address in it.",
    );
  }
  return reportable;
}

export async function screenshotTo(page: Page, outPath: string, logger: Logger = dummyLogger): Promise<string> {
  await mkdir(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath });
  logger.info("screenshot saved", outPath);
  return outPath;
}
