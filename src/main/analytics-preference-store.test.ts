// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAnalyticsPreference, writeAnalyticsPreference } from "./analytics-preference-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("analytics preference store", () => {
  it("defaults to enabled when no preference exists", async () => {
    const root = await temporaryRoot();
    await expect(readAnalyticsPreference(join(root, "analytics.json"))).resolves.toEqual({ enabled: true });
  });

  it("defaults safely when the stored preference is malformed", async () => {
    const root = await temporaryRoot();
    const path = join(root, "analytics.json");
    await writeFile(path, '{"version":1,"enabled":"private"}\n');
    await expect(readAnalyticsPreference(path)).resolves.toEqual({ enabled: false });
  });

  it("persists an opt-out atomically", async () => {
    const root = await temporaryRoot();
    const path = join(root, "analytics.json");
    await expect(writeAnalyticsPreference(path, false)).resolves.toEqual({ enabled: false });
    await expect(readAnalyticsPreference(path)).resolves.toEqual({ enabled: false });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-analytics-preference-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}
