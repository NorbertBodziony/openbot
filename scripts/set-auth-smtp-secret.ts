import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { set } from "@dotenvx/dotenvx";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";

const logger = createOpenBotLogger("set-auth-smtp-secret");

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptsRoot, "..");
const envKeysFile = join(projectRoot, ".env.keys");
const environmentFiles = [
  join(projectRoot, "apps", "auth-api", ".env.dev"),
  join(projectRoot, "apps", "auth-api", ".env.production"),
];

async function main(): Promise<void> {
  let appPassword = (await readStandardInput()).trim();
  try {
    if (!/^[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){5}$/u.test(appPassword)) {
      throw new Error("Expected a Private Email app password with six groups of four characters.");
    }

    for (const path of environmentFiles) {
      await set("EMAIL_SMTP_PASSWORD", appPassword, { path, envKeysFile });
      await set("AUTH_EXPOSE_DEVELOPMENT_CODE", "false", { path, envKeysFile });
    }
    logger.info("Encrypted EMAIL_SMTP_PASSWORD for dev and production.");
  } finally {
    appPassword = "";
  }
}

async function readStandardInput(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

void main().catch((error) => {
  logger.error("Could not encrypt the SMTP secret.", toLogValue(error));
  process.exitCode = 1;
});
