import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DevelopmentService = "api" | "app" | "test-client";
type DevelopmentTarget = DevelopmentService | "all";

export interface DevelopmentServiceSpec {
  name: DevelopmentService;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
export const projectRoot = dirname(scriptsRoot);

export function servicesForTarget(target: DevelopmentTarget): DevelopmentService[] {
  if (target === "all") return ["api", "app"];
  if (target === "test-client") return ["api", "app", "test-client"];
  if (target === "api") return ["api"];
  return ["api", "app"];
}

export function createDevelopmentServiceSpec(
  name: DevelopmentService,
  environment: NodeJS.ProcessEnv = process.env,
): DevelopmentServiceSpec {
  if (name === "api") {
    return {
      name,
      executable: process.execPath,
      args: ["run", "--cwd", join(projectRoot, "apps", "auth-api"), "dev"],
      cwd: projectRoot,
      env: { ...environment },
    };
  }

  const isTestClient = name === "test-client";
  const outputDirectory = isTestClient ? "out-dev-test-client" : "out-dev-app";
  const electronVite = join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-vite.cmd" : "electron-vite",
  );
  return {
    name,
    executable: electronVite,
    args: ["dev", "--watch", "--outDir", outputDirectory, "--entry", join(outputDirectory, "main", "index.js")],
    cwd: projectRoot,
    env: {
      ...environment,
      OPENBOT_APP_VARIANT: "dev",
      OPENBOT_DEV_PROFILE: isTestClient ? "test-client" : "app",
      OPENBOT_DEV_RENDERER_PORT: isTestClient ? "5174" : "5173",
    },
  };
}

export function parseDevelopmentTarget(args: string[]): {
  target: DevelopmentTarget;
  dryRun: boolean;
} {
  const target = args.find((argument) => !argument.startsWith("--")) ?? "all";
  if (target !== "api" && target !== "app" && target !== "test-client" && target !== "all") {
    throw new Error(`Unknown development target: ${target}. Use api, app, test-client, or all.`);
  }
  const unsupportedOption = args.find((argument) => argument.startsWith("--") && argument !== "--dry-run");
  if (unsupportedOption) throw new Error(`Unknown option: ${unsupportedOption}.`);
  return { target, dryRun: args.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { target, dryRun } = parseDevelopmentTarget(process.argv.slice(2));
  const specs = servicesForTarget(target).map((service) => createDevelopmentServiceSpec(service));
  validateServiceSpecs(specs);

  if (dryRun) {
    for (const spec of specs) {
      console.log(`[${spec.name}]`, JSON.stringify([spec.executable, ...spec.args]));
    }
    return;
  }

  console.log(`Starting: ${specs.map((spec) => spec.name).join(", ")}`);
  const processes = new Map<DevelopmentService, ChildProcess>();
  let stopping = false;

  const stopAll = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const running = [...processes.values()].filter((child) => child.exitCode === null);
    for (const child of running) signalOwnedProcess(child, signal);
    await Promise.race([
      Promise.all(running.map(waitForExit)),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
    ]);
    for (const child of running) {
      if (child.exitCode === null) signalOwnedProcess(child, "SIGKILL");
    }
  };

  process.once("SIGINT", () => void stopAll("SIGTERM").then(() => process.exit(130)));
  process.once("SIGTERM", () => void stopAll("SIGTERM").then(() => process.exit(143)));

  for (const spec of specs) {
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: "inherit",
      shell: false,
      detached: process.platform !== "win32",
    });
    processes.set(spec.name, child);
    child.once("error", (error) => {
      console.error(`[${spec.name}] Could not start:`, error.message);
      void stopAll("SIGTERM").then(() => {
        process.exitCode = 1;
      });
    });
    child.once("exit", (code, signal) => {
      if (stopping) return;
      const result = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      console.log(`[${spec.name}] stopped with ${result}. Stopping the other services.`);
      void stopAll("SIGTERM").then(() => {
        process.exitCode = code ?? 1;
      });
    });
  }
}

function validateServiceSpecs(specs: DevelopmentServiceSpec[]): void {
  for (const spec of specs) {
    if (spec.name === "api" && !existsSync(join(projectRoot, "apps", "auth-api", "package.json"))) {
      throw new Error("The auth API package is missing at apps/auth-api/package.json.");
    }
    if (spec.name !== "api" && !existsSync(spec.executable)) {
      throw new Error(`electron-vite is missing at ${spec.executable}. Run bun install.`);
    }
  }
}

function signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}

function isMissingProcess(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
