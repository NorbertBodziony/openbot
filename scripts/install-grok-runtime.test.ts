// @vitest-environment node

import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installGrokRuntime } from "./install-grok-runtime";
import { loadNativeRuntimeLock } from "./native-runtime-lock";
import { sha256 } from "./remote-desktop-runtime-release";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform !== "win32")("bundled Grok installer", () => {
  it("installs a verified binary and reuses the current runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-grok-runtime-test-"));
    temporaryPaths.push(root);
    const output = join(root, "output");
    const executable = Buffer.from("#!/bin/sh\nprintf 'grok 1.0.5\\n'\n");
    const license = Buffer.from("Apache license fixture\n");
    const notices = Buffer.from("Third-party notices fixture\n");
    const lock = structuredClone(await loadNativeRuntimeLock());
    lock.grok.artifacts["darwin-arm64"].assetSha256 = sha256(executable);
    lock.grok.licenseSha256 = sha256(license);
    lock.grok.noticesSha256 = sha256(notices);
    const values = new Map([
      [lock.grok.artifacts["darwin-arm64"].asset, executable],
      ["LICENSE", license],
      ["THIRD-PARTY-NOTICES", notices],
    ]);
    const fetchImpl = async (input: string | URL | Request) => {
      const key = String(input).split("/").at(-1) ?? "";
      return new Response(values.get(key), { status: values.has(key) ? 200 : 404 });
    };

    await expect(installGrokRuntime({ outputRoot: output, target: "darwin-arm64", fetchImpl, lock })).resolves.toBe(
      "installed",
    );
    await expect(installGrokRuntime({ outputRoot: output, target: "darwin-arm64", fetchImpl, lock })).resolves.toBe(
      "current",
    );
    await expect(readFile(join(output, "mac/arm64/grok-package.json"), "utf8")).resolves.toContain('"1.0.5"');
    await expect(readFile(join(output, "licenses/Grok-CLI-LICENSE"), "utf8")).resolves.toBe(license.toString());
    await chmod(join(output, "mac/arm64/bin/grok"), 0o755);
  });

  it("rejects a binary with the wrong checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-grok-runtime-test-"));
    temporaryPaths.push(root);
    const lock = structuredClone(await loadNativeRuntimeLock());
    const fetchImpl = async () => new Response("unexpected", { status: 200 });
    await expect(
      installGrokRuntime({ outputRoot: join(root, "output"), target: "darwin-arm64", fetchImpl, lock }),
    ).rejects.toThrow("checksum is invalid");
  });
});
