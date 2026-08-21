import { execFileSync } from "node:child_process";
import { hasPinnedRemoteDesktopArtifacts, loadNativeRuntimeLock } from "./native-runtime-lock";

const lock = await loadNativeRuntimeLock();
const platform = process.argv[2] ?? process.platform;
const architecture = process.argv[3] ?? process.arch;
if (hasPinnedRemoteDesktopArtifacts(lock)) {
  execFileSync("bun", ["scripts/install-remote-desktop-runtime.ts", platform, architecture], { stdio: "inherit" });
} else if (process.env.OPENBOT_ALLOW_RUNTIME_SOURCE_BUILD === "1") {
  execFileSync("bun", ["scripts/build-remote-desktop-runtime.ts"], { stdio: "inherit" });
} else {
  throw new Error(
    "No reusable remote desktop runtime is pinned. Publish and pin it, or set OPENBOT_ALLOW_RUNTIME_SOURCE_BUILD=1 for the bootstrap CI only.",
  );
}
