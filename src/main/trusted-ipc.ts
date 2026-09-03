import { type IpcMainInvokeEvent, ipcMain } from "electron";
import { isTrustedRendererUrl } from "./trusted-renderer";

// A handler that takes a payload can only be registered with a decoder for it, because there is no
// overload that pairs one with a raw `unknown`. That is what keeps validation from being a
// convention: a registration that does not say how its payload decodes is a compile error, not a
// hole for review to catch. The decoder is a plain `(value: unknown) => Payload`, so it can be a
// hand-written parser, a zod `parse`, or anything else, without changing a call site.
type PayloadDecoder<Payload> = (value: unknown) => Payload;

// The implementation takes the two shapes as a tuple union so its length discriminates them. A
// plain union of the second parameter would need a type assertion to call either arm, and asserting
// past the checker inside the trust boundary's own wrapper is the last place worth doing it.
type TrustedRegistration =
  | [handler: () => unknown]
  | [decode: PayloadDecoder<unknown>, handler: (payload: unknown) => unknown];

type TrustedEventRegistration =
  | [handler: (event: IpcMainInvokeEvent) => unknown]
  | [decode: PayloadDecoder<unknown>, handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown];

export function handleTrusted<Result>(channel: string, handler: () => Result): void;
export function handleTrusted<Payload, Result>(
  channel: string,
  decode: PayloadDecoder<Payload>,
  handler: (payload: Payload) => Result,
): void;
export function handleTrusted(channel: string, ...registration: TrustedRegistration): void {
  ipcMain.handle(channel, (event, payload: unknown) => {
    // The sender check runs first, and inline: an untrusted renderer is rejected before the process
    // spends any work decoding what it sent, and the static scan in ipc-channel-coverage.test.ts
    // reads this call's own body for the check, so extracting it into a helper would blind the scan.
    if (!isTrustedRendererUrl(event.senderFrame?.url)) {
      throw new Error("Rejected IPC request from an untrusted renderer.");
    }
    if (registration.length === 1) return registration[0]();
    const [decode, handler] = registration;
    return handler(decode(payload));
  });
}

export function handleTrustedWithEvent<Result>(channel: string, handler: (event: IpcMainInvokeEvent) => Result): void;
export function handleTrustedWithEvent<Payload, Result>(
  channel: string,
  decode: PayloadDecoder<Payload>,
  handler: (event: IpcMainInvokeEvent, payload: Payload) => Result,
): void;
export function handleTrustedWithEvent(channel: string, ...registration: TrustedEventRegistration): void {
  ipcMain.handle(channel, (event, payload: unknown) => {
    if (!isTrustedRendererUrl(event.senderFrame?.url)) {
      throw new Error("Rejected IPC request from an untrusted renderer.");
    }
    if (registration.length === 1) return registration[0](event);
    const [decode, handler] = registration;
    return handler(event, decode(payload));
  });
}
