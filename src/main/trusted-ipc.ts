import { ipcMain } from "electron";
import { isTrustedRendererUrl } from "./trusted-renderer";

export function handleTrusted<Result>(channel: string, handler: (...arguments_: unknown[]) => Result): void {
  ipcMain.handle(channel, (event, ...arguments_: unknown[]) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url)) {
      throw new Error("Rejected IPC request from an untrusted renderer.");
    }
    return handler(...arguments_);
  });
}
