import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
export const developmentProjectRoot = dirname(scriptsRoot);

export type DevelopmentCommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; stdio: "inherit" },
) => void;

export function prepareDevelopmentEnvironment(
  input: { projectRoot?: string; executable?: string; run?: DevelopmentCommandRunner } = {},
): void {
  const projectRoot = input.projectRoot ?? developmentProjectRoot;
  assertDevelopmentSecrets(projectRoot);

  const executable = input.executable ?? process.execPath;
  const run = input.run ?? execDevelopmentCommand;
  const options = { cwd: projectRoot, stdio: "inherit" as const };

  run(executable, ["install", "--frozen-lockfile"], options);
  run(executable, ["run", "api:migrate:local"], options);
  run(executable, ["run", "install:codex-runtime"], options);
  run(executable, ["run", "install:claude-runtime"], options);
  run(executable, ["run", "install:grok-runtime"], options);
}

export function assertDevelopmentSecrets(projectRoot: string): void {
  const keyPath = join(projectRoot, ".env.keys");
  let hasKeys = false;
  try {
    hasKeys = statSync(keyPath).isFile() && statSync(keyPath).size > 0;
  } catch {
    // The actionable error below is the same for a missing or unreadable key file.
  }
  if (!hasKeys) {
    throw new Error(
      "Missing or empty .env.keys. Add it to the local checkout so Codex can copy it through .worktreeinclude.",
    );
  }
}

function execDevelopmentCommand(executable: string, args: string[], options: { cwd: string; stdio: "inherit" }): void {
  execFileSync(executable, args, options);
}

if (import.meta.main) {
  prepareDevelopmentEnvironment();
}
