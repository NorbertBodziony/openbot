export interface RendererIpcWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    isLoadingMainFrame(): boolean;
    mainFrame: {
      isDestroyed(): boolean;
      readonly detached: boolean;
    };
    send(channel: string, ...args: unknown[]): void;
  };
}

export function sendToRenderer(
  window: RendererIpcWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!window || window.isDestroyed()) return false;

  try {
    const contents = window.webContents;
    if (contents.isDestroyed() || contents.isLoadingMainFrame()) return false;
    const frame = contents.mainFrame;
    if (frame.isDestroyed() || frame.detached) return false;
    contents.send(channel, ...args);
    return true;
  } catch (error) {
    if (isUnavailableRendererError(error)) return false;
    throw error;
  }
}

function isUnavailableRendererError(error: unknown): boolean {
  if (error instanceof Error && "code" in error && (error.code === "EIO" || error.code === "EPIPE")) return true;
  if (!(error instanceof Error)) return false;
  return /Render frame was disposed|Object has been destroyed|WebContents (?:was|is) destroyed/u.test(error.message);
}
