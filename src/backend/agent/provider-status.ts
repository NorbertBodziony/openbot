import type { ChildProcess } from "node:child_process";
import type { AgentProviderStatus } from "@openbot/contracts/ipc";
import type { AgentProvider } from "../agent-client";
import { CodexCliError } from "../cli";

export function setProviderStatus(
  statuses: AgentProviderStatus[],
  provider: AgentProvider,
  patch: Omit<AgentProviderStatus, "id">,
): void {
  const index = statuses.findIndex((status) => status.id === provider);
  const status = { id: provider, ...patch };
  if (index === -1) statuses.push(status);
  else statuses[index] = status;
}

export function updateProviderStatus(
  statuses: AgentProviderStatus[] | undefined,
  provider: AgentProvider,
  patch: Omit<AgentProviderStatus, "id">,
): AgentProviderStatus[] {
  const next = structuredClone(statuses ?? []);
  setProviderStatus(next, provider, patch);
  return next;
}

export function providerFailureStatus(
  provider: AgentProvider,
  error: unknown,
  version: string | null | undefined,
): Omit<AgentProviderStatus, "id"> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CodexCliError) {
    if (provider === "codex" || provider === "claude") {
      const label = provider === "codex" ? "ChatGPT" : "Claude";
      const bundledMessage =
        error.code === "missing"
          ? `OpenBot's included ${label} runtime is missing. Reinstall OpenBot.`
          : `OpenBot could not start its included ${label} runtime. Update or reinstall OpenBot.`;
      return { state: "error", version: version ?? null, message: bundledMessage };
    }
    if (error.code === "missing") {
      return { state: "not-installed", version: null, message };
    }
    if (error.code === "outdated") {
      return { state: "outdated", version: version ?? null, message };
    }
  }
  return { state: "error", version: version ?? null, message };
}

export function waitForSuccessfulProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolveProcess, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Provider login timed out."));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolveProcess();
      else reject(new Error(`Provider login stopped with ${signal ?? `code ${String(code)}`}.`));
    });
  });
}
