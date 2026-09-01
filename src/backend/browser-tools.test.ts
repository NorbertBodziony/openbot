import { decodeTeamProtocolV1Event, encodeTeamProtocolV1Event } from "@openbot/contracts/team-protocol/v1";
import { describe, expect, it } from "vitest";
import { BROWSER_DYNAMIC_TOOLS, BROWSER_TOOL_DEFINITIONS, OPENBOT_BROWSER_NAMESPACE } from "./browser-tools";

describe("browser tool catalog", () => {
  it("publishes one complete provider-neutral catalog without schema drift", () => {
    const names = BROWSER_TOOL_DEFINITIONS.map((definition) => definition.name);
    const dynamicNames = BROWSER_DYNAMIC_TOOLS[0].tools.map((definition) => definition.name);

    expect(BROWSER_DYNAMIC_TOOLS[0].name).toBe(OPENBOT_BROWSER_NAMESPACE);
    expect(dynamicNames).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "request_takeover",
        "snapshot",
        "navigate",
        "click",
        "type",
        "press",
        "hover",
        "scroll",
        "select_option",
        "set_checked",
        "drag",
        "upload_files",
        "wait_for",
        "set_environment",
        "recording_start",
        "recording_stop",
        "act",
      ]),
    );
    for (const tool of BROWSER_DYNAMIC_TOOLS[0].tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("keeps detailed local activity compatible with frozen Team API v1", () => {
    const encoded = encodeTeamProtocolV1Event({
      type: "browser-control-changed",
      state: {
        sessions: [
          {
            id: "session",
            threadId: "thread",
            turnId: "turn",
            callId: "call",
            tabId: "tab",
            action: "snapshot",
            detailAction: "set-environment",
            phase: "acting",
            startedAt: new Date(0).toISOString(),
          },
        ],
      },
    });

    expect(encoded).not.toBeNull();
    const decoded = decodeTeamProtocolV1Event(JSON.parse(encoded ?? "null"));
    expect(decoded.kind).toBe("known");
    expect(encoded).not.toContain("detailAction");
  });
});
