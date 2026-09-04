import { describe, expect, it } from "vitest";
import {
  developmentUserDataName,
  readDevelopmentInstanceId,
  readDevelopmentProfile,
  shouldAutoStartHost,
  shouldShowDevelopmentWindow,
} from "./development-profile";

describe("development profile", () => {
  it("uses a separate userData folder for the test client", () => {
    expect(developmentUserDataName(readDevelopmentProfile("test-client"))).toBe("OpenBot Dev Test Client");
    expect(developmentUserDataName(readDevelopmentProfile("app"))).toBe("OpenBot Dev");
  });

  it("does not accept an arbitrary profile as a path component", () => {
    expect(readDevelopmentProfile("../../other")).toBe("app");
    expect(readDevelopmentInstanceId("../../other")).toBeNull();
  });

  it("isolates a fallback dev instance without accepting arbitrary path content", () => {
    expect(readDevelopmentInstanceId("5174")).toBe("5174");
    expect(developmentUserDataName("app", "5174")).toBe("OpenBot Dev 5174");
  });

  it.each([undefined, null, "host"] as const)("restores published hosting after restart for role %s", (remoteRole) => {
    expect(
      shouldAutoStartHost({
        configured: true,
        enabledOnLaunch: true,
        remoteRole,
      }),
    ).toBe(true);
    expect(
      shouldAutoStartHost({
        configured: true,
        enabledOnLaunch: false,
        remoteRole,
      }),
    ).toBe(false);
    expect(shouldAutoStartHost({ configured: false, enabledOnLaunch: true, remoteRole })).toBe(false);
  });

  it("does not publish the development test client even with a saved hosting preference", () => {
    expect(shouldAutoStartHost({ configured: true, enabledOnLaunch: true, remoteRole: "client" })).toBe(false);
  });

  it("hides the host window only in the two-client development harness", () => {
    expect(shouldShowDevelopmentWindow({ remoteRole: "host", testClientEnabled: false })).toBe(true);
    expect(shouldShowDevelopmentWindow({ remoteRole: "host", testClientEnabled: true })).toBe(false);
    expect(shouldShowDevelopmentWindow({ remoteRole: "client", testClientEnabled: true })).toBe(true);
    expect(shouldShowDevelopmentWindow({ remoteRole: null, testClientEnabled: false })).toBe(true);
  });
});
