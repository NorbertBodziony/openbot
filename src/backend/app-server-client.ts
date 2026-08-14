import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AgentProvider } from "./agent-client";
import { JsonLineDecoder } from "./jsonl";
import {
  type AppServerNotification,
  type AppServerRequest,
  isRecord,
  type RequestId,
  type RpcError,
  type RpcMessage,
} from "./protocol";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string];
}

export class AppServerError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AppServerError";
  }
}

export class CodexAppServerClient extends EventEmitter<ClientEvents> {
  readonly provider: AgentProvider = "codex";
  readonly #executable: string;
  readonly #requestTimeoutMs: number;
  #decoder = new JsonLineDecoder();
  readonly #pending = new Map<RequestId, PendingRequest>();
  #process: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #stopping = false;

  constructor(executable: string, requestTimeoutMs = 30_000) {
    super();
    this.#executable = executable;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  get running(): boolean {
    return this.#process !== null && this.#process.exitCode === null;
  }

  start(): void {
    if (this.running) return;

    this.#stopping = false;
    this.#decoder = new JsonLineDecoder();
    const child = spawn(this.#executable, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    this.#process = child;

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.#decoder.push(chunk)) this.#handleMessage(message);
      } catch (error) {
        this.#fail(new Error(`Codex protocol error: ${String(error)}`), child);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const diagnostic = chunk.toString("utf8").trim();
      if (diagnostic) this.emit("diagnostic", redactDiagnostic(diagnostic));
    });

    child.once("error", (error) => this.#fail(error, child));
    child.once("exit", (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#fail(new Error(`Codex App Server exited with ${suffix}.`), child);
    });
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child) return;

    this.#stopping = true;
    this.#process = null;

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex App Server stopped."));
    }
    this.#pending.clear();

    child.stdin.end();
    if (child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  request<T>(method: string, params: unknown, timeoutMs = this.#requestTimeoutMs): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.#write({ method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.#write({ id, result });
  }

  respondError(id: RequestId, error: RpcError): void {
    this.#write({ id, error });
  }

  #write(message: unknown): void {
    if (!this.running || !this.#process) {
      throw new Error("Codex App Server is not running.");
    }
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleMessage(message: RpcMessage): void {
    if ("method" in message) {
      if ("id" in message) {
        this.emit("request", {
          method: message.method,
          id: message.id,
          params: message.params,
        });
      } else {
        this.emit("notification", { method: message.method, params: message.params });
      }
      return;
    }

    const pending = this.#pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.#pending.delete(message.id);

    if (message.error && isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : -1;
      const text =
        typeof message.error.message === "string" ? message.error.message : "Unknown error";
      pending.reject(new AppServerError(text, code, message.error.data));
      return;
    }

    pending.resolve(message.result);
  }

  #fail(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.#process !== child) return;
    this.#process = null;

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();

    if (child.exitCode === null) child.kill("SIGTERM");
    if (!this.#stopping) this.emit("exit", error);
  }
}

export function redactDiagnostic(message: string): string {
  return message
    .replace(/(?:sk|sess|Bearer|token)[-_a-zA-Z0-9.=]{8,}/gi, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 2_000);
}
