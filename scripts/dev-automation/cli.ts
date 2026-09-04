// AI-facing bridge to the live dev app. Read-only by default; anything that
// changes app state needs --allow-mutations. This tool never seeds, resets or
// copies openbot.db: it drives the instance you already have open.
import { join } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import {
  assertMutationAllowed,
  connectToDevApp,
  describeDevPages,
  devBrowserPages,
  openDevBrowser,
  resolveAutomationPort,
} from "./cdp-client";
import {
  type DevInstanceRecord,
  type DevInstanceService,
  describeDevInstance,
  readDevInstanceRecords,
  selectDevInstance,
} from "./instance-registry";
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

// Dev is meant to be fully testable, so any window can be driven - but the
// aim has to be deliberate. An empty selector would match every target and
// land wherever the list happens to start.
function readPageSelector(): string | null {
  const raw = flagValue("--page");
  if (raw === null) return null;
  if (raw.trim() === "") throw new Error("--page=<index|url-substring> cannot be empty.");
  return raw;
}

function readService(): DevInstanceService {
  const raw = flagValue("--service");
  if (raw === null || raw === "app") return "app";
  if (raw === "test-client") return "test-client";
  throw new Error("--service must be app or test-client.");
}

interface AutomationTarget {
  port: number;
  expectedRendererPort: number | null;
  instanceNamed: boolean;
  description: string;
}

// Resolution order, and why: an explicit port or instance is an instruction
// and wins. Otherwise the registry decides, and the record of the worktree
// this command runs in is the one an agent almost always means - the default
// port is a last resort, kept read-only by `instanceNamed: false`.
function resolveTarget(records: DevInstanceRecord[], service: DevInstanceService): AutomationTarget {
  const explicitPort = resolveAutomationPort(
    flagValue("--port") ?? undefined,
    process.env.OPENBOT_DEV_REMOTE_DEBUGGING_PORT,
  );
  const requestedInstance = flagValue("--instance");
  if (requestedInstance !== null && flagValue("--port") !== null) {
    throw new Error("Pass either --instance=<id> or --port=<port>, not both: they can name different instances.");
  }
  if (explicitPort.explicit && requestedInstance === null) {
    const published = records.find((record) => record.remoteDebuggingPort === explicitPort.port);
    return {
      port: explicitPort.port,
      expectedRendererPort: published?.rendererPort ?? null,
      instanceNamed: true,
      description: published ? describeDevInstance(published) : `:${explicitPort.port}`,
    };
  }
  const selection = selectDevInstance(records, {
    projectRoot: process.cwd(),
    instanceId: requestedInstance,
    service,
  });
  if (selection.kind === "ambiguous") {
    throw new Error(
      `${selection.candidates.length} dev instances match. Re-run with --instance=<id>:\n` +
        selection.candidates.map((record) => `- ${describeDevInstance(record)}`).join("\n"),
    );
  }
  if (selection.kind === "unknown") {
    if (requestedInstance !== null) {
      throw new Error(
        `No live dev instance has --instance=${requestedInstance}. ` +
          (selection.candidates.length > 0
            ? `Live now:\n${selection.candidates.map((record) => `- ${describeDevInstance(record)}`).join("\n")}`
            : "Nothing is published; start `bun run dev` in the worktree you mean."),
      );
    }
    return {
      port: explicitPort.port,
      expectedRendererPort: null,
      instanceNamed: false,
      description: `:${explicitPort.port} (no registry record)`,
    };
  }
  return {
    port: selection.record.remoteDebuggingPort,
    expectedRendererPort: selection.record.rendererPort,
    // A foreign instance is the dev app of another worktree. Readable, so an
    // agent can still take a snapshot, but not something to click blind.
    instanceNamed: selection.match !== "foreign",
    description: `${describeDevInstance(selection.record)} [${selection.match}]`,
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "instances") {
    const records = readDevInstanceRecords();
    process.stdout.write(`${JSON.stringify({ instances: records }, null, 2)}\n`);
    return;
  }
  if (
    command !== "pages" &&
    command !== "snapshot" &&
    command !== "click" &&
    command !== "type" &&
    command !== "screenshot"
  ) {
    throw new Error(
      "Usage: bun scripts/dev-automation/cli.ts <instances|pages|snapshot|click|type|screenshot> [flags]",
    );
  }
  const target = resolveTarget(readDevInstanceRecords(), readService());
  logger.info(`target ${target.description}`);
  if (command === "pages") {
    const browser = await openDevBrowser(target.port, logger);
    try {
      process.stdout.write(`${JSON.stringify({ pages: describeDevPages(devBrowserPages(browser)) }, null, 2)}\n`);
    } finally {
      await browser.close();
    }
    return;
  }
  if (command === "click" || command === "type") {
    assertMutationAllowed({
      command,
      allowMutations: hasFlag("--allow-mutations"),
      instanceNamed: target.instanceNamed,
      target: target.description,
    });
  }
  const role = command === "click" || command === "type" ? parseAutomationRole(requireFlagValue("--role")) : null;
  const name = command === "click" || command === "type" ? requireFlagValue("--name") : null;
  const text = command === "type" ? requireTextFlag() : null;
  const timeoutMs = readTimeout();
  const session = await connectToDevApp(target.port, logger, {
    expectedRendererPort: target.expectedRendererPort,
    pageSelector: readPageSelector(),
  });
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
