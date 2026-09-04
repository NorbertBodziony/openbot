import { describe, expect, it } from "vitest";
import { createMobileConnectUrl, parseMobileConnectUrl, validateMobileConnectHostBinding } from "./mobile-connect";

const ticket = "A_secure-one_time-ticket_1234567890abcdef";

describe("Mobile Connect URLs", () => {
  it("binds pairing to the scanned desktop and rejects a substituted redemption", () => {
    const host = { hostId: "host-a", fingerprint: "a".repeat(43) };
    expect(
      parseMobileConnectUrl(createMobileConnectUrl({ apiUrl: "https://api.openbot.run", ticket, host }))?.host,
    ).toEqual(host);
    expect(validateMobileConnectHostBinding(host, host)).toEqual(host);
    expect(() => validateMobileConnectHostBinding(host, { ...host, hostId: "host-b" })).toThrow("different desktop");
    expect(() => validateMobileConnectHostBinding(host, { ...host, fingerprint: "b".repeat(43) })).toThrow(
      "different desktop",
    );
    expect(
      parseMobileConnectUrl(`openbot://mobile-connect?api=https://api.openbot.run&ticket=${ticket}&host=host-a`),
    ).toBeNull();
  });
  it("round-trips an HTTPS account API and one-time ticket", () => {
    const url = createMobileConnectUrl({ apiUrl: "https://api.openbot.run", ticket });

    expect(parseMobileConnectUrl(url)).toEqual({ apiUrl: "https://api.openbot.run", ticket });
  });

  it("allows HTTP only for loopback and private LAN development APIs", () => {
    expect(parseMobileConnectUrl(createMobileConnectUrl({ apiUrl: "http://127.0.0.1:3100", ticket }))).toEqual({
      apiUrl: "http://127.0.0.1:3100",
      ticket,
    });
    expect(() => createMobileConnectUrl({ apiUrl: "http://auth.example.com", ticket })).toThrow(
      "Invalid Mobile Connect payload",
    );
    for (const apiUrl of ["http://10.0.0.8:3100", "http://172.16.2.4:3100", "http://192.168.1.143:3100"]) {
      expect(parseMobileConnectUrl(createMobileConnectUrl({ apiUrl, ticket }))).toEqual({ apiUrl, ticket });
    }
    expect(() => createMobileConnectUrl({ apiUrl: "http://203.0.113.10:3100", ticket })).toThrow(
      "Invalid Mobile Connect payload",
    );
  });

  it("rejects other schemes, hosts, parameters, and malformed tickets", () => {
    expect(parseMobileConnectUrl(`https://mobile-connect?api=https://api.openbot.run&ticket=${ticket}`)).toBeNull();
    expect(parseMobileConnectUrl(`openbot://other?api=https://api.openbot.run&ticket=${ticket}`)).toBeNull();
    expect(
      parseMobileConnectUrl(
        `openbot://mobile-connect?api=https://api.openbot.run&ticket=${ticket}&redirect=https://evil.example`,
      ),
    ).toBeNull();
    expect(parseMobileConnectUrl("openbot://mobile-connect?api=https://api.openbot.run&ticket=short")).toBeNull();
  });
});
