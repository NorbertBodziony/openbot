import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, rename, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { delimiter, join } from "node:path";
import type { RemoteMacConnectInput, RemoteMacErrorCode, RemoteMacSession } from "../shared/ipc";

const FIRST_VNC_PORT = 5901;
const LAST_VNC_PORT = 5999;
const CONNECT_TIMEOUT_MS = 15_000;

interface RemoteMacEvents {
  changed: [sessions: RemoteMacSession[]];
}

interface RemoteMacOptions {
  openExternal: (url: string) => Promise<void>;
  resolveCloudflared?: () => Promise<string | null>;
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  logDirectory?: string;
}

interface ManagedSession {
  snapshot: RemoteMacSession;
  process: ChildProcess | null;
  stopping: boolean;
}

export function isValidTunnelHostname(value: string): boolean {
  if (value.length > 253 || value !== value.toLowerCase()) return false;
  if (/^vnc-h-[0-9a-f]{32}\.openbot\.run$/u.test(value)) return true;
  if (!value.endsWith(".trycloudflare.com")) return false;
  const labels = value.split(".");
  if (labels.length < 3) return false;
  return labels.every(
    (label) =>
      label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

export function buildCloudflaredAccessArgs(hostname: string, localPort: number): string[] {
  return ["access", "tcp", "--hostname", hostname, "--url", `127.0.0.1:${localPort}`];
}

export function recognizesRfbHandshake(value: Uint8Array | string): boolean {
  return Buffer.from(value).toString("ascii").startsWith("RFB");
}

export async function resolveCloudflaredExecutable(
  pathValue = process.env.PATH ?? "",
): Promise<string | null> {
  const candidates = new Set([
    "/opt/homebrew/opt/cloudflared/bin/cloudflared",
    "/usr/local/opt/cloudflared/bin/cloudflared",
    ...pathValue
      .split(delimiter)
      .filter(Boolean)
      .map((folder) => join(folder, "cloudflared")),
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
  ]);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next explicit candidate. No shell lookup is used.
    }
  }
  return null;
}

export async function findFreeLoopbackPort(
  reserved: ReadonlySet<number> = new Set(),
  first = FIRST_VNC_PORT,
  last = LAST_VNC_PORT,
): Promise<number | null> {
  for (let port = first; port <= last; port += 1) {
    if (reserved.has(port)) continue;
    if (await canListenOnLoopback(port)) return port;
  }
  return null;
}

export async function probeRfbHandshake(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("error", () => finish(false));
    socket.once("data", (chunk) => finish(recognizesRfbHandshake(chunk.subarray(0, 64))));
    socket.once("end", () => finish(false));
  });
}

export async function stopOwnedProcess(child: ChildProcess, graceMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      finish();
    }, graceMs);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

export class RemoteMacManager extends EventEmitter<RemoteMacEvents> {
  readonly #options: Required<Pick<RemoteMacOptions, "spawnProcess" | "timeoutMs">> &
    Omit<RemoteMacOptions, "spawnProcess" | "timeoutMs">;
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #reservedPorts = new Set<number>();

  constructor(options: RemoteMacOptions) {
    super();
    this.#options = {
      ...options,
      spawnProcess: options.spawnProcess ?? spawn,
      timeoutMs: options.timeoutMs ?? CONNECT_TIMEOUT_MS,
    };
  }

  list(): RemoteMacSession[] {
    return [...this.#sessions.values()].map(({ snapshot }) => ({ ...snapshot }));
  }

  async connect(input: RemoteMacConnectInput): Promise<RemoteMacSession> {
    const hostname = input.hostname.trim().toLowerCase();
    if (!isValidTunnelHostname(hostname)) {
      throw new Error("Enter a valid OpenBot Remote Mac hostname.");
    }
    const managed: ManagedSession = {
      snapshot: {
        id: randomUUID(),
        serverId: input.serverId ?? null,
        hostname,
        localPort: null,
        phase: "starting_tunnel",
        errorCode: null,
        message: "Starting the secure tunnel…",
        createdAt: new Date().toISOString(),
      },
      process: null,
      stopping: false,
    };
    this.#sessions.set(managed.snapshot.id, managed);
    this.#emitChanged();

    try {
      const executable = await (this.#options.resolveCloudflared?.() ??
        resolveCloudflaredExecutable());
      if (!executable) return this.#fail(managed, "cloudflared_not_found");

      const port = await findFreeLoopbackPort(this.#reservedPorts);
      if (!port) return this.#fail(managed, "local_port_unavailable");
      this.#reservedPorts.add(port);
      this.#patch(managed, { localPort: port });

      const child = this.#options.spawnProcess(
        executable,
        buildCloudflaredAccessArgs(hostname, port),
        {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        },
      );
      managed.process = child;
      child.once("error", () => {
        if (!managed.stopping) this.#fail(managed, "tunnel_disconnected");
      });
      child.once("exit", () => {
        if (!managed.stopping && managed.snapshot.phase !== "idle") {
          this.#fail(managed, "tunnel_disconnected");
        }
      });
      child.stdout?.on("data", () => undefined);
      if (this.#options.logDirectory) {
        child.stdout?.on(
          "data",
          (chunk) =>
            void appendDiagnosticLog(
              this.#options.logDirectory as string,
              managed.snapshot.id,
              chunk,
            ),
        );
        child.stderr?.on(
          "data",
          (chunk) =>
            void appendDiagnosticLog(
              this.#options.logDirectory as string,
              managed.snapshot.id,
              chunk,
            ),
        );
      }

      this.#patch(managed, {
        phase: "checking_vnc",
        message: "Checking the VNC handshake…",
      });
      const ready = await this.#waitForRfb(managed, port);
      if (!ready) {
        if (managed.snapshot.errorCode) return { ...managed.snapshot };
        return this.#fail(managed, "tunnel_timeout");
      }

      try {
        await this.#options.openExternal(`vnc://127.0.0.1:${port}`);
      } catch {
        return this.#fail(managed, "viewer_launch_failed");
      }
      this.#patch(managed, { phase: "connected", message: "Screen Sharing is open." });
      return { ...managed.snapshot };
    } catch {
      return this.#fail(managed, "tunnel_disconnected");
    }
  }

  async disconnect(sessionId: string): Promise<void> {
    const managed = this.#sessions.get(sessionId);
    if (!managed) return;
    managed.stopping = true;
    this.#patch(managed, { phase: "disconnecting", message: "Closing the tunnel…" });
    if (managed.process) await stopOwnedProcess(managed.process);
    if (managed.snapshot.localPort !== null) this.#reservedPorts.delete(managed.snapshot.localPort);
    this.#patch(managed, {
      phase: "idle",
      localPort: null,
      errorCode: null,
      message: "Disconnected.",
    });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.disconnect(id)));
  }

  async #waitForRfb(managed: ManagedSession, port: number): Promise<boolean> {
    const deadline = Date.now() + this.#options.timeoutMs;
    let successfulTcpConnection = false;
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt += 1) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await probeRfbHandshake(port, Math.min(2_000, remaining));
      if (result) return true;
      if (managed.snapshot.errorCode === "tunnel_disconnected") return false;
      successfulTcpConnection ||= await canConnect(port, Math.min(300, remaining));
      if (attempt < 2)
        await delay(Math.min(250 * 2 ** attempt, Math.max(0, deadline - Date.now())));
    }
    if (successfulTcpConnection) {
      this.#fail(managed, "invalid_vnc_handshake");
    }
    return false;
  }

  #fail(managed: ManagedSession, code: RemoteMacErrorCode): RemoteMacSession {
    const messages: Record<RemoteMacErrorCode, string> = {
      cloudflared_not_found: "Install cloudflared with: brew install cloudflared",
      local_port_unavailable: "No free local VNC port is available from 5901 to 5999.",
      tunnel_timeout: "The tunnel did not become ready within 15 seconds.",
      tunnel_disconnected: "cloudflared stopped before the connection was ready.",
      invalid_vnc_handshake: "The remote service did not return an RFB VNC handshake.",
      viewer_launch_failed: "OpenBot could not open macOS Screen Sharing.",
    };
    if (managed.snapshot.localPort !== null) this.#reservedPorts.delete(managed.snapshot.localPort);
    this.#patch(managed, { phase: "idle", errorCode: code, message: messages[code] });
    if (managed.process && managed.process.exitCode === null && !managed.stopping) {
      managed.stopping = true;
      void stopOwnedProcess(managed.process);
    }
    return { ...managed.snapshot };
  }

  #patch(managed: ManagedSession, patch: Partial<RemoteMacSession>): void {
    managed.snapshot = { ...managed.snapshot, ...patch };
    this.#emitChanged();
  }

  #emitChanged(): void {
    this.emit("changed", this.list());
  }
}

export async function appendDiagnosticLog(
  directory: string,
  name: string,
  chunk: Uint8Array | string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  const path = join(directory, `${safeName}.log`);
  try {
    if ((await stat(path)).size >= 1024 * 1024) await rename(path, `${path}.1`);
  } catch {
    // A missing log does not need rotation.
  }
  const clean = Buffer.from(chunk)
    .toString("utf8")
    .replace(/(?:Bearer\s+|token[=: ]+)[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 8_000);
  if (clean) await appendFile(path, clean, { encoding: "utf8", mode: 0o600 });
}

async function canListenOnLoopback(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function canConnect(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
