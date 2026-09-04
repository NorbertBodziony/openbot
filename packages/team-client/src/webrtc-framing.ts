import { isString } from "@openbot/contracts/runtime-values";
import {
  TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES,
  TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES,
} from "@openbot/contracts/team-protocol/v2";

const FRAME_MAGIC = 0x4f425732;
const FRAME_HEADER_BYTES = 17;
const FRAME_TYPE_TEXT = 1;
const FRAME_TYPE_BINARY = 2;
const MAXIMUM_ASSEMBLIES = 16;
const MAXIMUM_BUFFERED_BYTES = 8 * 1024 * 1024;
const ASSEMBLY_EXPIRY_MILLISECONDS = 30_000;

interface Assembly {
  type: number;
  bytes: Uint8Array<ArrayBuffer>;
  received: number;
  updatedAt: number;
}

export function encodeTeamWebRtcPayload(
  data: string | ArrayBuffer,
  maximumMessageSize: number,
  messageId = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0,
): Array<string | ArrayBuffer> {
  const maximumFrameBytes = normalizedMaximumMessageSize(maximumMessageSize);
  const bytes = isString(data) ? new TextEncoder().encode(data) : new Uint8Array(data);
  if (isString(data) && bytes.byteLength <= maximumFrameBytes) return [data];
  if (bytes.byteLength > TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES) {
    throw new Error("The WebRTC payload is larger than the protocol limit.");
  }
  const maximumChunkBytes = maximumFrameBytes - FRAME_HEADER_BYTES;
  if (maximumChunkBytes <= 0) throw new Error("The negotiated WebRTC message size is too small.");
  const frames: Array<ArrayBuffer> = [];
  const type = isString(data) ? FRAME_TYPE_TEXT : FRAME_TYPE_BINARY;
  for (
    let offset = 0;
    offset < bytes.byteLength || (bytes.byteLength === 0 && offset === 0);
    offset += maximumChunkBytes
  ) {
    const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + maximumChunkBytes));
    const frame = new Uint8Array(FRAME_HEADER_BYTES + chunk.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, FRAME_MAGIC);
    view.setUint32(4, messageId);
    view.setUint32(8, bytes.byteLength);
    view.setUint32(12, offset);
    frame[16] = type;
    frame.set(chunk, FRAME_HEADER_BYTES);
    frames.push(frame.buffer);
    if (bytes.byteLength === 0) break;
  }
  return frames;
}

export class TeamWebRtcPayloadDecoder {
  readonly #assemblies = new Map<number, Assembly>();
  #bufferedBytes = 0;

  push(data: string | ArrayBuffer, now = Date.now()): string | ArrayBuffer | undefined {
    if (isString(data)) return data;
    this.#prune(now);
    const frame = new Uint8Array(data);
    if (frame.byteLength < FRAME_HEADER_BYTES) throw new Error("The WebRTC payload frame is invalid.");
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (view.getUint32(0) !== FRAME_MAGIC) throw new Error("The WebRTC payload frame is invalid.");
    const messageId = view.getUint32(4);
    const totalBytes = view.getUint32(8);
    const offset = view.getUint32(12);
    const type = frame[16];
    const chunk = frame.subarray(FRAME_HEADER_BYTES);
    if (
      (type !== FRAME_TYPE_TEXT && type !== FRAME_TYPE_BINARY) ||
      totalBytes > TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES ||
      offset > totalBytes ||
      offset + chunk.byteLength > totalBytes ||
      (totalBytes > 0 && chunk.byteLength === 0)
    ) {
      this.#delete(messageId);
      throw new Error("The WebRTC payload frame is invalid.");
    }
    let assembly = this.#assemblies.get(messageId);
    if (offset === 0) {
      if (assembly) this.#delete(messageId);
      if (this.#assemblies.size >= MAXIMUM_ASSEMBLIES || this.#bufferedBytes + totalBytes > MAXIMUM_BUFFERED_BYTES) {
        throw new Error("Too many WebRTC payloads are being assembled.");
      }
      assembly = { type, bytes: new Uint8Array(totalBytes), received: 0, updatedAt: now };
      this.#assemblies.set(messageId, assembly);
      this.#bufferedBytes += totalBytes;
    }
    if (
      !assembly ||
      assembly.type !== type ||
      assembly.bytes.byteLength !== totalBytes ||
      offset !== assembly.received
    ) {
      this.#delete(messageId);
      throw new Error("The WebRTC payload fragments are not contiguous.");
    }
    assembly.bytes.set(chunk, offset);
    assembly.received += chunk.byteLength;
    assembly.updatedAt = now;
    if (assembly.received !== totalBytes) return undefined;
    const result = assembly.bytes;
    this.#delete(messageId);
    if (type === FRAME_TYPE_TEXT) return new TextDecoder("utf-8", { fatal: true }).decode(result);
    return result.buffer;
  }

  reset(): void {
    this.#assemblies.clear();
    this.#bufferedBytes = 0;
  }

  #prune(now: number): void {
    for (const [messageId, assembly] of this.#assemblies) {
      if (now - assembly.updatedAt >= ASSEMBLY_EXPIRY_MILLISECONDS) this.#delete(messageId);
    }
  }

  #delete(messageId: number): void {
    const assembly = this.#assemblies.get(messageId);
    if (!assembly) return;
    this.#bufferedBytes -= assembly.bytes.byteLength;
    this.#assemblies.delete(messageId);
  }
}

function normalizedMaximumMessageSize(maximumMessageSize: number): number {
  if (!Number.isFinite(maximumMessageSize) || maximumMessageSize <= 0) return TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES;
  return Math.min(Math.floor(maximumMessageSize), TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES);
}
