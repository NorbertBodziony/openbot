import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDevelopmentSecrets,
  type DevelopmentCommandRunner,
  prepareDevelopmentEnvironment,
} from "./prepare-dev-environment";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("development environment preparation", () => {
  it("fails with an actionable error when worktree secrets were not copied", () => {
    const root = createTemporaryRoot();

    expect(() => assertDevelopmentSecrets(root)).toThrow("Missing or empty .env.keys");
  });

  it("installs dependencies and migrates the local API in order", () => {
    const root = createTemporaryRoot();
    writeFileSync(join(root, ".env.keys"), "DOTENV_PRIVATE_KEY_TEST=value\n");
    const calls: string[][] = [];
    const run: DevelopmentCommandRunner = (_executable, args) => calls.push(args);

    prepareDevelopmentEnvironment({ projectRoot: root, executable: "bun", run });

    expect(calls).toEqual([
      ["install", "--frozen-lockfile"],
      ["run", "api:migrate:local"],
    ]);
  });
});

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openbot-dev-prepare-"));
  temporaryRoots.push(root);
  return root;
}
