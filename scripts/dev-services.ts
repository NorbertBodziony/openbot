import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDevelopmentEnvironment } from "./prepare-dev-environment";

export type DevelopmentService = "api" | "app" | "test-client";
type DevelopmentTarget = DevelopmentService | "all";
type DevelopmentNetworkInterfaces = NodeJS.Dict<Array<Pick<NetworkInterfaceInfo, "address" | "family" | "internal">>>;

export interface DevelopmentServiceSpec {
  name: DevelopmentService;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type OwnedProcess = Pick<ChildProcess, "pid" | "exitCode" | "kill">;
type KillProcess = (pid: number, signal?: NodeJS.Signals | number) => boolean;

interface StopOwnedProcessesOptions {
  platform?: NodeJS.Platform;
  killProcess?: KillProcess;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
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
    configureSiteHostingDevelopmentEnvironment(sharedEnvironment, apiPort);
    configureMobileConnectDevelopmentNetwork(services, sharedEnvironment, networkInterfaces());
    if (sharedEnvironment.OPENBOT_MOBILE_AUTH_API_URL) {
      console.log(`Mobile Connect API: ${sharedEnvironment.OPENBOT_MOBILE_AUTH_API_URL}`);
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
    await stopOwnedProcesses([...processes.values()], signal);
  };

  process.once("SIGINT", () => void stopAll("SIGTERM").then(() => process.exit(130)));
  process.once("SIGTERM", () => void stopAll("SIGTERM").then(() => process.exit(143)));
  process.once("SIGHUP", () => void stopAll("SIGTERM").then(() => process.exit(129)));

  try {
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
      if (spec.name === "api") await waitForDevelopmentApi(spec.env.OPENBOT_API_PORT, child);
    }
  } catch (error) {
    await stopAll("SIGTERM");
    throw error;
  }
}

export function configureSiteHostingDevelopmentEnvironment(environment: NodeJS.ProcessEnv, apiPort: number): void {
  environment.SITE_PUBLISH_ENABLED ??= "true";
  environment.SITE_COOKIE_ISOLATION_READY ??= "true";
  environment.SITE_LOCAL_ORIGIN ??= `http://openbot.localhost:${apiPort}`;
}

export function configureMobileConnectDevelopmentNetwork(
  services: DevelopmentService[],
  environment: NodeJS.ProcessEnv,
  interfaces: DevelopmentNetworkInterfaces,
): void {
  if (!services.some((service) => service === "app" || service === "test-client")) return;
  if (environment.OPENBOT_API_HOST === "127.0.0.1") return;
  const port = readPort(environment.OPENBOT_API_PORT);
  const address = selectMobileConnectLanAddress(interfaces);
  if (!port || !address) return;
  environment.OPENBOT_API_HOST ??= "0.0.0.0";
  environment.OPENBOT_MOBILE_AUTH_API_URL ??= `http://${address}:${port}`;
}

export function selectMobileConnectLanAddress(interfaces: DevelopmentNetworkInterfaces): string | null {
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? []).flatMap((address) =>
      address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address)
        ? [{ name, address: address.address }]
        : [],
    ),
  );
  candidates.sort(
    (left, right) =>
      interfacePriority(left.name) - interfacePriority(right.name) ||
      left.name.localeCompare(right.name) ||
      left.address.localeCompare(right.address),
  );
  return candidates[0]?.address ?? null;
}

function interfacePriority(name: string): 0 | 1 | 2 {
  if (name === "en0" || name === "eth0") return 0;
  if (/^(?:en|eth|wl)/u.test(name)) return 1;
  return 2;
}

function isPrivateIpv4(address: string): boolean {
  const values = address.split(".").map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [first, second] = values;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

async function waitForDevelopmentApi(portValue: string | undefined, child: ChildProcess): Promise<void> {
  const port = readPort(portValue);
  if (!port) throw new Error("The development API port is missing.");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The development Auth API stopped before it became ready.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The API can reject connections while Vite and the Worker runtime start.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`The development Auth API did not become ready on port ${port}.`);
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

export function signalOwnedProcess(
  child: OwnedProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  killProcess: KillProcess = process.kill,
): void {
  if (!child.pid) return;
  try {
    if (platform === "win32") {
      if (child.exitCode === null) child.kill(signal);
    } else {
      killProcess(-child.pid, signal);
    }
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

export async function stopOwnedProcesses(
  owned: OwnedProcess[],
  signal: NodeJS.Signals,
  options: StopOwnedProcessesOptions = {},
): Promise<void> {
  const {
    platform = process.platform,
    killProcess = process.kill,
    timeoutMs = 3_000,
    pollIntervalMs = 50,
    now = Date.now,
    wait = (milliseconds) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
  } = options;
  for (const child of owned) signalOwnedProcess(child, signal, platform, killProcess);

  const deadline = now() + timeoutMs;
  while (owned.some((child) => ownedProcessIsRunning(child, platform, killProcess))) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(pollIntervalMs, remaining));
  }

  for (const child of owned) {
    if (ownedProcessIsRunning(child, platform, killProcess)) {
      signalOwnedProcess(child, "SIGKILL", platform, killProcess);
    }
  }
}

function ownedProcessIsRunning(child: OwnedProcess, platform: NodeJS.Platform, killProcess: KillProcess): boolean {
  if (!child.pid) return false;
  if (platform === "win32") return child.exitCode === null;
  try {
    killProcess(-child.pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcess(error)) return false;
    throw error;
  }
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
