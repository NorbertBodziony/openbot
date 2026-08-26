import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDevelopmentEnvironment } from "./prepare-dev-environment";

export type DevelopmentService = "api" | "app" | "test-client";
type DevelopmentTarget = DevelopmentService | "all";

export interface DevelopmentServiceSpec {
  name: DevelopmentService;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function developmentEnvironmentForTarget(
  target: DevelopmentTarget,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    OPENBOT_DEV_TEST_CLIENT_ENABLED: target === "test-client" ? "1" : "0",
  };
}

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
export const projectRoot = dirname(scriptsRoot);

const DEFAULT_API_PORT = 3_100;
const DEFAULT_RENDERER_PORTS = {
  app: 5_173,
  "test-client": 5_174,
} as const;
const DEFAULT_REMOTE_DEBUGGING_PORTS = {
  app: 9_333,
  "test-client": 9_334,
} as const;

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
      OPENBOT_DEV_RENDERER_PORT:
        environment.OPENBOT_DEV_RENDERER_PORT ??
        String(isTestClient ? DEFAULT_RENDERER_PORTS["test-client"] : DEFAULT_RENDERER_PORTS.app),
      OPENBOT_DEV_REMOTE_DEBUGGING_PORT:
        environment.OPENBOT_DEV_REMOTE_DEBUGGING_PORT ??
        String(isTestClient ? DEFAULT_REMOTE_DEBUGGING_PORTS["test-client"] : DEFAULT_REMOTE_DEBUGGING_PORTS.app),
      OPENBOT_DEV_REMOTE_ROLE: environment.OPENBOT_DEV_REMOTE_ROLE ?? (isTestClient ? "client" : "host"),
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
  if (!dryRun) prepareDevelopmentEnvironment();
  const services = servicesForTarget(target);
  const sharedEnvironment = developmentEnvironmentForTarget(target);
  const reservedPorts = new Set<number>();

  if (services.includes("api")) {
    const apiPort = await findAvailablePort(
      readPort(sharedEnvironment.OPENBOT_API_PORT) ?? DEFAULT_API_PORT,
      reservedPorts,
    );
    reservedPorts.add(apiPort);
    sharedEnvironment.OPENBOT_API_PORT = String(apiPort);
    if (!sharedEnvironment.OPENBOT_AUTH_API_URL) {
      sharedEnvironment.OPENBOT_AUTH_API_URL = `http://127.0.0.1:${apiPort}`;
    }
    if (apiPort !== DEFAULT_API_PORT) {
      console.log(`API port ${DEFAULT_API_PORT} is busy. Using ${apiPort}.`);
    }
  }

  const specs: DevelopmentServiceSpec[] = [];
  for (const service of services) {
    const environment = { ...sharedEnvironment };
    if (service === "app" || service === "test-client") {
      const defaultPort = DEFAULT_RENDERER_PORTS[service];
      const rendererPort = await findAvailablePort(
        readPort(environment.OPENBOT_DEV_RENDERER_PORT) ?? defaultPort,
        reservedPorts,
      );
      reservedPorts.add(rendererPort);
      environment.OPENBOT_DEV_RENDERER_PORT = String(rendererPort);
      if (rendererPort !== defaultPort) {
        environment.OPENBOT_DEV_INSTANCE_ID ??= String(rendererPort);
        console.log(`Renderer port ${defaultPort} is busy. Using ${rendererPort} for ${service}.`);
      }

      const defaultRemoteDebuggingPort = DEFAULT_REMOTE_DEBUGGING_PORTS[service];
      const remoteDebuggingPort = await findAvailablePort(
        readPort(environment.OPENBOT_DEV_REMOTE_DEBUGGING_PORT) ?? defaultRemoteDebuggingPort,
        reservedPorts,
      );
      reservedPorts.add(remoteDebuggingPort);
      environment.OPENBOT_DEV_REMOTE_DEBUGGING_PORT = String(remoteDebuggingPort);
      if (remoteDebuggingPort !== defaultRemoteDebuggingPort) {
        console.log(
          `Electron debug port ${defaultRemoteDebuggingPort} is busy. Using ${remoteDebuggingPort} for ${service}.`,
        );
      }
    }
    specs.push(createDevelopmentServiceSpec(service, environment));
  }
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

async function findAvailablePort(preferredPort: number, reservedPorts: Set<number>): Promise<number> {
  for (let port = preferredPort; port <= 65_535; port += 1) {
    if (reservedPorts.has(port)) continue;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error("No available development port was found.");
}

function isPortAvailable(port: number): Promise<boolean> {
  return Promise.all([isAddressPortAvailable(port, "127.0.0.1"), isAddressPortAvailable(port, "::1")]).then((results) =>
    results.every(Boolean),
  );
}

function isAddressPortAvailable(port: number, host: "127.0.0.1" | "::1"): Promise<boolean> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    const finish = (available: boolean) => {
      server.removeAllListeners();
      resolvePort(available);
    };
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        finish(false);
        return;
      }
      if (host === "::1" && (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT")) {
        finish(true);
        return;
      }
      reject(error);
    });
    server.listen(port, host, () => {
      server.close(() => finish(true));
    });
  });
}

function readPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("Development ports must be integers from 1024 to 65535.");
  }
  return port;
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
