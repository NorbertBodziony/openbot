import { describe, expect, it } from "vitest";
import { loadAgentRuntimeLock, parseAgentRuntimeLock } from "./agent-runtime-lock";

describe("agent runtime lock", () => {
  it("loads the pinned provider runtimes for every supported target", async () => {
    const lock = await loadAgentRuntimeLock();

    expect(lock.codex.version).toBe("0.149.1");
    expect(lock.codex.artifacts["darwin-arm64"].assetSha256).toHaveLength(64);
    expect(lock.codex.artifacts["win32-x64"].assetSha256).toHaveLength(64);
    expect(lock.claude.sdkVersion).toBe("0.3.246");
    expect(lock.claude.version).toBe("2.1.246");
    expect(lock.claude.artifacts["darwin-arm64"].binarySha256).toHaveLength(64);
    expect(lock.claude.artifacts["win32-x64"].binarySha256).toHaveLength(64);
    expect(lock.grok.version).toBe("1.0.5");
    expect(lock.grok.artifacts["darwin-arm64"].assetSha256).toHaveLength(64);
    expect(lock.grok.artifacts["win32-x64"].assetSha256).toHaveLength(64);
  });

  it("rejects incomplete provider checksums", async () => {
    const lock = structuredClone(await loadAgentRuntimeLock());
    lock.codex.artifacts["darwin-arm64"].assetSha256 = "bad";

    expect(() => parseAgentRuntimeLock(lock)).toThrow("complete SHA-256");
  });
});
