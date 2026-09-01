import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SunshineMoonlightRuntime } from "../src/main/sunshine-moonlight-runtime";

if (process.platform !== "darwin") {
  throw new Error("The local runtime smoke test currently supports macOS only.");
}

const stateDirectory = await mkdtemp(join(tmpdir(), "openbot-remote-runtime-smoke-"));
const runtimeRoot = resolve("build/remote-desktop-runtime/darwin/arm64");
const runtime = new SunshineMoonlightRuntime({
  paths: {
    sunshine: join(runtimeRoot, "Sunshine.app/Contents/MacOS/Sunshine"),
    moonlightWebServer: join(runtimeRoot, "web-server"),
    moonlightStreamer: join(runtimeRoot, "streamer"),
  },
  stateDirectory,
  platform: "darwin",
  credentials: {
    username: process.env.OPENBOT_SMOKE_USERNAME ?? `openbot-${randomBytes(8).toString("hex")}`,
    password: process.env.OPENBOT_SMOKE_PASSWORD ?? randomBytes(24).toString("base64url"),
  },
  getDisplays: () => [],
  getIceServers: async () => [{ urls: "stun:127.0.0.1:3478" }],
  onDiagnostic: (source, message) => process.stderr.write(`[${source}] ${message}`),
});

try {
  const state = await runtime.start();
  if (!state.baseUrl.startsWith("http://127.0.0.1:")) throw new Error("Moonlight Web did not bind to loopback.");
  if (state.hostIds.length !== 4 || !state.hostIds.every(Number.isInteger) || !Number.isInteger(state.desktopAppId)) {
    throw new Error("Moonlight Web did not pair with the Sunshine Desktop application.");
  }
  if (state.displays.length === 0 || !state.selectedDisplayId) {
    throw new Error("Sunshine did not return a native display identifier.");
  }
  const streamPage = await fetch(`${state.baseUrl}/stream.html`);
  if (!streamPage.ok) throw new Error(`Moonlight stream page failed with HTTP ${streamPage.status}.`);
  console.log(
    `Remote desktop runtime is ready on loopback (hosts ${state.hostIds.join(", ")}, app ${state.desktopAppId}).`,
  );
} finally {
  await runtime.stop();
  await rm(stateDirectory, { recursive: true, force: true });
}
