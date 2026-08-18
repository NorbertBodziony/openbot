import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(scriptsRoot, "..", "apps", "auth-api");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const bunExecutable = process.execPath;
const wranglerExecutable = join(apiRoot, "node_modules", ".bin", `wrangler${executableSuffix}`);

async function main(): Promise<void> {
  const smtpPassword = process.env.EMAIL_SMTP_PASSWORD;
  if (!smtpPassword?.trim()) {
    throw new Error("EMAIL_SMTP_PASSWORD is missing from the decrypted production environment.");
  }

  await run(wranglerExecutable, ["secret", "put", "EMAIL_SMTP_PASSWORD"], {
    input: `${smtpPassword}\n`,
    label: "Cloudflare SMTP secret",
  });
  await run(bunExecutable, ["run", "build"], { label: "Auth API build" });
  await run(wranglerExecutable, ["deploy"], { label: "Auth API deployment" });
}

async function run(
  executable: string,
  args: string[],
  options: { input?: string; label: string },
): Promise<void> {
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      cwd: apiRoot,
      env: process.env,
      shell: false,
      stdio: [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.once("error", rejectProcess);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveProcess();
      else {
        rejectProcess(
          new Error(
            `${options.label} failed with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`,
          ),
        );
      }
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Auth API deployment failed.");
  process.exitCode = 1;
});
