// @vitest-environment node

import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installCodexRuntime, validateCodexArchive } from "./install-codex-runtime";
import { loadNativeRuntimeLock } from "./native-runtime-lock";
import { sha256 } from "./remote-desktop-runtime-release";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform !== "win32")("bundled Codex installer", () => {
  it("installs a verified full package and reuses the current runtime", async () => {
    const root = await temporaryRoot();
    const fixture = join(root, "fixture");
    const archive = join(root, "codex.tar.gz");
    const output = join(root, "output");
    await createPackage(fixture);
    createArchive(fixture, archive);
    const archiveBytes = await readFile(archive);
    const license = Buffer.from("Apache License fixture\n");
    const lock = structuredClone(await loadNativeRuntimeLock());
    lock.codex.artifacts["darwin-arm64"].assetSha256 = sha256(archiveBytes);
    lock.codex.licenseSha256 = sha256(license);
    const fetchImpl = async (input: string | URL | Request) =>
      new Response(String(input).endsWith("/LICENSE") ? license : archiveBytes, { status: 200 });

    await expect(installCodexRuntime({ outputRoot: output, target: "darwin-arm64", fetchImpl, lock })).resolves.toBe(
      "installed",
    );
    await expect(installCodexRuntime({ outputRoot: output, target: "darwin-arm64", fetchImpl, lock })).resolves.toBe(
      "current",
    );
    await expect(readFile(join(output, "mac/arm64/codex-package.json"), "utf8")).resolves.toContain('"0.149.1"');
    await expect(readFile(join(output, "licenses/Codex-Apache-2.0.txt"), "utf8")).resolves.toBe(
      license.toString("utf8"),
    );
  });

  it("rejects links in an archive before extraction", async () => {
    const root = await temporaryRoot();
    const fixture = join(root, "fixture");
    const archive = join(root, "unsafe.tar.gz");
    await createPackage(fixture);
    await symlink("codex", join(fixture, "bin/codex-link"));
    createArchive(fixture, archive);

    expect(() => validateCodexArchive(archive)).toThrow("link or a special file");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-codex-runtime-test-"));
  temporaryPaths.push(root);
  return root;
}

async function createPackage(root: string): Promise<void> {
  await Promise.all([
    mkdir(join(root, "bin"), { recursive: true }),
    mkdir(join(root, "codex-path"), { recursive: true }),
    mkdir(join(root, "codex-resources/zsh/bin"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "bin/codex"), "#!/bin/sh\nprintf 'codex-cli 0.149.1\\n'\n"),
    writeFile(join(root, "bin/codex-code-mode-host"), "host\n"),
    writeFile(join(root, "codex-path/rg"), "rg\n"),
    writeFile(join(root, "codex-resources/zsh/bin/zsh"), "zsh\n"),
    writeFile(
      join(root, "codex-package.json"),
      `${JSON.stringify({
        layoutVersion: 1,
        version: "0.149.1",
        target: "aarch64-apple-darwin",
        variant: "codex",
        entrypoint: "bin/codex",
        resourcesDir: "codex-resources",
        pathDir: "codex-path",
      })}\n`,
    ),
  ]);
  await chmod(join(root, "bin/codex"), 0o755);
}

function createArchive(root: string, archive: string): void {
  execFileSync("tar", ["-czf", archive, "-C", root, "bin", "codex-package.json", "codex-path", "codex-resources"], {
    stdio: "inherit",
  });
}
