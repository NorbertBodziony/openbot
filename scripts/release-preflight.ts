import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
const changelog = await readFile("CHANGELOG.md", "utf8");
const failures: string[] = [];

if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) failures.push("package version is not semver");
if (!changelog.includes(`## [${packageJson.version}]`)) {
  failures.push(`CHANGELOG.md has no ${packageJson.version} release heading`);
}
if (run("git", ["status", "--porcelain"])) failures.push("working tree is not clean");
if (run("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"]) !== "0\t0") {
  failures.push("main is not synchronized with origin/main");
}
if (run("git", ["tag", "--list", `v${packageJson.version}`])) {
  failures.push(`tag v${packageJson.version} already exists`);
}

const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
if (!identities.includes("Developer ID Application:")) {
  failures.push("Developer ID Application certificate is not installed locally");
}

let releaseSecrets = "";
try {
  releaseSecrets = run("gh", ["secret", "list", "--env", "release"]);
} catch {
  failures.push("GitHub release secrets could not be inspected");
}
for (const name of [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY_BASE64",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
]) {
  if (!releaseSecrets.split("\n").some((line) => line.startsWith(`${name}\t`))) {
    failures.push(`GitHub release secret ${name} is missing`);
  }
}

if (failures.length > 0) {
  console.error("OpenBot release preflight failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("\nNo release tag was created.");
  process.exitCode = 1;
} else {
  console.log(`OpenBot v${packageJson.version} release preflight passed.`);
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}
