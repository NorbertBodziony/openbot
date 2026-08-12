import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptsRoot);
const outputRoot = await mkdtemp(join(tmpdir(), "infeld-browser-build-"));
try {
  const esbuild = join(projectRoot, "node_modules", ".bin", "esbuild");
  const buildCode = await run(esbuild, [
    join(scriptsRoot, "browser-smoke-electron.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:electron",
    `--outfile=${join(outputRoot, "browser-smoke.mjs")}`,
  ]);
  if (buildCode !== 0) throw new Error("Unable to build browser smoke test.");

  const electron = join(projectRoot, "node_modules", ".bin", "electron");
  const exitCode = await run(electron, [join(outputRoot, "browser-smoke.mjs")]);
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}

function run(executable: string, arguments_: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
