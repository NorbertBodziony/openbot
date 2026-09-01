// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { guardDevelopmentOutput } from "./development-output";

describe("development output", () => {
  it("exits once when the inherited terminal closes", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    const dispose = guardDevelopmentOutput([stdout, stderr], exit);

    stderr.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" }));
    stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    expect(exit).toHaveBeenCalledOnce();
    dispose();
    expect(stdout.listenerCount("error")).toBe(0);
    expect(stderr.listenerCount("error")).toBe(0);
  });

  it("does not hide unrelated stream failures", () => {
    const stderr = new EventEmitter();
    guardDevelopmentOutput([stderr], vi.fn());
    const error = Object.assign(new Error("unexpected output error"), { code: "EINVAL" });

    expect(() => stderr.emit("error", error)).toThrow(error);
  });
});
