import { describe, expect, it } from "vitest";
import { OPENBOT_SECURITY_HEADERS } from "../src/lib/site-metadata";

describe("site metadata", () => {
  it("defines production security headers", () => {
    expect(OPENBOT_SECURITY_HEADERS).toEqual({
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
    });
  });
});
