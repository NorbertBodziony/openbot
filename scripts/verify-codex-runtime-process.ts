import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function verifyCodexRuntimeProcess(executable: string, version: string): Promise<void> {
  const versionOutput = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  }).trim();
  if (!versionOutput.includes(version)) throw new Error(`Unexpected bundled Codex version: ${versionOutput}`);

  const codexHome = await mkdtemp(join(tmpdir(), "openbot-codex-smoke-"));
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let diagnostics = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-4_000);
  });
  try {
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "openbot-package-verifier", version: "1" }, capabilities: {} },
      })}\n`,
    );
    await waitFor(() => /"id"\s*:\s*1/u.test(output), 15_000);
  } catch (error) {
    throw new Error(`Bundled Codex App Server smoke test failed: ${diagnostics || output}`, { cause: error });
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Codex App Server did not initialize before the timeout.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
