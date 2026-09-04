// AI-facing bridge to the live dev app. Read-only by default; anything that
// changes app state needs --allow-mutations. This tool never seeds, resets or
// copies openbot.db: it drives the instance you already have open.
import { join } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp, resolveAutomationPort } from "./cdp-client";
import {
  clickByRole,
  parseAutomationRole,
  resolveScreenshotPath,
  screenshotTo,
  snapshotPage,
  typeByRole,
} from "./tools";

// Diagnostics go to stderr so stdout carries only the final JSON document,
// which stays parseable for the calling agent.
// `debug` so the renderer console and page errors this tool subscribes to are
// visible; the default `info` threshold would drop them.
const logger = createOpenBotLogger("dev-automation", (line) => process.stderr.write(`${line}\n`), "debug");

const DEFAULT_TIMEOUT_MS = 10_000;
const SCREENSHOT_ROOT = join(process.cwd(), ".openbot-build", "dev-automation");

// `null` means the flag is absent, `""` means it was passed empty. The two
// differ for `--text=`, which legitimately clears a field.
function flagValue(name: string): string | null {
  const passed = process.argv.find((argument) => argument.startsWith(`${name}=`));
  return passed === undefined ? null : passed.slice(name.length + 1);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function requireFlagValue(name: string): string {
  const value = flagValue(name);
  if (value === null || value === "") throw new Error(`Missing required ${name}=<value>.`);
  return value;
}

function requireTextFlag(): string {
  const value = flagValue("--text");
  if (value === null) throw new Error("Missing required --text=<value>.");
  return value;
}

function readTimeout(): number {
  const raw = flagValue("--timeout");
  if (raw === null) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(raw);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 120_000) {
    throw new Error("--timeout must be an integer of 1..120000 ms.");
  }
  return timeout;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "snapshot" && command !== "click" && command !== "type" && command !== "screenshot") {
    throw new Error("Usage: bun scripts/dev-automation/cli.ts <snapshot|click|type|screenshot> [flags]");
  }
  const resolved = resolveAutomationPort(
    flagValue("--port") ?? undefined,
    process.env.OPENBOT_DEV_REMOTE_DEBUGGING_PORT,
  );
  if (command === "click" || command === "type") {
    assertMutationAllowed({
      command,
      allowMutations: hasFlag("--allow-mutations"),
      portExplicit: resolved.explicit,
    });
  }
  const role = command === "click" || command === "type" ? parseAutomationRole(requireFlagValue("--role")) : null;
  const name = command === "click" || command === "type" ? requireFlagValue("--name") : null;
  const text = command === "type" ? requireTextFlag() : null;
  const port = resolved.port;
  const timeoutMs = readTimeout();
  const session = await connectToDevApp(port, logger);
  try {
    if (command === "snapshot") {
      const snapshot = await snapshotPage(session.page, logger);
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else if (command === "click" && role && name) {
      logger.info(`click role=${role} name=${name}`);
      await clickByRole(session.page, role, name, timeoutMs);
      const snapshot = await snapshotPage(session.page, logger);
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else if (command === "type" && role && name && text !== null) {
      logger.info(`type role=${role} name=${name} chars=${text.length} submit=${hasFlag("--submit")}`);
      await typeByRole(session.page, role, name, text, timeoutMs, hasFlag("--submit"));
      const snapshot = await snapshotPage(session.page, logger);
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else if (command === "screenshot") {
      const out = resolveScreenshotPath(SCREENSHOT_ROOT, flagValue("--out"), Date.now());
      await screenshotTo(session.page, out, logger);
      process.stdout.write(`${JSON.stringify({ screenshot: out })}\n`);
    }
  } finally {
    await session.close();
  }
}

void main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
