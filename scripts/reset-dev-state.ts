import { rename, stat } from "node:fs/promises";
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

const timestamp = new Date().toISOString().replaceAll(":", "-");
const backupPath = `${statePath}.reset-${timestamp}`;
await rename(statePath, backupPath);

console.log("OpenBot dev state reset.");
console.log(`Backup: ${backupPath}`);
console.log("Agent workspaces and CLI sessions were not changed.");

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
