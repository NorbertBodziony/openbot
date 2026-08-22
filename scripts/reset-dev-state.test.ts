import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { developmentStatePaths, resetDevelopmentState, resolveDevelopmentAppDataRoot } from "./reset-dev-state";
import { DEVELOPMENT_SEED_MANIFEST_FILE } from "./seed-dev-state";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("reset dev state", () => {
  it("resolves the application data root for each supported platform", () => {
    expect(resolveDevelopmentAppDataRoot("darwin", {}, "/Users/tester")).toBe(
      "/Users/tester/Library/Application Support",
    );
    expect(resolveDevelopmentAppDataRoot("win32", { APPDATA: "C:\\Users\\tester\\AppData" })).toBe(
      "C:\\Users\\tester\\AppData",
    );
    expect(resolveDevelopmentAppDataRoot("linux", {}, "/home/tester")).toBe("/home/tester/.config");
    expect(resolveDevelopmentAppDataRoot("linux", { XDG_CONFIG_HOME: "/config" })).toBe("/config");
  });

  it("deletes app, test-client, and legacy host data but keeps production data", async () => {
    const appDataRoot = await makeTemporaryDirectory();
    const [appPath, testClientPath, legacyHostPath] = developmentStatePaths(appDataRoot);
    const productionPath = join(appDataRoot, "OpenBot");

    await Promise.all([
      mkdir(appPath, { recursive: true }),
      mkdir(testClientPath, { recursive: true }),
      mkdir(legacyHostPath, { recursive: true }),
      mkdir(productionPath, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(appPath, "openbot.db"), "database"),
      writeFile(join(appPath, "openbot.db-wal"), "wal"),
      writeFile(join(appPath, "openbot.db-shm"), "shm"),
      writeFile(join(testClientPath, "openbot.db"), "test-client database"),
      writeFile(join(legacyHostPath, "openbot.db"), "legacy host database"),
      writeFile(join(productionPath, "openbot.db"), "production database"),
    ]);

    await expect(resetDevelopmentState(appDataRoot)).resolves.toEqual([appPath, testClientPath, legacyHostPath]);
    await expect(stat(appPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(testClientPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(legacyHostPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(productionPath, "openbot.db"))).resolves.toBeDefined();
  });

  it("is idempotent when no development data exists", async () => {
    const appDataRoot = await makeTemporaryDirectory();

    await expect(resetDevelopmentState(appDataRoot)).resolves.toEqual([]);
  });

  it("removes seed-owned transfers but keeps other shared files", async () => {
    const root = await makeTemporaryDirectory();
    const appDataRoot = join(root, "app-data");
    const homeDirectory = join(root, "home");
    const [appPath] = developmentStatePaths(appDataRoot);
    const generatedRoot = join(homeDirectory, "OpenBot", "Shared", "Transfers", "generated");
    const seedDirectory = join(generatedRoot, "de305d54-75b4-431b-adb2-eb6b9e546014");
    const sharedFile = join(homeDirectory, "OpenBot", "Shared", "keep.txt");
    await Promise.all([mkdir(seedDirectory, { recursive: true }), mkdir(appPath, { recursive: true })]);
    await Promise.all([
      writeFile(join(seedDirectory, "seed.txt"), "seed"),
      writeFile(sharedFile, "keep"),
      writeFile(
        join(appPath, DEVELOPMENT_SEED_MANIFEST_FILE),
        JSON.stringify({
          version: 1,
          createdAt: "2026-08-21T10:00:00.000Z",
          transferDirectories: ["generated/de305d54-75b4-431b-adb2-eb6b9e546014"],
        }),
      ),
    ]);

    await resetDevelopmentState(appDataRoot, homeDirectory);

    await expect(stat(seedDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sharedFile)).resolves.toBeDefined();
  });

  it("rejects a filesystem root", () => {
    expect(() => developmentStatePaths("/")).toThrow("The application data root cannot be a filesystem root.");
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-dev-reset-"));
  temporaryDirectories.push(directory);
  return directory;
}
