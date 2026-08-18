import { describe, expect, it } from "vitest";
import { isUuidV4, isValidHostname, normalizeEmailAddress } from "./validation";

describe("shared boundary validation", () => {
  it("normalizes valid email addresses", () => {
    expect(normalizeEmailAddress(" User.Name+tag@Example.COM ")).toBe("user.name+tag@example.com");
  });

  it("rejects malformed email addresses", () => {
    expect(normalizeEmailAddress("user@localhost")).toBeNull();
    expect(normalizeEmailAddress("user@@example.com")).toBeNull();
  });

  it("supports public domains and local SMTP hostnames", () => {
    expect(isValidHostname("teams.openbot.run")).toBe(true);
    expect(isValidHostname("localhost")).toBe(false);
    expect(isValidHostname("localhost", false)).toBe(true);
  });

  it("accepts only version 4 UUIDs", () => {
    expect(isUuidV4("3f5c2c9c-f0c8-4c59-9917-cb91aec9e3cd")).toBe(true);
    expect(isUuidV4("3f5c2c9c-f0c8-1c59-9917-cb91aec9e3cd")).toBe(false);
  });
});
