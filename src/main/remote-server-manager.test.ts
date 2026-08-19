// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  isValidRemoteApiUrl,
  parseAddressUpdateUrl,
  parseJoinUrl,
  remoteAttachmentPreviewUrl,
} from "./remote-server-manager";

describe("remote server links", () => {
  it("accepts only supported root HTTPS tunnel URLs", () => {
    expect(isValidRemoteApiUrl("https://team-host.trycloudflare.com/")).toBe(true);
    expect(isValidRemoteApiUrl("https://studio-mac-k7m4q2pz-host.openbot.run/")).toBe(true);
    expect(isValidRemoteApiUrl("https://studio-mac-k7m4q2pz-host.teams.openbot.run/")).toBe(false);
    expect(isValidRemoteApiUrl("http://team-host.trycloudflare.com/")).toBe(false);
    expect(isValidRemoteApiUrl("https://team-host.trycloudflare.com/path")).toBe(false);
    expect(isValidRemoteApiUrl("https://example.com/")).toBe(false);
  });

  it("parses an OpenBot invitation", () => {
    const url = new URL("openbot://join");
    url.searchParams.set("api", "https://team-host.trycloudflare.com/");
    url.searchParams.set("server", "00000000-0000-4000-8000-000000000000");
    url.searchParams.set("fingerprint", "a".repeat(43));
    url.searchParams.set("invite", "b".repeat(43));
    expect(parseJoinUrl(url.toString())).toMatchObject({
      apiUrl: "https://team-host.trycloudflare.com/",
      serverId: "00000000-0000-4000-8000-000000000000",
      fingerprint: "a".repeat(43),
      token: "b".repeat(43),
    });
  });

  it("parses a stable openbot.run invitation", () => {
    const apiUrl = "https://studio-mac-k7m4q2pz-host.openbot.run/";
    const url = new URL("openbot://join");
    url.searchParams.set("api", apiUrl);
    url.searchParams.set("server", "00000000-0000-4000-8000-000000000000");
    url.searchParams.set("fingerprint", "a".repeat(43));
    url.searchParams.set("invite", "b".repeat(43));
    expect(parseJoinUrl(url.toString())).toMatchObject({ apiUrl });
  });

  it("rejects a link with a non-Cloudflare API URL", () => {
    expect(() => parseJoinUrl("openbot://join?api=https%3A%2F%2Fevil.example&server=x")).toThrow("invalid");
  });

  it("validates address update links and creates token-free preview URLs", () => {
    const url = new URL("openbot://update");
    url.searchParams.set("api", "https://new-api.trycloudflare.com/");
    url.searchParams.set("server", "00000000-0000-4000-8000-000000000000");
    url.searchParams.set("vnc", "new-vnc.trycloudflare.com");
    url.searchParams.set("key", "a".repeat(96));
    url.searchParams.set("signature", "b".repeat(86));
    expect(parseAddressUpdateUrl(url.toString())).toMatchObject({
      apiUrl: "https://new-api.trycloudflare.com/",
      vncHostname: "new-vnc.trycloudflare.com",
    });
    const preview = remoteAttachmentPreviewUrl("00000000-0000-4000-8000-000000000000", "draft 1");
    expect(preview).toBe("openbot-remote-attachment://00000000-0000-4000-8000-000000000000/draft%201");
    expect(preview).not.toContain("token");
  });
});
