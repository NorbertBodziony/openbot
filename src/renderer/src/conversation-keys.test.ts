import { describe, expect, it } from "vitest";
import { agentConversationKey, agentMessageKey, composerDraftKey } from "./conversation-keys";

describe("conversation keys", () => {
  it("keys drafts by server and agent", () => {
    expect(composerDraftKey({ agentId: "chief", serverId: "local" })).toBe("chief");
    expect(composerDraftKey({ agentId: "chief", serverId: "team-1" })).toBe("team-1:chief");
    expect(composerDraftKey({ agentId: "chief", serverId: "team-1" })).not.toBe(
      composerDraftKey({ agentId: "chief", serverId: "team-2" }),
    );
  });

  it("keeps conversation and message keys unambiguous", () => {
    expect(agentConversationKey("s", "a:b")).not.toBe(agentConversationKey("s:a", "b"));
    expect(agentMessageKey("chief", "m1")).toBe("chief\0m1");
  });
});
