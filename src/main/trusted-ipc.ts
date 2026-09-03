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

// `() => Result` alone would not close the hole: a handler declared `(payload?: unknown)`, one with a
// default, and one taking `...rest` are all assignable to it, so they would bind to the no-payload
// overload and then be called with nothing. The renderer's payload is dropped rather than passed on,
// so no unvalidated value reaches a handler either way — but the registration compiles while quietly
// meaning something else, which is the ambiguity this change exists to remove. Constraining the
// parameter tuple's own length rejects all three, and says why in the diagnostic.
type ArityMessage = "this handler takes a payload, so it must be registered with a decoder for it";

type TakesNoArguments<Handler> = Handler extends (...args: infer Args) => unknown
  ? Args["length"] extends 0
    ? unknown
    : ArityMessage
  : never;

// The event is passed by the wrapper, not the renderer, so a handler may name it or ignore it.
type TakesEventOnly<Handler> = Handler extends (...args: infer Args) => unknown
  ? Args["length"] extends 0 | 1
    ? unknown
    : ArityMessage
  : never;

type TrustedEventRegistration =
  | [handler: (event: IpcMainInvokeEvent) => unknown]
  | [decode: PayloadDecoder<unknown>, handler: (event: IpcMainInvokeEvent, payload: unknown) => unknown];

export function handleTrusted<Handler extends () => unknown>(
  channel: string,
  handler: Handler & TakesNoArguments<Handler>,
): void;
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

export function handleTrustedWithEvent<Handler extends (event: IpcMainInvokeEvent) => unknown>(
  channel: string,
  handler: Handler & TakesEventOnly<Handler>,
): void;
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
