// @vitest-environment node

import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { describe, expect, it, vi } from "vitest";
import { type RendererIpcWindow, sendToRenderer } from "./renderer-ipc";

function rendererWindow(
  overrides: {
    windowDestroyed?: boolean;
    contentsDestroyed?: boolean;
    loading?: boolean;
    frameDestroyed?: boolean;
    detached?: boolean;
    sendError?: Error;
  } = {},
): RendererIpcWindow {
  const send = vi.fn(() => {
    if (overrides.sendError) throw overrides.sendError;
  });
  return {
    isDestroyed: () => overrides.windowDestroyed ?? false,
    webContents: {
      isDestroyed: () => overrides.contentsDestroyed ?? false,
      isLoadingMainFrame: () => overrides.loading ?? false,
      mainFrame: {
        isDestroyed: () => overrides.frameDestroyed ?? false,
        detached: overrides.detached ?? false,
      },
      send,
    },
  };
}

describe("renderer IPC", () => {
  it("sends to a live renderer frame", () => {
    const window = rendererWindow();

    expect(sendToRenderer(window, IPC_CHANNELS.updateEvent, { ready: true })).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.updateEvent, { ready: true });
  });

  it.each([
    ["destroyed window", { windowDestroyed: true }],
    ["destroyed web contents", { contentsDestroyed: true }],
    ["main-frame reload", { loading: true }],
    ["destroyed main frame", { frameDestroyed: true }],
    ["detached main frame", { detached: true }],
  ])("does not send during a %s", (_name, overrides) => {
    const window = rendererWindow(overrides);

    expect(sendToRenderer(window, IPC_CHANNELS.updateEvent)).toBe(false);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error("write EIO"), { code: "EIO" }),
    Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    new Error("Render frame was disposed before WebFrameMain could be accessed"),
  ])("contains an unavailable-renderer race without crashing the main process", (error) => {
    expect(sendToRenderer(rendererWindow({ sendError: error }), IPC_CHANNELS.updateEvent)).toBe(false);
  });

  it("does not hide unrelated IPC errors", () => {
    const error = new Error("An object could not be cloned");

    expect(() => sendToRenderer(rendererWindow({ sendError: error }), IPC_CHANNELS.updateEvent)).toThrow(error);
  });
});
