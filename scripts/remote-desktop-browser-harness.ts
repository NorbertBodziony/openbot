import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { resolveRemoteDesktopRuntime } from "../src/main/remote-desktop-runtime-artifact";
import { RemoteScreenGateway } from "../src/main/remote-screen-gateway";

const runtimePaths = await resolveRemoteDesktopRuntime({
  isPackaged: false,
  resourcesPath: process.cwd(),
  sourceRoot: resolve("."),
  platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
  architecture: process.arch,
  overrideRoot: resolve(
    "build/remote-desktop-runtime",
    process.platform === "win32" ? "win32" : "darwin",
    process.platform === "win32" ? "x64" : "arm64",
  ),
});
if (!runtimePaths) throw new Error("Build the remote desktop runtime before the browser E2E test.");

const clientCount = z.coerce
  .number()
  .int()
  .min(1)
  .max(4)
  .parse(process.env.OPENBOT_REMOTE_E2E_CLIENTS ?? "1");
const stateDirectory = await mkdtemp(join(tmpdir(), "openbot-remote-browser-e2e-"));
const gateway = new RemoteScreenGateway({
  platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
  unattended: false,
  runtimePaths,
  runtimeStateDirectory: stateDirectory,
  getRuntimeCredentials: async () => ({ username: "openbot-e2e", password: "openbot-local-e2e-only" }),
  getDisplays: () => [{ id: "1", label: "Primary display", width: 1920, height: 1080, primary: true }],
  getIceServers: async () => [{ urls: "stun:stun.cloudflare.com:3478" }],
  audit: (event) => console.log(`OPENBOT_REMOTE_E2E_AUDIT=${JSON.stringify(event)}`),
  onDiagnostic: (source, message) => process.stdout.write(`[${source}] ${message}`),
});

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!gateway.handlesHttp(url)) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
    return;
  }
  void gateway.handleHttp(request, response, url);
});
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (gateway.handlesUpgrade(url)) {
    gateway.handleUpgrade(request, socket, head, url);
    return;
  }
  socket.destroy();
});

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const { port } = z.object({ port: z.number().int() }).parse(server.address());
const origin = `http://127.0.0.1:${port}`;
for (let index = 0; index < clientCount; index += 1) {
  const session = await gateway.createSession({
    serverId: "local-e2e-server",
    memberId: `local-e2e-member-${index + 1}`,
    teamSessionId: `local-e2e-team-session-${index + 1}`,
    teamSessionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    publicHttpBaseUrl: origin,
  });
  const viewerUrl = `${session.viewerUrl}#${session.viewerGrant}`;
  if (index === 0) console.log(`OPENBOT_REMOTE_E2E_URL=${viewerUrl}`);
  console.log(`OPENBOT_REMOTE_E2E_URL_${index + 1}=${viewerUrl}`);
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await gateway.stop();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(stateDirectory, { force: true, recursive: true });
}
process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
process.once("uncaughtException", (error) => void stop().finally(() => console.error(error)));
await new Promise(() => undefined);
