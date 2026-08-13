// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { AgentInitializationGate } from "./agent-initialization";

describe("AgentInitializationGate", () => {
  it("coalesces concurrent starts and keeps a successful service initialized", async () => {
    const initialize = vi.fn(async () => undefined);
    const gate = new AgentInitializationGate(initialize);

    await Promise.all([gate.start(), gate.start(), gate.start()]);
    await gate.start();

    expect(initialize).toHaveBeenCalledOnce();
  });

  it("allows an explicit retry after initialization fails", async () => {
    const initialize = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(undefined);
    const gate = new AgentInitializationGate(initialize);

    await expect(gate.start()).rejects.toThrow("startup failed");
    await expect(gate.start()).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
