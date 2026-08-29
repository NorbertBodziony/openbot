// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDynamicIslandPreference, writeDynamicIslandPreference } from "./dynamic-island-preference-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dynamic island preference store", () => {
  it("defaults to enabled when no preference exists", async () => {
    const root = await temporaryRoot();
    await expect(readDynamicIslandPreference(join(root, "dynamic-island.json"))).resolves.toEqual({ enabled: true });
  });

  it("defaults safely when the stored preference is malformed", async () => {
    const root = await temporaryRoot();
    const path = join(root, "dynamic-island.json");
    await writeFile(path, '{"version":1,"enabled":"yes"}\n');
    await expect(readDynamicIslandPreference(path)).resolves.toEqual({ enabled: true });
  });

  it("persists a preference atomically", async () => {
    const root = await temporaryRoot();
    const path = join(root, "dynamic-island.json");
    await expect(writeDynamicIslandPreference(path, false)).resolves.toEqual({ enabled: false });
    await expect(readDynamicIslandPreference(path)).resolves.toEqual({ enabled: false });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-dynamic-island-preference-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
