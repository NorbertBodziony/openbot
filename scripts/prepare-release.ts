import { readFile, writeFile } from "node:fs/promises";
import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("prepare-release");

type Increment = "major" | "minor" | "patch";

const increment = process.argv[2];
if (!isOneOf(["major", "minor", "patch"] as const, increment)) {
  throw new Error("Usage: bun scripts/prepare-release.ts <major|minor|patch>");
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
if (!isDynamicRecord(packageJson) || !isString(packageJson.version)) {
  throw new Error("package.json has no valid version.");
}
const changelog = await readFile("CHANGELOG.md", "utf8");
const nextVersion = bumpVersion(packageJson.version, increment);
const releaseHeading = `## [${nextVersion}] - ${new Date().toISOString().slice(0, 10)}`;

if (!changelog.includes("## [Unreleased]")) {
  throw new Error("CHANGELOG.md has no Unreleased heading");
}
if (changelog.includes(`## [${nextVersion}]`)) {
  throw new Error(`CHANGELOG.md already contains ${nextVersion}`);
}

const nextPackageJson = { ...packageJson, version: nextVersion };
const nextChangelog = changelog.replace("## [Unreleased]", `## [Unreleased]\n\n${releaseHeading}`);

await Promise.all([
  writeFile("package.json", `${JSON.stringify(nextPackageJson, null, 2)}\n`),
  writeFile("CHANGELOG.md", nextChangelog),
]);

logger.info(`Prepared OpenBot v${nextVersion}. Review, commit, push, run preflight, then tag it.`);

function bumpVersion(version: string, selectedIncrement: Increment): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Package version is not semver: ${version}`);

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (selectedIncrement === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (selectedIncrement === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}
