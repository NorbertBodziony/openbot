const MAGIC = new Uint8Array([0x4f, 0x42, 0x44, 0x31]);
const MAX_SIGNAL_BYTES = 1024 * 1024;

export type RemoteDesktopSignalControl =
  | { type: "open"; streamId: string; path: string }
  | { type: "opened"; streamId: string }
  | { type: "text"; streamId: string; data: string }
  | { type: "close"; streamId: string; code?: number; reason?: string }
  | { type: "error"; streamId: string; message: string };

export function encodeRemoteDesktopSignalControl(message: RemoteDesktopSignalControl): string {
  return JSON.stringify(message);
}

export function decodeRemoteDesktopSignalControl(value: string): RemoteDesktopSignalControl {
  const message = JSON.parse(value);
  if (!isDynamicRecord(message) || !isString(message.type) || !identifier(message.streamId)) {
    throw new Error("Invalid remote desktop signal message.");
  }
  if (message.type === "open" && isString(message.path) && message.path.length <= 2_048) {
    return { type: "open", streamId: message.streamId, path: message.path };
  }
  if (message.type === "opened") return { type: "opened", streamId: message.streamId };
  if (message.type === "text" && isString(message.data) && message.data.length <= 1024 * 1024) {
    return { type: "text", streamId: message.streamId, data: message.data };
  }
  if (message.type === "close") {
    return {
      type: "close",
      streamId: message.streamId,
      ...(isNumber(message.code) && Number.isInteger(message.code) ? { code: message.code } : {}),
      ...(isString(message.reason) ? { reason: message.reason.slice(0, 123) } : {}),
    };
  }
  if (message.type === "error" && isString(message.message)) {
    return { type: "error", streamId: message.streamId, message: message.message.slice(0, 512) };
  }
  throw new Error("Invalid remote desktop signal message.");
}

export function encodeRemoteDesktopSignalBinary(streamId: string, data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (!identifier(streamId)) throw new Error("Invalid remote desktop stream ID.");
  const id = new TextEncoder().encode(streamId);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > MAX_SIGNAL_BYTES) throw new Error("The remote desktop binary signal is too large.");
  const result = new Uint8Array(MAGIC.byteLength + 1 + id.byteLength + bytes.byteLength);
  result.set(MAGIC, 0);
  result[MAGIC.byteLength] = id.byteLength;
  result.set(id, MAGIC.byteLength + 1);
  result.set(bytes, MAGIC.byteLength + 1 + id.byteLength);
  return result.buffer;
}

export function decodeRemoteDesktopSignalBinary(data: ArrayBuffer): { streamId: string; bytes: Uint8Array } {
  const bytes = new Uint8Array(data);
  if (
    bytes.byteLength > MAGIC.byteLength + 1 + 64 + MAX_SIGNAL_BYTES ||
    bytes.byteLength < MAGIC.byteLength + 2 ||
    !MAGIC.every((byte, index) => bytes[index] === byte)
  ) {
    throw new Error("Invalid remote desktop binary signal.");
  }
  const idLength = bytes[MAGIC.byteLength] ?? 0;
  const dataOffset = MAGIC.byteLength + 1 + idLength;
  if (idLength === 0 || dataOffset > bytes.byteLength) throw new Error("Invalid remote desktop binary signal.");
  const streamId = new TextDecoder().decode(bytes.slice(MAGIC.byteLength + 1, dataOffset));
  if (!identifier(streamId)) throw new Error("Invalid remote desktop stream ID.");
  return { streamId, bytes: bytes.slice(dataOffset) };
}

function identifier(value: unknown): value is string {
  return isString(value) && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
