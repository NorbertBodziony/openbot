import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const statePath = join(homedir(), "Library", "Application Support", "OpenBot Dev");

try {
  await stat(statePath);
} catch (error) {
  if (isMissing(error)) {
    console.log(`No OpenBot dev state found at ${statePath}.`);
    process.exit(0);
  }
  throw error;
}

await rm(statePath, { recursive: true, force: true });

console.log("OpenBot dev state reset.");
console.log("Agent workspaces and CLI sessions were not changed.");

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
