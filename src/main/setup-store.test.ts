// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSetupState, writeSetupState } from "./setup-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("setup store", () => {
  it("returns incomplete setup when the v2 file is missing", async () => {
    const root = await temporaryRoot();
    await expect(readSetupState(join(root, "openbot-setup-v2.json"))).resolves.toEqual({
      completed: false,
      preferredProvider: null,
    });
  });

  it("does not accept the old consent file shape", async () => {
    const root = await temporaryRoot();
    const path = join(root, "openbot-setup-v2.json");
    await writeFile(path, '{"version":1,"acceptedAt":"2026-01-01T00:00:00.000Z"}\n');
    await expect(readSetupState(path)).resolves.toEqual({
      completed: false,
      preferredProvider: null,
    });
  });

  it("persists and reads the preferred provider", async () => {
    const root = await temporaryRoot();
    const path = join(root, "openbot-setup-v2.json");
    await writeSetupState(path, "claude");
    await expect(readSetupState(path)).resolves.toEqual({
      completed: true,
      preferredProvider: "claude",
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-setup-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
