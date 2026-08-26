import { describe, expect, it } from "vitest";
import { canCheckRendererPermission, canRequestRendererPermission } from "./renderer-permissions";

const developmentUrl = "http://localhost:5173";

describe("renderer permissions", () => {
  it("allows sanitized clipboard writes only from the trusted renderer", () => {
    expect(canCheckRendererPermission("clipboard-sanitized-write", developmentUrl, {}, developmentUrl)).toBe(true);
    expect(
      canRequestRendererPermission("clipboard-sanitized-write", `${developmentUrl}/settings`, {}, developmentUrl),
    ).toBe(true);
    expect(canCheckRendererPermission("clipboard-sanitized-write", "https://example.com", {}, developmentUrl)).toBe(
      false,
    );
    expect(canCheckRendererPermission("clipboard-read", developmentUrl, {}, developmentUrl)).toBe(false);
  });

  it("keeps media access limited to audio from the trusted renderer", () => {
    expect(canCheckRendererPermission("media", developmentUrl, { mediaType: "audio" }, developmentUrl)).toBe(true);
    expect(canCheckRendererPermission("media", developmentUrl, { mediaType: "video" }, developmentUrl)).toBe(false);
    expect(canRequestRendererPermission("media", developmentUrl, { mediaTypes: ["audio"] }, developmentUrl)).toBe(true);
    expect(
      canRequestRendererPermission("media", developmentUrl, { mediaTypes: ["audio", "video"] }, developmentUrl),
    ).toBe(false);
  });
});
