// @vitest-environment node

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readUpdatePreference, writeUpdatePreference } from "./update-preference-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("update preference store", () => {
  it("downloads updates automatically when no preference exists", async () => {
    const root = await temporaryRoot();
    await expect(readUpdatePreference(join(root, "update.json"))).resolves.toEqual({ autoDownload: true });
  });

  it("falls back to the default when the stored preference is malformed", async () => {
    const root = await temporaryRoot();
    const path = join(root, "update.json");
    await writeFile(path, '{"version":1,"autoDownload":"yes"}\n');
    await expect(readUpdatePreference(path)).resolves.toEqual({ autoDownload: true });
  });

  it("falls back to the default when the stored preference is not valid JSON", async () => {
    const root = await temporaryRoot();
    const path = join(root, "update.json");
    await writeFile(path, "{ truncated");
    await expect(readUpdatePreference(path)).resolves.toEqual({ autoDownload: true });
  });

  it("persists an opt-out atomically without leaving temporary files", async () => {
    const root = await temporaryRoot();
    const path = join(root, "update.json");
    await expect(writeUpdatePreference(path, false)).resolves.toEqual({ autoDownload: false });
    await expect(readUpdatePreference(path)).resolves.toEqual({ autoDownload: false });
    expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("persists an opt-in over a stored opt-out", async () => {
    const root = await temporaryRoot();
    const path = join(root, "update.json");
    await writeUpdatePreference(path, false);
    await expect(writeUpdatePreference(path, true)).resolves.toEqual({ autoDownload: true });
    await expect(readUpdatePreference(path)).resolves.toEqual({ autoDownload: true });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-update-preference-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
