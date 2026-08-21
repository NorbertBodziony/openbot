import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenBotCloudflaredExecutable } from "./cloudflared-artifact";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveOpenBotCloudflaredExecutable", () => {
  it("prefers the packaged OpenBot artifact", async () => {
    const root = await temporaryDirectory();
    const executable = join(root, "resources", "cloudflared", "mac", "arm64", "cloudflared");
    await executableFile(executable);

    await expect(
      resolveOpenBotCloudflaredExecutable({
        isPackaged: true,
        resourcesPath: join(root, "resources"),
        sourceRoot: join(root, "source"),
        platform: "darwin",
        arch: "arm64",
        pathValue: "",
      }),
    ).resolves.toBe(executable);
  });

  it("uses the source artifact during development", async () => {
    const root = await temporaryDirectory();
    const executable = join(root, "build", "cloudflared", "mac", "arm64", "cloudflared");
    await executableFile(executable);

    await expect(
      resolveOpenBotCloudflaredExecutable({
        isPackaged: false,
        resourcesPath: join(root, "resources"),
        sourceRoot: root,
        platform: "darwin",
        arch: "arm64",
        pathValue: "",
      }),
    ).resolves.toBe(executable);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-cloudflared-resolver-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function executableFile(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "cloudflared");
  await chmod(path, 0o755);
}
