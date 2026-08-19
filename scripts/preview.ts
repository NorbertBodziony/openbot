import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-vite.cmd" : "electron-vite",
);
const child = spawn(executable, ["preview", ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: { ...process.env, OPENBOT_APP_VARIANT: "preview" },
  stdio: "inherit",
  shell: false,
});

child.once("error", (error) => {
  console.error("Could not start electron-vite preview:", error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 0;
});
