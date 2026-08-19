#!/usr/bin/env node
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(skillRoot, "assets/anti-slop");
const arguments_ = process.argv.slice(2);
const force = arguments_.includes("--force");
const unknownOption = arguments_.find((argument) => argument.startsWith("--") && argument !== "--force");
const destinations = arguments_.filter((argument) => !argument.startsWith("--"));
if (unknownOption) {
    throw new Error(`Unknown option: ${unknownOption}`);
}
if (destinations.length > 1) {
    throw new Error("Pass at most one destination.");
}
const destinationArgument = destinations[0] ?? "tools/biome/anti-slop";
if (isAbsolute(destinationArgument)) {
    throw new Error("Destination must be relative to the target repository.");
}
const repositoryRoot = resolve(process.cwd());
const destination = resolve(repositoryRoot, destinationArgument);
const relativeDestination = relative(repositoryRoot, destination);
if (relativeDestination === "" ||
    relativeDestination === "." ||
    relativeDestination.startsWith("..") ||
    isAbsolute(relativeDestination)) {
    throw new Error("Destination must stay inside the target repository.");
}
if (existsSync(destination) && !force) {
    console.error(`Refusing to overwrite ${destination}. Re-run with --force only after reviewing existing files.`);
    process.exit(1);
}
if (force) {
    rmSync(destination, { recursive: true, force: true });
}
cpSync(source, destination, { recursive: true });
console.log(`Copied Biome anti-slop rules to ${destination}`);
console.log(`Configure Biome with the .grit files in ${destination}/rules`);
