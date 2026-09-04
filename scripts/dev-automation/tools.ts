import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
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
  return target;
}

export async function screenshotTo(page: Page, outPath: string, logger: Logger = dummyLogger): Promise<string> {
  await mkdir(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath });
  logger.info("screenshot saved", outPath);
  return outPath;
}
