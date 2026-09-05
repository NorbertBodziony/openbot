import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const runtimeNodeBin = resolve(root, "runtime/node/bin");
const environment = {
  ...process.env,
  PATH: existsSync(join(runtimeNodeBin, "node"))
    ? `${runtimeNodeBin}${delimiter}${process.env.PATH ?? ""}`
    : process.env.PATH,
  ACME_EMAIL: process.env.ACME_EMAIL ?? "remote-check@example.com",
  SIGNAL_DOMAIN: process.env.SIGNAL_DOMAIN ?? "signal.example.com",
  TURN_DOMAIN: process.env.TURN_DOMAIN ?? "turn.example.com",
  TURN_PUBLIC_IP: process.env.TURN_PUBLIC_IP ?? "203.0.113.1",
  CLOUDFLARE_DNS_API_TOKEN: process.env.CLOUDFLARE_DNS_API_TOKEN ?? "remote-check-token",
  REMOTE_TICKET_JWKS_URL: process.env.REMOTE_TICKET_JWKS_URL ?? "https://api.example.com/.well-known/jwks.json",
  REMOTE_CONTROL_PLANE_URL: process.env.REMOTE_CONTROL_PLANE_URL ?? "https://api.example.com",
  REMOTE_TICKET_PUBLIC_KEYS: process.env.REMOTE_TICKET_PUBLIC_KEYS ?? '{"keys":[{"kty":"EC"}]}',
  REMOTE_SESSION_SECRET: process.env.REMOTE_SESSION_SECRET ?? "s".repeat(32),
  REMOTE_AUTH_WEBHOOK_SECRET: process.env.REMOTE_AUTH_WEBHOOK_SECRET ?? "a".repeat(32),
  REMOTE_METRICS_TOKEN: process.env.REMOTE_METRICS_TOKEN ?? "m".repeat(32),
  TURN_SHARED_SECRET: process.env.TURN_SHARED_SECRET ?? "t".repeat(32),
};

// `docker compose config` parses and interpolates client-side and never opens a
// socket, so the Compose half runs anywhere the docker CLI exists - including a
// GitHub runner, which has the CLI but no useful daemon. `--compose` selects that
// half alone, because CI already runs the workspace's typecheck and tests as
// their own steps and has no reason to pay for them twice.
const composeOnly = process.argv.includes("--compose");

if (!composeOnly) await run(["run", "--cwd", "remote/api", "check"]);
await composeCheck("remote/compose.yaml");
await composeCheck("remote/compose.dev.yaml");
console.log(
  composeOnly ? "Docker Compose configuration is valid." : "Remote API and Docker Compose configuration are valid.",
);

async function composeCheck(file: string): Promise<void> {
  const args = ["compose"];
  args.push("-f", file, "config", "--quiet");
  const process = Bun.spawn(["docker", ...args], { cwd: root, env: environment, stdout: "inherit", stderr: "inherit" });
  if ((await process.exited) !== 0) throw new Error(`Docker Compose validation failed for ${file}.`);
}

async function run(args: string[]): Promise<void> {
  const process = Bun.spawn(["bun", ...args], { cwd: root, env: environment, stdout: "inherit", stderr: "inherit" });
  if ((await process.exited) !== 0) throw new Error(`bun ${args.join(" ")} failed.`);
}
