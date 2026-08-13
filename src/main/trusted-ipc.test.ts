// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isTrustedRendererUrl } from "./trusted-renderer";

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
