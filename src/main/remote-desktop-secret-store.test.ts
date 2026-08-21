import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateRemoteDesktopCredentials } from "./remote-desktop-secret-store";

describe("loadOrCreateRemoteDesktopCredentials", () => {
  it("persists only encrypted Sunshine credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-secret-test-"));
    const cipher = {
      encrypt: (value: string) => Buffer.from(value.split("").reverse().join("")),
      decrypt: (value: Buffer) => value.toString().split("").reverse().join(""),
    };
    const first = await loadOrCreateRemoteDesktopCredentials(join(root, "runtime.json"), cipher);
    const second = await loadOrCreateRemoteDesktopCredentials(join(root, "runtime.json"), cipher);
    expect(second).toEqual(first);
    expect(first.password).toHaveLength(43);
  });
});
