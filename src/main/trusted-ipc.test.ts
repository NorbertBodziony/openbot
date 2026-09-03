// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { handleTrusted, handleTrustedWithEvent } from "./trusted-ipc";
import { isTrustedRendererUrl } from "./trusted-renderer";

// electron cannot be imported outside an Electron process, and ipcMain is the
// only thing these wrappers touch, so the registration is captured instead of
// performed. Hoisted because the factory runs while ./trusted-ipc is imported,
// before this module's own body.
const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, ...arguments_: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...arguments_: unknown[]) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

const TRUSTED_EVENT = { senderFrame: { url: "openbot-app://app/index.html" } };
const UNTRUSTED_EVENT = { senderFrame: { url: "https://evil.example/index.html" } };

describe("trusted IPC renderer boundary", () => {
  it("accepts only the packaged OpenBot application origin", () => {
    expect(isTrustedRendererUrl("openbot-app://app/index.html", undefined)).toBe(true);
    expect(isTrustedRendererUrl("openbot-app://other/index.html", undefined)).toBe(false);
    expect(isTrustedRendererUrl("https://app.example/index.html", undefined)).toBe(false);
    expect(isTrustedRendererUrl(null, undefined)).toBe(false);
  });

  it("accepts only the configured development origin", () => {
    const developmentUrl = "http://localhost:5173";
    expect(isTrustedRendererUrl("http://localhost:5173/src/App.tsx", developmentUrl)).toBe(true);
    expect(isTrustedRendererUrl("http://localhost:4173/", developmentUrl)).toBe(false);
    expect(isTrustedRendererUrl("https://localhost:5173/", developmentUrl)).toBe(false);
  });
});

// The wrappers are the whole renderer-to-main trust boundary: every handler in
// the main process is registered through one of them. The static scan in
// ipc-channel-coverage.test.ts asserts that a registration here names the check,
// which is what catches a new wrapper written without it; these assert that the
// check actually rejects, which text cannot show.
describe("trusted IPC wrappers", () => {
  it("rejects a request from an untrusted renderer without running the handler", () => {
    let handled = 0;
    handleTrusted("test:reject", () => {
      handled += 1;
    });

    expect(() => registrations.get("test:reject")?.(UNTRUSTED_EVENT)).toThrow(
      "Rejected IPC request from an untrusted renderer.",
    );
    expect(handled).toBe(0);
  });

  it("decodes the payload before the handler sees it", () => {
    handleTrusted(
      "test:accept",
      (value) => `decoded:${String(value)}`,
      (payload) => [payload],
    );

    expect(registrations.get("test:accept")?.(TRUSTED_EVENT, "one")).toEqual(["decoded:one"]);
  });

  it("does not run the handler when the decoder rejects the payload", () => {
    let handled = 0;
    handleTrusted(
      "test:bad-payload",
      () => {
        throw new Error("Invalid payload.");
      },
      () => {
        handled += 1;
      },
    );

    expect(() => registrations.get("test:bad-payload")?.(TRUSTED_EVENT, "one")).toThrow("Invalid payload.");
    expect(handled).toBe(0);
  });

  // Ordering, not just outcome: decoding an untrusted renderer's payload is work done on behalf of
  // a caller already known to be rejected, so the sender check has to come first.
  it("rejects an untrusted renderer before decoding anything it sent", () => {
    let decoded = 0;
    handleTrusted(
      "test:reject-before-decode",
      (value) => {
        decoded += 1;
        return value;
      },
      (payload) => payload,
    );

    expect(() => registrations.get("test:reject-before-decode")?.(UNTRUSTED_EVENT, "one")).toThrow(
      "Rejected IPC request from an untrusted renderer.",
    );
    expect(decoded).toBe(0);
  });

  it("rejects an untrusted renderer for the event-carrying wrapper too", () => {
    let handled = 0;
    handleTrustedWithEvent("test:reject-with-event", () => {
      handled += 1;
    });

    expect(() => registrations.get("test:reject-with-event")?.(UNTRUSTED_EVENT)).toThrow(
      "Rejected IPC request from an untrusted renderer.",
    );
    expect(handled).toBe(0);
  });

  it("hands the event and the decoded payload to the handler once the renderer is trusted", () => {
    handleTrustedWithEvent(
      "test:accept-with-event",
      (value) => `decoded:${String(value)}`,
      (event, payload) => [event, payload],
    );

    expect(registrations.get("test:accept-with-event")?.(TRUSTED_EVENT, "one")).toEqual([TRUSTED_EVENT, "decoded:one"]);
  });
});
