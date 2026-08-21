import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRemoteDesktopRuntime } from "./remote-desktop-runtime-artifact";

describe("resolveRemoteDesktopRuntime", () => {
  it("requires all three pinned runtime executables", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-runtime-test-"));
    await mkdir(join(root, "Sunshine.app", "Contents", "MacOS"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "Sunshine.app", "Contents", "MacOS", "Sunshine"), "sunshine"),
      writeFile(join(root, "web-server"), "web-server"),
      writeFile(join(root, "streamer"), "streamer"),
    ]);
    await expect(
      resolveRemoteDesktopRuntime({
        isPackaged: false,
        resourcesPath: root,
        sourceRoot: root,
        platform: "darwin",
        architecture: "arm64",
        overrideRoot: root,
      }),
    ).resolves.toEqual({
      sunshine: join(root, "Sunshine.app", "Contents", "MacOS", "Sunshine"),
      moonlightWebServer: join(root, "web-server"),
      moonlightStreamer: join(root, "streamer"),
    });
  });
});
