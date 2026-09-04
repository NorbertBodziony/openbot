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

// A control's accessible name is the only thing in an accessibility tree that
// says what its value means, and `redactText` cannot help here: a login code
// is a handful of characters that match no secret shape and carry no label. So
// a node named for a one-time code, a password or a token loses what was
// entered - inline, and anywhere in its subtree, because a value does not
// always arrive as the value of the control. `OtpInput` is the case that
// matters: it clears the native input on every keystroke and rebuilds the code
// as visible characters, which reach the tree as loose text under the group
// that holds them.
const SENSITIVE_CONTROL_NAME = /one[\s-]?time|passcode|password|\botp\b|secret|token|credential|api[\s_-]?key/iu;

// One node of Playwright's aria YAML: indentation, role, quoted accessible
// name, and either an inline value after the colon or an indented subtree.
const NAMED_NODE = /^(\s*)- ([a-z]+) "((?:[^"\\]|\\.)*)"(?::(.*))?$/u;

export function redactSensitiveSnapshotValues(yaml: string): string {
  const lines: string[] = [];
  // Indentation of each sensitive node still open, innermost last. A stack
  // rather than one value: the OTP group holds the input, which is sensitive
  // too, and leaving the inner one has to stay inside the outer.
  const sensitiveIndents: number[] = [];
  // Whether the one replacement line has been written for the current run of
  // dropped nodes.
  let replaced = false;
  for (const line of yaml.split("\n")) {
    if (line.trim() === "") {
      lines.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    while (sensitiveIndents.length > 0 && indent <= (sensitiveIndents.at(-1) ?? 0)) {
      sensitiveIndents.pop();
      replaced = false;
    }
    const match = NAMED_NODE.exec(line);
    const name = match?.[3];
    if (match && name !== undefined && SENSITIVE_CONTROL_NAME.test(name)) {
      const inline = match[4]?.trim() ?? "";
      sensitiveIndents.push(indent);
      // The role and the name stay: an agent still has to see that the control
      // exists to aim `type` at it. Only what was entered goes.
      replaced = inline !== "";
      lines.push(inline === "" ? line : `${match[1]}- ${match[2]} "${name}": [redacted]`);
      continue;
    }
    if (sensitiveIndents.length === 0 || match) {
      // Outside a sensitive subtree, or a named node inside one - a named node
      // is structure the developer navigates by, and its own value is judged by
      // its own name.
      lines.push(line);
      continue;
    }
    if (!replaced) {
      lines.push(`${" ".repeat(indent)}- text: "[redacted]"`);
      replaced = true;
    }
  }
  return lines.join("\n");
}

export async function snapshotPage(page: Page, logger: Logger = dummyLogger): Promise<AutomationSnapshot> {
  // Redacted before truncation, so a secret cannot survive in the part that is
  // kept. The document leaves this process on stdout and lands in an agent
  // transcript, which is the same kind of path as a log line: a page showing
  // an API token exports it otherwise. `screenshot` is where you look when the
  // literal value is the thing under test.
  const yaml = redactText(redactSensitiveSnapshotValues(await page.ariaSnapshot({ depth: 30 })));
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
