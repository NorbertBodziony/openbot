import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRemoteDesktopInputDigest,
  createRemoteDesktopReleaseTag,
  createRemoteDesktopSourceManifest,
  loadNativeRuntimeLock,
  parseNativeRuntimeLock,
} from "./native-runtime-lock";

describe("native runtime lock", () => {
  it("loads pinned native dependencies", async () => {
    const lock = await loadNativeRuntimeLock();

    expect(lock.remoteDesktop.sunshine.version).toBe("v2026.516.143833");
    expect(lock.remoteDesktop.moonlightWeb.version).toBe("v2.10.0");
    expect(lock.remoteDesktop.sunshine.sourceMode).toBe("openbot-fork");
    expect(lock.remoteDesktop.moonlightWeb.sourceMode).toBe("openbot-fork");
    expect(lock.remoteDesktop.sunshine.upstream.commit).toBe("14ffa6fdaa53f7b51512be2b3d24f3939695403c");
    expect(lock.remoteDesktop.moonlightWeb.upstream.commit).toBe("cd9d03cbf9a42b394f7b72a733a2f39cb5f0edd8");
  });

  it("creates a source manifest for both GPL runtimes", async () => {
    const lock = await loadNativeRuntimeLock();
    const manifest = createRemoteDesktopSourceManifest(lock);

    expect(manifest.sunshine.commit).toBe(lock.remoteDesktop.sunshine.commit);
    expect(manifest.moonlightWeb.commit).toBe(lock.remoteDesktop.moonlightWeb.commit);
    expect(manifest.inputDigest).toBe(createRemoteDesktopInputDigest(lock));
  });

  it("rejects an incomplete artifact platform set", async () => {
    const value = await releaseLockValue();
    Reflect.deleteProperty(value.remoteDesktop.releaseArtifacts, "win32-x64");
    expect(() => parseNativeRuntimeLock(value)).toThrow("missing the win32-x64 artifact");
  });

  it("rejects an invalid artifact SHA-256", async () => {
    const value = await releaseLockValue();
    value.remoteDesktop.releaseArtifacts["darwin-arm64"].sha256 = "bad";
    expect(() => parseNativeRuntimeLock(value)).toThrow();
  });

  it("rejects a release tag that does not match the digest", async () => {
    const value = await releaseLockValue();
    value.remoteDesktop.artifactRelease.tag = `remote-desktop-runtime-${"f".repeat(64)}`;
    expect(() => parseNativeRuntimeLock(value)).toThrow("release tag does not match");
  });

  it("rejects an input digest that does not match the recipe", async () => {
    const value = await releaseLockValue();
    value.remoteDesktop.artifactRelease.inputDigest = "f".repeat(64);
    value.remoteDesktop.artifactRelease.tag = createRemoteDesktopReleaseTag("f".repeat(64));
    expect(() => parseNativeRuntimeLock(value)).toThrow("input digest does not match");
  });

  it("keeps the embedded runtime on WebRTC without audio or WebSocket media", async () => {
    const patch = await readFile(
      resolve("vendor/remote-desktop/patches/moonlight-web-stream-v2.10.0-openbot.patch"),
      "utf8",
    );

    expect(patch).toContain("allow_transport_websockets: false");
    expect(patch).toContain("OpenBot embedded mode rejects WebSocket media transport");
    expect(patch).toContain('settings.dataTransport = "webrtc"');
    expect(patch).toContain("let _ = (audio_config, stream_config)");
    expect(patch).toContain('-import { WebSocketTransport } from "./transport/web_socket.js"');
    expect(patch).toContain('-import { buildAudioPipeline } from "./audio/pipeline.js"');
    expect(patch).toContain("play_audio_local: false");
    expect(patch).toContain("if (event.code == 4410)");
    expect(patch).toContain("location.reload()");
  });

  it("adds the authenticated Sunshine native display endpoint", async () => {
    const patch = await readFile(
      resolve("vendor/remote-desktop/patches/sunshine-v2026.516.143833-openbot.patch"),
      "utf8",
    );

    expect(patch).toContain('server.resource["^/api/openbot/displays$"]["GET"]');
    expect(patch).toContain("if (!authenticate(response, request))");
    expect(patch).toContain("platf::display_names");
  });
});

async function releaseLockValue() {
  const lock = await loadNativeRuntimeLock();
  const digest = createRemoteDesktopInputDigest(lock);
  return {
    ...structuredClone(lock),
    remoteDesktop: {
      ...structuredClone(lock.remoteDesktop),
      artifactRelease: {
        repository: "NorbertBodziony/openbot",
        tag: createRemoteDesktopReleaseTag(digest),
        inputDigest: digest,
        manifestAsset: "remote-desktop-runtime-manifest.json",
        manifestSha256: "a".repeat(64),
      },
      releaseArtifacts: {
        "darwin-arm64": { asset: "remote-desktop-runtime-darwin-arm64.tar.gz", sha256: "b".repeat(64) },
        "win32-x64": { asset: "remote-desktop-runtime-win32-x64.tar.gz", sha256: "c".repeat(64) },
      },
    },
  };
}
