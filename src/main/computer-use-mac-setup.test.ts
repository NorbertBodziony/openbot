import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTER_USE_HELPER_BUNDLE_ID,
  COMPUTER_USE_HELPER_RELATIVE_PATH,
  ComputerUseMacSetupService,
} from "./computer-use-mac-setup";

describe("ComputerUseMacSetupService", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-computer-use-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("returns the validated Computer Use helper and its icon", async () => {
    await writeHelper(root, COMPUTER_USE_HELPER_BUNDLE_ID);
    const getIconDataUrl = vi.fn(async () => "data:image/png;base64,icon");
    const service = new ComputerUseMacSetupService({
      platform: "darwin",
      codexHome: root,
      readPlist: async () => helperPlist(COMPUTER_USE_HELPER_BUNDLE_ID),
      verifyCodeSignature: async () => undefined,
      getIconDataUrl,
    });

    await expect(service.getState()).resolves.toEqual({
      status: "available",
      helperName: "Codex Computer Use",
      helperIconDataUrl: "data:image/png;base64,icon",
      message: null,
    });
    expect(getIconDataUrl).toHaveBeenCalledWith(join(root, COMPUTER_USE_HELPER_RELATIVE_PATH));
  });

  it("fails closed when the helper is missing or has another bundle identifier", async () => {
    const service = new ComputerUseMacSetupService({
      platform: "darwin",
      codexHome: root,
      readPlist: async () => helperPlist("example.untrusted.helper"),
      verifyCodeSignature: async () => undefined,
    });
    await expect(service.getState()).resolves.toMatchObject({ status: "unavailable" });

    await writeHelper(root, "example.untrusted.helper");
    await expect(service.requireHelper()).rejects.toThrow("unexpected bundle identifier");
    await expect(service.getState()).resolves.toMatchObject({ status: "unavailable" });
  });

  it("accepts a binary Info.plist through the macOS plist reader", async () => {
    await writeHelper(root, COMPUTER_USE_HELPER_BUNDLE_ID, Buffer.from("bplist00binary fixture"));
    const readPlist = vi.fn(async () => helperPlist(COMPUTER_USE_HELPER_BUNDLE_ID));
    const service = new ComputerUseMacSetupService({
      platform: "darwin",
      codexHome: root,
      readPlist,
      verifyCodeSignature: async () => undefined,
    });

    await expect(service.requireHelper()).resolves.toMatchObject({ name: "Codex Computer Use" });
    expect(readPlist).toHaveBeenCalledWith(join(root, COMPUTER_USE_HELPER_RELATIVE_PATH, "Contents", "Info.plist"));
  });

  it("fails closed when the helper signature is invalid", async () => {
    await writeHelper(root, COMPUTER_USE_HELPER_BUNDLE_ID);
    const verifyCodeSignature = vi.fn(async () => {
      throw new Error("invalid signature");
    });
    const readPlist = vi.fn(async () => helperPlist(COMPUTER_USE_HELPER_BUNDLE_ID));
    const service = new ComputerUseMacSetupService({
      platform: "darwin",
      codexHome: root,
      readPlist,
      verifyCodeSignature,
    });

    await expect(service.requireHelper()).rejects.toThrow("invalid signature");
    await expect(service.getState()).resolves.toMatchObject({ status: "unavailable" });
    expect(verifyCodeSignature).toHaveBeenCalledWith(join(root, COMPUTER_USE_HELPER_RELATIVE_PATH));
    expect(readPlist).not.toHaveBeenCalled();
  });

  it("rejects a helper bundle reached through a symbolic link", async () => {
    const targetRoot = join(root, "outside");
    await writeHelper(targetRoot, COMPUTER_USE_HELPER_BUNDLE_ID);
    await mkdir(join(root, "computer-use"), { recursive: true });
    await symlink(
      join(targetRoot, COMPUTER_USE_HELPER_RELATIVE_PATH),
      join(root, COMPUTER_USE_HELPER_RELATIVE_PATH),
      "dir",
    );
    const verifyCodeSignature = vi.fn(async () => undefined);
    const service = new ComputerUseMacSetupService({
      platform: "darwin",
      codexHome: root,
      readPlist: async () => helperPlist(COMPUTER_USE_HELPER_BUNDLE_ID),
      verifyCodeSignature,
    });

    await expect(service.requireHelper()).rejects.toThrow("not an application bundle");
    expect(verifyCodeSignature).not.toHaveBeenCalled();
  });

  it("reports the setup as unsupported away from macOS", async () => {
    const service = new ComputerUseMacSetupService({ platform: "linux", codexHome: root });
    await expect(service.getState()).resolves.toMatchObject({ status: "unsupported" });
  });
});

async function writeHelper(
  root: string,
  bundleId: string,
  plistContents: string | Uint8Array = `<?xml version="1.0"?><plist><dict>
      <key>CFBundleIdentifier</key><string>${bundleId}</string>
      <key>CFBundleName</key><string>Codex Computer Use</string>
      <key>CFBundleExecutable</key><string>SkyComputerUseService</string>
    </dict></plist>`,
): Promise<void> {
  const contents = join(root, COMPUTER_USE_HELPER_RELATIVE_PATH, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(join(contents, "Info.plist"), plistContents);
  await writeFile(join(contents, "MacOS", "SkyComputerUseService"), "helper");
}

function helperPlist(bundleId: string) {
  return {
    CFBundleIdentifier: bundleId,
    CFBundleName: "Codex Computer Use",
    CFBundleExecutable: "SkyComputerUseService",
  };
}
