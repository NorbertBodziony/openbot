import { ipcMain } from "electron";
import { isTrustedRendererUrl } from "./trusted-renderer";

export function handleTrusted<Arguments extends unknown[], Result>(
  channel: string,
  handler: (...arguments_: Arguments) => Result,
): void {
  ipcMain.handle(channel, (event, ...arguments_: unknown[]) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url)) {
      throw new Error("Rejected IPC request from an untrusted renderer.");
    }
    return handler(...(arguments_ as Arguments));
  });
}
