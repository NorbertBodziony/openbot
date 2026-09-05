import { describe, expect, it } from "vitest";

import { rebaseLegacyWorkspacePath } from "./workspace-paths";

const AGENT_ID = "agent-6d3e8b17-9c04-4f21-8a55-1b2c3d4e5f60";
const LEGACY_ID = "bot-6d3e8b17-9c04-4f21-8a55-1b2c3d4e5f60";

describe("rebaseLegacyWorkspacePath", () => {
  it("finds a file the workspace move left on the other side of the rename", () => {
    const current = `/Users/dev/OpenBot/Agents/${AGENT_ID}`;
    const legacy = `/Users/dev/OpenBot/Bots/${LEGACY_ID}`;

    // The provider keeps its own transcript, and migration v13 cannot reach into it, so a resumed thread
    // still hands back the path it wrote before the workspace moved.
    expect(rebaseLegacyWorkspacePath(current, AGENT_ID, `${legacy}/app/page.tsx`)).toBe(`${current}/app/page.tsx`);
    // And the move itself gives up on EXDEV, leaving the agent in the old directory while v13 has already
    // rewritten the paths in its stored messages to the new one.
    expect(rebaseLegacyWorkspacePath(legacy, AGENT_ID, `${current}/app/page.tsx`)).toBe(`${legacy}/app/page.tsx`);

    // Neither direction is a way out of the workspace, and neither applies to a path that was never one.
    expect(rebaseLegacyWorkspacePath(current, AGENT_ID, "/Users/dev/OpenBot/Bots/secret.env")).toBeNull();
    expect(rebaseLegacyWorkspacePath(current, AGENT_ID, `${legacy}/../../secret.env`)).toBeNull();
    expect(rebaseLegacyWorkspacePath(`/Users/dev/code/${AGENT_ID}`, AGENT_ID, `${legacy}/app/page.tsx`)).toBeNull();
  });
});
