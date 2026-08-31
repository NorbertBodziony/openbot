import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTER_USE_HELPER_BUNDLE_ID,
  COMPUTER_USE_HELPER_RELATIVE_PATH,
  ComputerUseMacSetupService,
} from "./computer-use-mac-setup";
import { COMPUTER_USE_PERMISSION_URLS, ComputerUseMacSetupWindowController } from "./computer-use-mac-setup-window";

describe("ComputerUseMacSetupWindowController", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openbot-computer-use-window-"));
    await writeHelper(root);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("opens the right System Settings pane, reuses the helper window, and drags only from it", async () => {
    const startDrag = vi.fn();
    const sender = { id: 41, startDrag };
    const show = vi.fn();
    const focus = vi.fn();
    const listeners = new Map<string, () => void>();
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: sender,
      show,
      focus,
      close: vi.fn(),
      on: (event: string, listener: () => void) => listeners.set(event, listener),
    };
    const createWindow = vi.fn(() => {
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: the test double implements the controller's window surface.
      return fakeWindow as unknown as BrowserWindow;
    });
    const openExternal = vi.fn(async () => undefined);
    const loadWindow = vi.fn(async () => undefined);
    const revealPath = vi.fn();
    const service = new ComputerUseMacSetupService({ platform: "darwin", codexHome: root });
    const controller = new ComputerUseMacSetupWindowController({
      service,
      createWindow,
      loadWindow,
      openExternal,
      revealPath,
      loadDragIcon: async () => "helper-icon.png",
    });

    await controller.open("accessibility");
    await controller.open("screen-recording");

    expect(openExternal).toHaveBeenNthCalledWith(1, COMPUTER_USE_PERMISSION_URLS.accessibility);
    expect(openExternal).toHaveBeenNthCalledWith(2, COMPUTER_USE_PERMISSION_URLS["screen-recording"]);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(loadWindow).toHaveBeenNthCalledWith(1, fakeWindow, "accessibility");
    expect(loadWindow).toHaveBeenNthCalledWith(2, fakeWindow, "screen-recording");
    expect(show).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenCalledTimes(2);

    // biome-ignore lint/nursery/noUnsafeTypeAssertion: the sender double implements the required drag surface.
    await controller.startDrag(sender as unknown as WebContents);
    expect(startDrag).toHaveBeenCalledWith({
      file: join(root, COMPUTER_USE_HELPER_RELATIVE_PATH),
      icon: "helper-icon.png",
    });

    const otherSender = { id: 99, startDrag: vi.fn() };
    await expect(
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: the sender double exercises the rejected renderer path.
      controller.startDrag(otherSender as unknown as WebContents),
    ).rejects.toThrow("must start from the setup window");

    await controller.revealHelper();
    expect(revealPath).toHaveBeenCalledWith(join(root, COMPUTER_USE_HELPER_RELATIVE_PATH));
  });
});

async function writeHelper(root: string): Promise<void> {
  const contents = join(root, COMPUTER_USE_HELPER_RELATIVE_PATH, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(
    join(contents, "Info.plist"),
    `<?xml version="1.0"?><plist><dict>
      <key>CFBundleIdentifier</key><string>${COMPUTER_USE_HELPER_BUNDLE_ID}</string>
      <key>CFBundleName</key><string>Codex Computer Use</string>
      <key>CFBundleExecutable</key><string>SkyComputerUseService</string>
    </dict></plist>`,
  );
  await writeFile(join(contents, "MacOS", "SkyComputerUseService"), "helper");
}
