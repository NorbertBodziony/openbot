import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@openbot/logging";
import type { Page } from "playwright-core";

const MAX_SNAPSHOT_LENGTH = 20_000;

// The role union mirrors Playwright's getByRole signature, so an invalid role
// fails in the CLI parser with a readable message instead of deep in Playwright.
export type AutomationRole =
  | "alert"
  | "alertdialog"
  | "application"
  | "article"
  | "banner"
  | "blockquote"
  | "button"
  | "caption"
  | "cell"
  | "checkbox"
  | "code"
  | "columnheader"
  | "combobox"
  | "complementary"
  | "contentinfo"
  | "definition"
  | "deletion"
  | "dialog"
  | "directory"
  | "document"
  | "emphasis"
  | "feed"
  | "figure"
  | "form"
  | "generic"
  | "grid"
  | "gridcell"
  | "group"
  | "heading"
  | "img"
  | "insertion"
  | "link"
  | "list"
  | "listbox"
  | "listitem"
  | "log"
  | "main"
  | "marquee"
  | "math"
  | "meter"
  | "menu"
  | "menubar"
  | "menuitem"
  | "menuitemcheckbox"
  | "menuitemradio"
  | "navigation"
  | "none"
  | "note"
  | "option"
  | "paragraph"
  | "presentation"
  | "progressbar"
  | "radio"
  | "radiogroup"
  | "region"
  | "row"
  | "rowgroup"
  | "rowheader"
  | "scrollbar"
  | "search"
  | "searchbox"
  | "separator"
  | "slider"
  | "spinbutton"
  | "status"
  | "strong"
  | "subscript"
  | "superscript"
  | "switch"
  | "tab"
  | "table"
  | "tablist"
  | "tabpanel"
  | "term"
  | "textbox"
  | "time"
  | "timer"
  | "toolbar"
  | "tooltip"
  | "tree"
  | "treegrid"
  | "treeitem";

const AUTOMATION_ROLES: AutomationRole[] = [
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

export async function snapshotPage(page: Page, logger: Logger): Promise<AutomationSnapshot> {
  const yaml = await page.ariaSnapshot({ depth: 30 });
  const snapshot: AutomationSnapshot = {
    url: page.url(),
    title: await page.title(),
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

export async function waitForRole(page: Page, role: AutomationRole, name: string, timeoutMs: number): Promise<void> {
  await page.getByRole(role, { name }).waitFor({ timeout: timeoutMs });
}

export async function screenshotTo(page: Page, outPath: string, logger: Logger): Promise<string> {
  await mkdir(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath });
  logger.info("screenshot saved", outPath);
  return outPath;
}
