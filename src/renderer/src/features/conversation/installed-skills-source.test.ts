import type { ServerSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { installedSkillsRequestKey } from "./installed-skills-source";

describe("installed skills request source", () => {
  it("stays stable across unrelated server summary refreshes", () => {
    const server: ServerSummary = {
      id: "local",
      name: "OpenBot",
      kind: "local",
      state: "online",
      apiUrl: null,
      remoteDesktopAvailable: false,
      logoUrl: null,
      role: "owner",
      active: true,
    };

    expect(installedSkillsRequestKey("notion", server, false)).toBe(
      installedSkillsRequestKey("notion", { ...server, connectionSequence: 2 }, false),
    );
    expect(installedSkillsRequestKey("notion", server, false)).not.toBe(
      installedSkillsRequestKey("gdrive", server, false),
    );
    expect(installedSkillsRequestKey("notion", server, false)).not.toBe(
      installedSkillsRequestKey("notion", server, true),
    );
  });
});
