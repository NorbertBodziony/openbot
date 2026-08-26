// @vitest-environment node

import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentRuntimeLock } from "./agent-runtime-lock";
import { installClaudeRuntime, validateClaudeArchive } from "./install-claude-runtime";
import { sha256 } from "./remote-desktop-runtime-release";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform !== "win32")("bundled Claude installer", () => {
  it("installs a verified SDK binary and reuses the current runtime", async () => {
    const root = await temporaryRoot();
    const fixture = join(root, "fixture");
    const archive = join(root, "claude.tgz");
    const output = join(root, "output");
    await createPackage(fixture);
    createArchive(fixture, archive);
    const archiveBytes = await readFile(archive);
    const binary = await readFile(join(fixture, "package/claude"));
    const license = await readFile(join(fixture, "package/LICENSE.md"));
    const lock = structuredClone(await loadAgentRuntimeLock());
    lock.claude.artifacts["darwin-arm64"].assetSha256 = sha256(archiveBytes);
    lock.claude.artifacts["darwin-arm64"].binarySha256 = sha256(binary);
    lock.claude.licenseSha256 = sha256(license);
    const fetchImpl = async () => new Response(archiveBytes, { status: 200 });

    await expect(installClaudeRuntime({ outputRoot: output, target: "darwin-arm64", fetchImpl, lock })).resolves.toBe(
      "installed",
    );
    await expect(installClaudeRuntime({ outputRoot: output, target: "darwin-arm64", fetchImpl, lock })).resolves.toBe(
      "current",
    );
    await expect(readFile(join(output, "mac/arm64/claude-package.json"), "utf8")).resolves.toContain('"2.1.246"');
    await expect(readFile(join(output, "licenses/Claude-Code-LICENSE.md"), "utf8")).resolves.toBe(
      license.toString("utf8"),
    );
  });

  it("rejects links in an archive before extraction", async () => {
    const root = await temporaryRoot();
    const fixture = join(root, "fixture");
    const archive = join(root, "unsafe.tgz");
    await createPackage(fixture);
    await symlink("claude", join(fixture, "package/claude-link"));
    createArchive(fixture, archive);

    expect(() => validateClaudeArchive(archive, "claude")).toThrow("link or a special file");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-claude-runtime-test-"));
  temporaryPaths.push(root);
  return root;
}

async function createPackage(root: string): Promise<void> {
  const packageRoot = join(root, "package");
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeFile(join(packageRoot, "claude"), "#!/bin/sh\nprintf '2.1.246 (Claude Code)\\n'\n"),
    writeFile(join(packageRoot, "LICENSE.md"), "Anthropic license fixture\n"),
    writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk-darwin-arm64", version: "0.3.246" })}\n`,
    ),
  ]);
  await chmod(join(packageRoot, "claude"), 0o755);
}

function createArchive(root: string, archive: string): void {
  execFileSync("tar", ["-czf", archive, "-C", root, "package"], { stdio: "inherit" });
}
