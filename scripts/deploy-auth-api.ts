import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(scriptsRoot, "..", "apps", "auth-api");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const bunExecutable = process.execPath;
const wranglerExecutable = join(apiRoot, "node_modules", ".bin", `wrangler${executableSuffix}`);
const cloudflareEnvironment = readCloudflareEnvironment(process.argv.slice(2));
const environmentArgs = cloudflareEnvironment ? ["--env", cloudflareEnvironment] : [];

async function main(): Promise<void> {
  const smtpPassword = process.env.EMAIL_SMTP_PASSWORD;
  if (!smtpPassword?.trim()) {
    throw new Error("EMAIL_SMTP_PASSWORD is missing from the decrypted production environment.");
  }
  const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!cloudflareApiToken?.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN is missing from the decrypted production environment.");
  }
  const skillsAdminToken = process.env.SKILLS_ADMIN_TOKEN;
  if (!skillsAdminToken?.trim()) {
    throw new Error("SKILLS_ADMIN_TOKEN is missing from the decrypted production environment.");
  }
  await run(wranglerExecutable, ["secret", "put", "EMAIL_SMTP_PASSWORD", ...environmentArgs], {
    input: `${smtpPassword}\n`,
    label: "Cloudflare SMTP secret",
  });
  await run(wranglerExecutable, ["secret", "put", "CLOUDFLARE_API_TOKEN", ...environmentArgs], {
    input: `${cloudflareApiToken}\n`,
    label: "Cloudflare tunnel API secret",
  });
  await run(wranglerExecutable, ["secret", "put", "SKILLS_ADMIN_TOKEN", ...environmentArgs], {
    input: `${skillsAdminToken}\n`,
    label: "Skills marketplace admin secret",
  });
  await run(wranglerExecutable, ["d1", "migrations", "apply", "DB", "--remote", ...environmentArgs], {
    label: "Remote D1 migrations",
  });
  await run(bunExecutable, ["run", "build"], {
    label: "Auth API build",
    env: cloudflareEnvironment ? { CLOUDFLARE_ENV: cloudflareEnvironment } : undefined,
  });
  await run(wranglerExecutable, ["deploy", ...environmentArgs], {
    label: "Auth API deployment",
  });
}

async function run(
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; label: string },
): Promise<void> {
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const environment = { ...process.env, ...options.env };
    if (executable === wranglerExecutable) delete environment.CLOUDFLARE_API_TOKEN;
    const child = spawn(executable, args, {
      cwd: apiRoot,
      env: environment,
      shell: false,
      stdio: [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.once("error", rejectProcess);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveProcess();
      else {
        rejectProcess(new Error(`${options.label} failed with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`));
      }
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function readCloudflareEnvironment(args: string[]): string | null {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === "--env" && /^[a-z0-9-]+$/u.test(args[1] ?? "")) {
    return args[1] ?? null;
  }
  throw new Error("Use --env followed by a lowercase Cloudflare environment name.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Auth API deployment failed.");
  process.exitCode = 1;
});
