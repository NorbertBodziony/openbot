import { spawnSync } from "node:child_process";

const repositoryRoot = runGit(["rev-parse", "--show-toplevel"], false);
if (repositoryRoot === undefined) {
  console.log("Skipping Git hook setup because this directory is not a Git repository.");
  process.exit(0);
}

const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("Git hooks enabled from .githooks.");

function runGit(args: string[], inheritOutput: boolean): string | undefined {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: inheritOutput ? "inherit" : ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  return result.stdout?.trim() || undefined;
}
