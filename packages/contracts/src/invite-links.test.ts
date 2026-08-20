import { describe, expect, it } from "vitest";
import {
  createInviteUrl,
  createOpenBotInviteUrl,
  isCanonicalInviteUrl,
  isValidRemoteApiUrl,
  parseInviteUrl,
  toOpenBotInviteUrl,
} from "./invite-links";

const payload = {
  apiUrl: "https://studio-mac-k7m4q2pz-host.openbot.run/",
  serverId: "00000000-0000-4000-8000-000000000000",
  fingerprint: "a".repeat(43),
  token: "b".repeat(43),
};
const missingTokenUrl = new URL(createInviteUrl(payload));
missingTokenUrl.searchParams.delete("invite");

describe("OpenBot invite links", () => {
  it("creates and parses the canonical HTTPS invitation", () => {
    const url = createInviteUrl(payload);
    expect(url).toMatch(/^https:\/\/openbot\.run\/join\?/u);
    expect(parseInviteUrl(url)).toEqual(payload);
    expect(isCanonicalInviteUrl(url)).toBe(true);
    expect(isCanonicalInviteUrl(createOpenBotInviteUrl(payload))).toBe(false);
  });

  it("converts a canonical invitation to the desktop fallback scheme", () => {
    expect(toOpenBotInviteUrl(createInviteUrl(payload))).toBe(createOpenBotInviteUrl(payload));
    expect(parseInviteUrl(createOpenBotInviteUrl(payload))).toEqual(payload);
  });

  it("accepts approved root tunnel URLs only", () => {
    expect(isValidRemoteApiUrl("https://team-host.trycloudflare.com/")).toBe(true);
    expect(isValidRemoteApiUrl(payload.apiUrl)).toBe(true);
    expect(isValidRemoteApiUrl("http://team-host.trycloudflare.com/")).toBe(false);
    expect(isValidRemoteApiUrl("https://example.com/")).toBe(false);
    expect(isValidRemoteApiUrl(`${payload.apiUrl}path`)).toBe(false);
  });

  it.each([
    "https://evil.example/join",
    "https://openbot.run/other",
    "https://openbot.run/join/",
    "https://openbot.run:444/join",
    "https://user@openbot.run/join",
    missingTokenUrl.toString(),
    `${createInviteUrl(payload)}#fragment`,
    `${createInviteUrl(payload)}&extra=value`,
    `${createInviteUrl(payload)}&invite=duplicate`,
  ])("rejects an invalid invitation: %s", (value) => {
    expect(() => parseInviteUrl(value)).toThrow("invalid");
  });
});
