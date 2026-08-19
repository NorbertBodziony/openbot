import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";

export const JSON_BODY_LIMIT = 16 * 1024;

export class JsonBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: "invalid_json" | "request_too_large",
    message: string,
  ) {
    super(message);
  }
}

export async function readJsonObject(request: Request): Promise<DynamicRecord> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > JSON_BODY_LIMIT) {
      throw tooLarge();
    }
  }

  const reader = request.body?.getReader();
  if (!reader) throw invalidJson();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > JSON_BODY_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!isDynamicRecord(value)) throw invalidJson();
    return value;
  } catch (error) {
    if (error instanceof JsonBodyError) throw error;
    throw invalidJson();
  }
}

function invalidJson(): JsonBodyError {
  return new JsonBodyError(400, "invalid_json", "The request body is invalid.");
}

function tooLarge(): JsonBodyError {
  return new JsonBodyError(413, "request_too_large", "The request body is too large.");
}
