// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { performDynamicIslandCriticalAction } from "./dynamic-island-actions";

describe("performDynamicIslandCriticalAction", () => {
  it("executes a local approval directly", async () => {
    const local = localAgent();
    const remote = remoteAgent();
    await performDynamicIslandCriticalAction(
      {
        type: "approve-attention",
        serverId: "local",
        botId: "chief",
        requestId: "approval-1",
      },
      local,
      remote,
      () => undefined,
    );

    expect(local.respondToApproval).toHaveBeenCalledWith({ requestId: "approval-1", decision: "accept" });
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

  it("routes an approval to its remote host", async () => {
    const local = localAgent();
    const remote = remoteAgent();
    const decodeVoid = vi.fn(() => undefined);
    await performDynamicIslandCriticalAction(
      {
        type: "approve-attention",
        serverId: "server-us",
        botId: "builder",
        requestId: 42,
      },
      local,
      remote,
      decodeVoid,
    );

    expect(remote.request).toHaveBeenCalledWith(
      "/v1/approvals/respond",
      { method: "POST", body: { requestId: 42, decision: "accept" } },
      "server-us",
      decodeVoid,
    );
    expect(local.respondToApproval).not.toHaveBeenCalled();
  });
});

function localAgent() {
  return {
    respondToApproval: vi.fn(async () => undefined),
    respondToPrompt: vi.fn(async () => undefined),
  };
}

function remoteAgent() {
  return { request: vi.fn(async () => undefined) };
}
