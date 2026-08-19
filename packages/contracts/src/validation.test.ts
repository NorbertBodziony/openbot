import { describe, expect, it } from "vitest";
import {
  isOpenBotTeamApiHostname,
  isOpenBotTeamVncHostname,
  isUuidV4,
  isValidHostname,
  normalizeEmailAddress,
  slugifyTeamServerName,
} from "./validation";

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

  it("accepts readable first-level team hosts", () => {
    expect(isOpenBotTeamApiHostname("studio-mac-k7m4q2pz-host.openbot.run")).toBe(true);
    expect(isOpenBotTeamVncHostname("vnc-studio-mac-k7m4q2pz-host.openbot.run")).toBe(true);
    expect(isOpenBotTeamApiHostname("Studio-mac-k7m4q2pz-host.openbot.run")).toBe(false);
    expect(isOpenBotTeamApiHostname("studio-mac-k7m4q2p-host.openbot.run")).toBe(false);
    expect(isOpenBotTeamApiHostname("studio-mac-k7m4q2pz.teams.openbot.run")).toBe(false);
    expect(isOpenBotTeamApiHostname("host.example.com")).toBe(false);
  });

  it("slugifies friendly server names for DNS", () => {
    expect(slugifyTeamServerName(" Studio Mac ")).toBe("studio-mac");
    expect(slugifyTeamServerName("Crème & Brûlée")).toBe("creme-brulee");
    expect(slugifyTeamServerName("a".repeat(64))).toHaveLength(44);
  });
});
