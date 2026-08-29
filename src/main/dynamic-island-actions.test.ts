// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { performDynamicIslandCriticalAction } from "./dynamic-island-actions";

describe("performDynamicIslandCriticalAction", () => {
  it("executes a local prompt answer directly", async () => {
    const local = localAgent();
    const remote = remoteAgent();
    await performDynamicIslandCriticalAction(
      {
        type: "answer-prompt",
        serverId: "local",
        botId: "chief",
        requestId: "prompt-local",
        answers: { source: ["Official data"] },
      },
      local,
      remote,
      () => undefined,
    );

    expect(local.respondToPrompt).toHaveBeenCalledWith({
      requestId: "prompt-local",
      answers: { source: ["Official data"] },
    });
    expect(remote.request).not.toHaveBeenCalled();
  });

  it("routes a prompt answer to its remote host", async () => {
    const local = localAgent();
    const remote = remoteAgent();
    const decodeVoid = vi.fn(() => undefined);
    await performDynamicIslandCriticalAction(
      {
        type: "answer-prompt",
        serverId: "server-eu",
        botId: "research",
        requestId: "prompt-1",
        answers: { source: ["Official data"] },
      },
      local,
      remote,
      decodeVoid,
    );

    expect(remote.request).toHaveBeenCalledWith(
      "/v1/prompts/respond",
      {
        method: "POST",
        body: { requestId: "prompt-1", answers: { source: ["Official data"] } },
      },
      "server-eu",
      decodeVoid,
    );
    expect(local.respondToPrompt).not.toHaveBeenCalled();
  });
});

function localAgent() {
  return {
    respondToPrompt: vi.fn(async () => undefined),
  };
}

function remoteAgent() {
  return { request: vi.fn(async () => undefined) };
}
