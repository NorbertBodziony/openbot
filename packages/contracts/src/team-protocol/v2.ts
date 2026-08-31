import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "../runtime-values";

export const TEAM_PROTOCOL_V2 = 2 as const;
export const TEAM_PROTOCOL_V2_CHANNELS = {
  rpc: "openbot-team-v2-rpc",
  events: "openbot-team-v2-events",
  files: "openbot-team-v2-files",
} as const;
export const TEAM_PROTOCOL_V2_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const TEAM_PROTOCOL_V2_MAX_FILE_SET_BYTES = 250 * 1024 * 1024;
export const TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES = 64 * 1024;
export const TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES = 2 * 1024 * 1024;
export const TEAM_PROTOCOL_V2_BUFFERED_AMOUNT_HIGH_WATER = 4 * 1024 * 1024;
export const TEAM_PROTOCOL_V2_BUFFERED_AMOUNT_LOW_WATER = 1 * 1024 * 1024;

export type TeamProtocolV2Json =
  | null
  | boolean
  | number
  | string
  | TeamProtocolV2Json[]
  | { [key: string]: TeamProtocolV2Json };

export interface TeamProtocolV2Error {
  code: string;
  message: string;
  retryable: boolean;
  status?: number;
}

export type TeamProtocolV2RpcFrame =
  | { version: 2; type: "request"; requestId: string; operation: string; payload: TeamProtocolV2Json }
  | { version: 2; type: "response"; requestId: string; result: TeamProtocolV2Json }
  | { version: 2; type: "response"; requestId: string; error: TeamProtocolV2Error };

export type TeamProtocolV2EventFrame =
  | { version: 2; type: "event"; sequence: number; payload: TeamProtocolV2Json }
  | { version: 2; type: "event-ack"; throughSequence: number }
  | { version: 2; type: "event-reset"; nextSequence: number }
  | {
      version: 2;
      type: "event-control";
      control:
        | { type: "runtime-snapshot-request" }
        | { type: "team-typing"; botId: string | null; typing: boolean }
        | { type: "team-direct-typing"; recipientMemberId: string; typing: boolean };
    };

export type TeamProtocolV2FileControlFrame =
  | {
      version: 2;
      type: "file-open";
      transferId: string;
      name: string;
      size: number;
      mimeType: string;
      sha256: string;
    }
  | { version: 2; type: "file-ack"; transferId: string; receivedThrough: number }
  | { version: 2; type: "file-complete"; transferId: string }
  | { version: 2; type: "file-cancel"; transferId: string; reason: string };

export interface TeamProtocolV2FileChunk {
  transferId: string;
  offset: number;
  bytes: Uint8Array;
}

export function decodeTeamProtocolV2RpcFrame(value: string | unknown): TeamProtocolV2RpcFrame {
  const frame = decodeJsonFrame(value);
  if (!isDynamicRecord(frame) || frame.version !== 2 || !isString(frame.type) || !identifier(frame.requestId)) {
    throw invalid("RPC frame");
  }
  if (frame.type === "request" && operation(frame.operation) && isJson(frame.payload)) {
    return {
      version: 2,
      type: "request",
      requestId: frame.requestId,
      operation: frame.operation,
      payload: frame.payload,
    };
  }
  if (frame.type === "response") {
    const hasResult = Object.hasOwn(frame, "result");
    const hasError = Object.hasOwn(frame, "error");
    if (hasResult === hasError) throw invalid("RPC response");
    if (hasResult && isJson(frame.result))
      return { version: 2, type: "response", requestId: frame.requestId, result: frame.result };
    if (hasError && isError(frame.error))
      return { version: 2, type: "response", requestId: frame.requestId, error: frame.error };
  }
  throw invalid("RPC frame");
}

export function decodeTeamProtocolV2EventFrame(value: string | unknown): TeamProtocolV2EventFrame {
  const frame = decodeJsonFrame(value);
  if (!isDynamicRecord(frame) || frame.version !== 2 || !isString(frame.type)) throw invalid("event frame");
  if (frame.type === "event" && sequence(frame.sequence) && isJson(frame.payload)) {
    return { version: 2, type: "event", sequence: frame.sequence, payload: frame.payload };
  }
  if (frame.type === "event-ack" && offset(frame.throughSequence)) {
    return { version: 2, type: "event-ack", throughSequence: frame.throughSequence };
  }
  if (frame.type === "event-reset" && sequence(frame.nextSequence)) {
    return { version: 2, type: "event-reset", nextSequence: frame.nextSequence };
  }
  if (frame.type === "event-control" && isDynamicRecord(frame.control) && isString(frame.control.type)) {
    if (frame.control.type === "runtime-snapshot-request") {
      return { version: 2, type: "event-control", control: { type: "runtime-snapshot-request" } };
    }
    if (
      frame.control.type === "team-typing" &&
      (frame.control.botId === null || identifier(frame.control.botId)) &&
      isBoolean(frame.control.typing)
    ) {
      return {
        version: 2,
        type: "event-control",
        control: { type: "team-typing", botId: frame.control.botId, typing: frame.control.typing },
      };
    }
    if (
      frame.control.type === "team-direct-typing" &&
      identifier(frame.control.recipientMemberId) &&
      isBoolean(frame.control.typing)
    ) {
      return {
        version: 2,
        type: "event-control",
        control: {
          type: "team-direct-typing",
          recipientMemberId: frame.control.recipientMemberId,
          typing: frame.control.typing,
        },
      };
    }
  }
  throw invalid("event frame");
}

export function decodeTeamProtocolV2FileControlFrame(value: string | unknown): TeamProtocolV2FileControlFrame {
  const frame = decodeJsonFrame(value);
  if (!isDynamicRecord(frame) || frame.version !== 2 || !isString(frame.type) || !identifier(frame.transferId)) {
    throw invalid("file frame");
  }
  if (
    frame.type === "file-open" &&
    text(frame.name, 255) &&
    isNumber(frame.size) &&
    Number.isSafeInteger(frame.size) &&
    frame.size >= 0 &&
    frame.size <= TEAM_PROTOCOL_V2_MAX_FILE_BYTES &&
    text(frame.mimeType, 255) &&
    isString(frame.sha256) &&
    /^[a-f0-9]{64}$/u.test(frame.sha256)
  ) {
    return {
      version: 2,
      type: "file-open",
      transferId: frame.transferId,
      name: frame.name,
      size: frame.size,
      mimeType: frame.mimeType,
      sha256: frame.sha256,
    };
  }
  if (frame.type === "file-ack" && offset(frame.receivedThrough)) {
    return { version: 2, type: "file-ack", transferId: frame.transferId, receivedThrough: frame.receivedThrough };
  }
  if (frame.type === "file-complete") return { version: 2, type: "file-complete", transferId: frame.transferId };
  if (frame.type === "file-cancel" && text(frame.reason, 256)) {
    return { version: 2, type: "file-cancel", transferId: frame.transferId, reason: frame.reason };
  }
  throw invalid("file frame");
}

export function encodeTeamProtocolV2Frame(
  frame: TeamProtocolV2RpcFrame | TeamProtocolV2EventFrame | TeamProtocolV2FileControlFrame,
): string {
  let encoded: string;
  if (frame.type === "request" || frame.type === "response")
    encoded = JSON.stringify(decodeTeamProtocolV2RpcFrame(frame));
  else if (
    frame.type === "event" ||
    frame.type === "event-ack" ||
    frame.type === "event-reset" ||
    frame.type === "event-control"
  )
    encoded = JSON.stringify(decodeTeamProtocolV2EventFrame(frame));
  else encoded = JSON.stringify(decodeTeamProtocolV2FileControlFrame(frame));
  if (byteLength(encoded) > TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES) throw invalid("JSON frame size");
  return encoded;
}

export function encodeTeamProtocolV2FileChunk(
  chunk: TeamProtocolV2FileChunk,
  maximumMessageSize = Number.POSITIVE_INFINITY,
): Uint8Array {
  if (!identifier(chunk.transferId) || !offset(chunk.offset) || !(chunk.bytes instanceof Uint8Array))
    throw invalid("file chunk");
  const transferId = new TextEncoder().encode(chunk.transferId);
  const frameSize = 10 + transferId.byteLength + chunk.bytes.byteLength;
  const limit = Math.min(TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES, maximumMessageSize);
  if (frameSize > limit || chunk.bytes.byteLength === 0) throw invalid("file chunk size");
  const output = new Uint8Array(frameSize);
  output[0] = TEAM_PROTOCOL_V2;
  output[1] = transferId.byteLength;
  output.set(transferId, 2);
  new DataView(output.buffer).setBigUint64(2 + transferId.byteLength, BigInt(chunk.offset));
  output.set(chunk.bytes, 10 + transferId.byteLength);
  return output;
}

export function decodeTeamProtocolV2FileChunk(value: ArrayBuffer | Uint8Array): TeamProtocolV2FileChunk {
  const frame = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (
    frame.byteLength > TEAM_PROTOCOL_V2_MAX_BINARY_FRAME_BYTES ||
    frame.byteLength < 12 ||
    frame[0] !== TEAM_PROTOCOL_V2
  ) {
    throw invalid("file chunk");
  }
  const identifierLength = frame[1] ?? 0;
  const payloadOffset = 10 + identifierLength;
  if (identifierLength === 0 || payloadOffset >= frame.byteLength) throw invalid("file chunk");
  const transferId = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(2, 2 + identifierLength));
  const decodedOffset = Number(
    new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(2 + identifierLength),
  );
  if (!identifier(transferId) || !offset(decodedOffset)) throw invalid("file chunk");
  return { transferId, offset: decodedOffset, bytes: frame.slice(payloadOffset) };
}

function isError(value: unknown): value is TeamProtocolV2Error {
  return (
    isDynamicRecord(value) &&
    operation(value.code) &&
    text(value.message, 512) &&
    isBoolean(value.retryable) &&
    (value.status === undefined ||
      (isNumber(value.status) && Number.isSafeInteger(value.status) && value.status >= 400 && value.status <= 599))
  );
}

export function decodeTeamProtocolV2Json(value: unknown): TeamProtocolV2Json {
  if (!isJson(value)) throw invalid("JSON value");
  return value;
}

function identifier(value: unknown): value is string {
  return isString(value) && /^[A-Za-z0-9:_-]{1,128}$/u.test(value);
}

function operation(value: unknown): value is string {
  return isString(value) && /^[a-z0-9][a-z0-9._:/-]{0,127}$/u.test(value);
}

function text(value: unknown, maximum: number): value is string {
  return isString(value) && value.length > 0 && value.length <= maximum;
}

function sequence(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 1;
}

function offset(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isJson(value: unknown, depth = 0): value is TeamProtocolV2Json {
  if (depth > 32) return false;
  if (value === null || isBoolean(value) || isString(value)) return true;
  if (isNumber(value)) return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => isJson(item, depth + 1));
  if (!isDynamicRecord(value) || Object.keys(value).length > 10_000) return false;
  return Object.values(value).every((item) => isJson(item, depth + 1));
}

function decodeJsonFrame(value: unknown): DynamicRecord | null {
  if (!isString(value)) return isDynamicRecord(value) ? value : null;
  if (byteLength(value) > TEAM_PROTOCOL_V2_MAX_JSON_FRAME_BYTES) throw invalid("JSON frame size");
  const parsed = JSON.parse(value);
  return isDynamicRecord(parsed) ? parsed : null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalid(name: string): Error {
  return new Error(`Invalid Team protocol v2 ${name}.`);
}
