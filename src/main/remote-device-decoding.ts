// The devices a host exposes: its embedded browser, and its remote desktop.
// See `remote-host-decoding.ts` for why the `FromHost` suffix exists and must not be merged away.

import type {
  BrowserControlState,
  BrowserPreview,
  BrowserTab,
  RemoteDesktopCapabilities,
  RemoteDesktopSession,
} from "@openbot/contracts/ipc";
import {
  decodeRecord,
  nullableString,
  requiredBoolean,
  requiredNumber,
  requiredString,
} from "@openbot/contracts/ipc-decoding";
import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";

export function decodeBrowserTabs(value: unknown): BrowserTab[] {
  if (!Array.isArray(value) || !value.every(isBrowserTabValue)) {
    throw new Error("Invalid remote browser tabs.");
  }
  return value;
}

export function decodeBrowserTab(value: unknown): BrowserTab {
  if (!isBrowserTabValue(value)) throw new Error("Invalid remote browser tab.");
  return value;
}

export function decodeBrowserPreviewFromHost(value: unknown): BrowserPreview {
  if (!isBrowserPreviewValue(value)) throw new Error("Invalid remote browser preview.");
  return value;
}

function isBrowserPreviewValue(value: unknown): value is BrowserPreview {
  return (
    isDynamicRecord(value) &&
    isString(value.dataUrl) &&
    value.dataUrl.length <= 2_000_000 &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl) &&
    isNumber(value.width) &&
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    value.width <= 960 &&
    isNumber(value.height) &&
    Number.isSafeInteger(value.height) &&
    value.height > 0 &&
    value.height <= 600
  );
}

function isBrowserTabValue(value: unknown): value is BrowserTab {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.url) &&
    isBoolean(value.loading) &&
    (value.ownerThreadId === null || isString(value.ownerThreadId)) &&
    (value.ownerAgentId === null || isString(value.ownerAgentId))
  );
}

export function decodeBrowserControlState(value: unknown): BrowserControlState {
  if (!isBrowserControlStateValue(value)) {
    throw new Error("Invalid remote browser control state.");
  }
  return value;
}

function isBrowserControlStateValue(value: unknown): value is BrowserControlState {
  return isDynamicRecord(value) && Array.isArray(value.sessions);
}

export function decodeRemoteDesktopCapabilities(value: unknown): RemoteDesktopCapabilities {
  const record = decodeRecord(value, "remote control capabilities");
  const platform = requiredString(record, "platform");
  if (!isOneOf(["darwin", "win32", "linux"] as const, platform)) throw new Error("Invalid remote platform.");
  return {
    ready: requiredBoolean(record, "ready"),
    platform,
    unattended: requiredBoolean(record, "unattended"),
    runtime: requiredString(record, "runtime") === "sunshine-moonlight" ? "sunshine-moonlight" : invalidRuntime(),
    protocolVersion: requiredNumber(record, "protocolVersion") === 2 ? 2 : invalidProtocolVersion(),
    displays: decodeRemoteDesktopDisplays(record.displays),
    selectedDisplayId: nullableString(record, "selectedDisplayId"),
    activeSessions: requiredNumber(record, "activeSessions"),
    maxSessions: requiredNumber(record, "maxSessions"),
  };
}

function invalidRuntime(): never {
  throw new Error("Invalid remote desktop runtime.");
}

function invalidProtocolVersion(): never {
  throw new Error("Remote desktop update required.");
}

export function decodeRemoteDesktopSession(value: unknown): RemoteDesktopSession {
  const record = decodeRecord(value, "remote control session");
  const phase = requiredString(record, "phase");
  const transport = requiredString(record, "transport");
  const errorCode = nullableString(record, "errorCode");
  if (!isOneOf(["starting_host", "connecting", "connected", "disconnecting", "error"] as const, phase)) {
    throw new Error("Invalid remote control phase.");
  }
  if (!isOneOf(["unknown", "p2p", "relay"] as const, transport)) throw new Error("Invalid remote transport.");
  if (
    errorCode !== null &&
    !isOneOf(
      [
        "host_unavailable",
        "host_permissions_required",
        "session_capacity_reached",
        "session_expired",
        "session_revoked",
        "protocol_mismatch",
        "connection_failed",
      ] as const,
      errorCode,
    )
  ) {
    throw new Error("Invalid remote control error.");
  }
  return {
    id: requiredString(record, "id"),
    serverId: requiredString(record, "serverId"),
    viewerUrl: requiredString(record, "viewerUrl"),
    viewerGrant: requiredString(record, "viewerGrant"),
    displays: decodeRemoteDesktopDisplays(record.displays),
    selectedDisplayId: nullableString(record, "selectedDisplayId"),
    phase,
    transport,
    errorCode,
    message: nullableString(record, "message"),
    createdAt: requiredString(record, "createdAt"),
    grantExpiresAt: requiredString(record, "grantExpiresAt"),
  };
}

function decodeRemoteDesktopDisplays(value: unknown): RemoteDesktopCapabilities["displays"] {
  if (!Array.isArray(value)) throw new Error("Invalid remote display list.");
  return value.map((item) => {
    const display = decodeRecord(item, "remote display");
    return {
      id: requiredString(display, "id"),
      label: requiredString(display, "label"),
      width: requiredNumber(display, "width"),
      height: requiredNumber(display, "height"),
      primary: requiredBoolean(display, "primary"),
    };
  });
}
