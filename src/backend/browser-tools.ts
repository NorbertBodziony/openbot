import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { z } from "zod";

export const OPENBOT_BROWSER_NAMESPACE = "openbot_browser";

const tabId = z.string().min(1).max(INPUT_LIMITS.identifier);
const revision = z.number().int().nonnegative();
const timeout = z.number().int().min(0).max(30_000).optional();
const image = z.enum(["auto", "always", "never"]).optional();
const modifiers = z
  .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
  .max(4)
  .optional();

export const browserTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ref"), ref: tabId, revision }),
  z.object({
    kind: z.literal("role"),
    role: z.string().min(1).max(64),
    name: z.string().max(500).optional(),
    exact: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(500), exact: z.boolean().optional() }),
  z.object({ kind: z.literal("css"), selector: z.string().min(1).max(2_000) }),
  z.object({
    kind: z.literal("point"),
    x: z.number().min(0).max(INPUT_LIMITS.browserCoordinate),
    y: z.number().min(0).max(INPUT_LIMITS.browserCoordinate),
  }),
]);

export interface BrowserToolDefinition {
  name: string;
  description: string;
  shape: z.ZodRawShape;
}

function browserToolInputSchema(definition: BrowserToolDefinition) {
  return z.strictObject(definition.shape);
}

const targetAction = { tabId, target: browserTargetSchema, timeoutMs: timeout };

export const BROWSER_TOOL_DEFINITIONS: readonly BrowserToolDefinition[] = [
  {
    name: "open",
    description: "Open an HTTP(S) URL in a new persistent private-browser tab.",
    shape: { url: z.string().min(1).max(INPUT_LIMITS.browserUrl) },
  },
  { name: "list_tabs", description: "List browser tabs owned by this agent.", shape: {} },
  {
    name: "status",
    description: "Get tabs, active control state, environments, recordings, and diagnostic error counts.",
    shape: {},
  },
  {
    name: "snapshot",
    description:
      "Read the current semantic page and obtain revision-bound element references. An adaptive image is returned separately when useful.",
    shape: { tabId, image },
  },
  {
    name: "request_takeover",
    description:
      "Ask the user to take over a tab for login, consent, CAPTCHA, passkey, two-factor authentication, or another authorization step.",
    shape: { tabId },
  },
  {
    name: "navigate",
    description:
      "Navigate to an HTTP(S) URL, history entry, or reload, wait for the page to settle, and return a fresh snapshot.",
    shape: {
      tabId,
      url: z.string().min(1).max(INPUT_LIMITS.browserUrl).optional(),
      direction: z.enum(["back", "forward", "reload"]).optional(),
      timeoutMs: timeout,
    },
  },
  {
    name: "click",
    description:
      "Click a unique semantic, CSS, ref, or coordinate target using trusted CDP input and return a fresh snapshot.",
    shape: {
      ...targetAction,
      button: z.enum(["left", "middle", "right"]).optional(),
      clickCount: z.number().int().min(1).max(2).optional(),
      modifiers,
    },
  },
  {
    name: "type",
    description: "Enter text in a unique target using trusted CDP input and return a fresh snapshot.",
    shape: {
      ...targetAction,
      text: z.string().max(INPUT_LIMITS.browserActionText),
      mode: z.enum(["replace", "append"]).optional(),
      submit: z.boolean().optional(),
    },
  },
  {
    name: "press",
    description: "Press a key or shortcut such as Enter, Control+A, or Meta+Shift+P and return a fresh snapshot.",
    shape: { tabId, key: z.string().min(1).max(128), target: browserTargetSchema.optional(), timeoutMs: timeout },
  },
  {
    name: "hover",
    description: "Hover a unique target with trusted CDP pointer input and return a fresh snapshot.",
    shape: targetAction,
  },
  {
    name: "scroll",
    description: "Scroll the page or a target container by X/Y pixels and return a fresh snapshot.",
    shape: {
      tabId,
      target: browserTargetSchema.optional(),
      deltaX: z.number().min(-100_000).max(100_000).optional(),
      deltaY: z.number().min(-100_000).max(100_000).optional(),
      timeoutMs: timeout,
    },
  },
  {
    name: "select_option",
    description: "Select one or more native select options by value or label and return a fresh snapshot.",
    shape: { ...targetAction, values: z.array(z.string().max(1_000)).min(1).max(100) },
  },
  {
    name: "set_checked",
    description: "Set a checkbox or radio target to the requested checked state and return a fresh snapshot.",
    shape: { ...targetAction, checked: z.boolean() },
  },
  {
    name: "drag",
    description: "Drag from one unique target to another with trusted CDP pointer input and return a fresh snapshot.",
    shape: { tabId, source: browserTargetSchema, target: browserTargetSchema, timeoutMs: timeout },
  },
  {
    name: "upload_files",
    description:
      "Set workspace or OpenBot shared files on a file input after authorizing paths, then return a fresh snapshot.",
    shape: {
      ...targetAction,
      paths: z.array(z.string().min(1).max(INPUT_LIMITS.path)).min(1).max(INPUT_LIMITS.attachments),
    },
  },
  {
    name: "wait_for",
    description:
      "Wait for a URL, text, semantic target, load state, or DOM quiet condition, then return a fresh snapshot.",
    shape: {
      tabId,
      target: browserTargetSchema.optional(),
      text: z.string().max(2_000).optional(),
      url: z.string().max(INPUT_LIMITS.browserUrl).optional(),
      state: z.enum(["load", "domcontentloaded", "dom-quiet"]).optional(),
      timeoutMs: timeout,
    },
  },
  {
    name: "set_environment",
    description:
      "Set a memory-bounded viewport, color scheme, and reduced-motion emulation without changing browser identity or user agent.",
    shape: {
      tabId,
      preset: z.enum(["fill", "desktop", "tablet", "mobile", "custom"]).optional(),
      width: z.number().int().min(320).max(INPUT_LIMITS.browserDimension).optional(),
      height: z.number().int().min(240).max(INPUT_LIMITS.browserDimension).optional(),
      deviceScaleFactor: z.number().min(0.5).max(4).optional(),
      colorScheme: z.enum(["light", "dark", "system"]).optional(),
      reducedMotion: z.boolean().optional(),
    },
  },
  {
    name: "recording_start",
    description:
      "Start a sandboxed video-only WebM recording of a tab. It stops automatically after 5 minutes or 100 MB.",
    shape: { tabId },
  },
  {
    name: "recording_stop",
    description: "Stop a tab recording and return the saved Downloads path and artifact metadata.",
    shape: { tabId },
  },
  {
    name: "act",
    description:
      "Legacy compatibility tool. Prefer the specialized tools. Click, type, press, scroll, navigate history, or reload.",
    shape: {
      tabId,
      revision,
      action: z.object({
        type: z.enum(["click", "type", "key", "scroll", "back", "forward", "reload"]),
        ref: tabId.optional(),
        text: z.string().max(INPUT_LIMITS.browserActionText).optional(),
        submit: z.boolean().optional(),
        key: z.string().max(128).optional(),
        deltaY: z.number().optional(),
      }),
    },
  },
  { name: "screenshot", description: "Capture the visible page as a separate image content item.", shape: { tabId } },
  { name: "close_tab", description: "Close a browser tab and clean up its CDP leases and recorder.", shape: { tabId } },
] as const;

export const BROWSER_DYNAMIC_TOOLS = [
  {
    type: "namespace" as const,
    name: OPENBOT_BROWSER_NAMESPACE,
    description: "Operate OpenBot's private, persistent native Electron/CDP browser.",
    tools: BROWSER_TOOL_DEFINITIONS.map((definition) => ({
      type: "function" as const,
      name: definition.name,
      description: definition.description,
      inputSchema: z.toJSONSchema(browserToolInputSchema(definition), { target: "draft-7", unrepresentable: "any" }),
    })),
  },
];

export function parseBrowserToolArguments(tool: string, value: unknown): DynamicRecord {
  const definition = BROWSER_TOOL_DEFINITIONS.find((candidate) => candidate.name === tool);
  if (!definition) throw new Error(`Unknown browser tool: ${tool}`);
  const result = browserToolInputSchema(definition).safeParse(value);
  if (!result.success) throw new Error(`Invalid browser tool arguments: ${z.prettifyError(result.error)}`);
  return result.data;
}
