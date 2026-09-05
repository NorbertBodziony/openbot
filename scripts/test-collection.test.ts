// A test file no runner collects is green forever. `vitest run` never imports it, no
// report names it, and the only signal is a number nobody has a baseline for. The root
// config's include list is an allowlist of directories, so a test written outside one
// passes locally by never running: that is how the mobile glob stayed pinned to
// `apps/mobile/src/features/auth/api` while reading like it covered the app. The next one
// is `apps/mobile/src/foo.test.tsx`, which matches the node project's `*.test.ts` never
// and the renderer project's `src/renderer` root never.
//
// So the tracked tree is the source of truth and `vitest list` is asked what it collects.
// Every tracked test file is accounted for by exactly one of three answers: the root run
// collects it, a workspace with its own test script owns it, or it is a fixture that is
// read rather than run.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

// Workspaces the root run leaves alone because they have a runner of their own, which CI
// invokes as `test:sites`, `test:remote` and `check:api`. Each entry is checked below to
// still have that script, so a workspace cannot lose its runner and keep its exemption.
const delegatedWorkspaces = ["apps/auth-api", "apps/site-router", "remote/api"];

// Input to scripts/ui-foundation-check.test.ts, which reads these as text to prove the
// check skips test files. They assert nothing, so collecting them would be meaningless.
const readNotRun = ["tools/ui-foundation/fixtures/"];

// `--others --exclude-standard` adds the files git would accept but has not been given
// yet, so the test a developer is writing right now is checked before it is committed,
// while .gitignore still keeps node_modules and every build directory out.
function trackedTestFiles(): string[] {
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return tracked.split("\0").filter((path) => /\.test\.tsx?$/u.test(path));
}

// `--filesOnly` globs the include patterns without importing a single test file, so this
// costs a subprocess and no test run. Lines are `[project] path/from/the/repository/root`.
function collectedTestFiles(): string[] {
  const listed = execFileSync(join(repositoryRoot, "node_modules/.bin/vitest"), ["list", "--filesOnly"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return listed
    .split("\n")
    .map((line) => line.replace(/^\[[^\]]+\]\s+/u, "").trim())
    .filter((line) => line.length > 0);
}

// The one field this file reads out of a package manifest.
type WorkspaceManifest = { scripts?: { test?: string } };

function hasOwnRunner(workspace: string): boolean {
  const manifest: WorkspaceManifest = JSON.parse(readFileSync(join(repositoryRoot, workspace, "package.json"), "utf8"));
  return typeof manifest.scripts?.test === "string";
}

describe("test collection", () => {
  const tracked = trackedTestFiles();

  it("hands every tracked test file to a runner", () => {
    // Without this the assertion below passes on an empty list, which is the failure it
    // exists to catch: a check that enforces nothing because it found nothing.
    expect(tracked.length).toBeGreaterThan(100);

    const collected = new Set(collectedTestFiles());
    const exempt = [...delegatedWorkspaces.map((workspace) => `${workspace}/`), ...readNotRun];
    const uncollected = tracked.filter(
      (path) => !collected.has(path) && !exempt.some((prefix) => path.startsWith(prefix)),
    );

    expect(uncollected).toEqual([]);
  });

  it("keeps a runner of its own in every workspace the root run skips", () => {
    expect(delegatedWorkspaces.filter((workspace) => !hasOwnRunner(workspace))).toEqual([]);
  });
});
