import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  BrowserBounds,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserVisibilityInput,
} from "@openbot/contracts/ipc";
import { isBoolean, isNumber } from "@openbot/contracts/runtime-values";
import { isObject, requireString } from "./validation";

export function parseBrowserOpen(value: unknown): BrowserOpenInput {
  if (!isObject(value)) throw new Error("Invalid browser open request.");
  if (value.focus !== undefined && !isBoolean(value.focus)) throw new Error("Invalid browser focus request.");
  return {
    url: requireString(value.url, "url", INPUT_LIMITS.browserUrl),
    ownerThreadId:
      value.ownerThreadId === null || value.ownerThreadId === undefined
        ? null
        : requireString(value.ownerThreadId, "ownerThreadId"),
    ownerAgentId:
      value.ownerAgentId === null || value.ownerAgentId === undefined
        ? null
        : requireString(value.ownerAgentId, "ownerAgentId"),
    focus: value.focus ?? false,
  };
}

export function parseBrowserNavigate(value: unknown): BrowserNavigateInput {
  if (!isObject(value) || (value.direction !== "back" && value.direction !== "forward")) {
    throw new Error("Invalid browser navigation request.");
  }
  return {
    tabId: requireString(value.tabId, "tabId"),
    direction: value.direction,
  };
}

export function parseVisibility(value: unknown): BrowserVisibilityInput {
  if (!isObject(value) || !isBoolean(value.visible)) {
    throw new Error("Invalid browser visibility request.");
  }
  return {
    visible: value.visible,
    bounds: value.bounds === undefined ? undefined : parseBounds(value.bounds),
    ...(value.target === undefined ? {} : { target: parseBrowserViewTarget(value.target) }),
  };
}

export function parseBrowserBounds(value: unknown): BrowserBounds {
  return parseBounds(value);
}

function parseBrowserViewTarget(value: unknown): "main" | "picture-in-picture" {
  if (value === "main" || value === "picture-in-picture") return value;
  throw new Error("Invalid browser view target.");
}

function parseBounds(value: unknown): BrowserBounds {
  if (!isObject(value)) throw new Error("Invalid browser bounds.");
  return {
    x: finiteBound(value.x, "x"),
    y: finiteBound(value.y, "y"),
    width: finiteBound(value.width, "width"),
    height: finiteBound(value.height, "height"),
  };
}

function finiteBound(value: unknown, field: string): number {
  if (!isNumber(value) || !Number.isFinite(value)) {
    throw new Error(`Invalid browser bound: ${field}.`);
  }
  return value;
}
