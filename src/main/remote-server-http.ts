// Putting one Team API call on the wire, and reading what came back off it.
//
// Two encodings live here and must not be collapsed into one. A negotiated V3 host is framed by
// `@openbot/contracts/team-protocol/v3-adapter`; anything older by the V1 adapter. Both are released
// wire protocols, so an existing host will keep speaking the one it shipped with forever -- see
// `packages/contracts/AGENTS.md`. `webRtcRequestBody` is the third: it re-frames a JSON body as
// protocol V2 for the WebRTC transport, and returns the body untouched when it cannot, because a
// released host already accepts that shape.
//
// Nothing here knows a server exists. It takes a URL, a token and a protocol number, and it either
// returns a decoded value or throws one of `remote-server-errors.ts`. Deciding what a throw means for
// the user is `remote-server-connection-status.ts`; deciding which server to ask is the caller's.

import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import {
  decodeTeamProtocolV1CurrentHttpResponse,
  encodeTeamProtocolV1CurrentHttpRequest,
} from "@openbot/contracts/team-protocol/v1-adapter";
import { decodeTeamProtocolV2Json, type TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { TEAM_PROTOCOL_V3 } from "@openbot/contracts/team-protocol/v3";
import {
  decodeTeamProtocolV3CurrentHttpResponse,
  encodeTeamProtocolV3CurrentHttpRequest,
} from "@openbot/contracts/team-protocol/v3-adapter";
import type { ResponseDecoder } from "./remote-host-decoding";
import { RemoteProtocolError, RemoteRequestError } from "./remote-server-errors";

export const REMOTE_REQUEST_TIMEOUT_MS = 15_000;

export function remoteFetch(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = REMOTE_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export async function requestJson<T>(
  apiUrl: string,
  path: string,
  decoder: ResponseDecoder<T>,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    protocol?: number;
    appVersion?: string;
    capabilities?: readonly TeamCurrentCapability[];
    preserveSemanticTags?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const response = await remoteFetch(
    new URL(path, apiUrl),
    {
      method,
      headers: {
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.protocol ? { [TEAM_PROTOCOL_VERSION_HEADER]: String(options.protocol) } : {}),
        ...(options.appVersion ? { [TEAM_APP_VERSION_HEADER]: options.appVersion } : {}),
        ...(options.capabilities ? { [TEAM_CAPABILITIES_HEADER]: options.capabilities.join(",") } : {}),
      },
      body:
        options.body === undefined
          ? undefined
          : options.protocol === TEAM_PROTOCOL_V3
            ? encodeTeamProtocolV3CurrentHttpRequest(method, path, options.body, {
                preserveSemanticTags: options.preserveSemanticTags,
              })
            : encodeTeamProtocolV1CurrentHttpRequest(method, path, options.body, {
                preserveSemanticTags: options.preserveSemanticTags,
              }),
    },
    options.timeoutMs,
  );
  let value: unknown;
  if (response.status !== 204) {
    try {
      value = await response.json();
    } catch (error) {
      // A body the host said was JSON and is not is the same failure as one that decodes to the
      // wrong shape, so it leaves here as the same error. Raw, it was a `SyntaxError` that only
      // `classifyRemoteConnectionError` recognised -- every caller checking for a protocol failure
      // by class, the desktop probe among them, let it through as an ordinary rejection.
      if (response.ok) {
        throw new RemoteProtocolError("protocol_error", "The host returned invalid data.", null, { cause: error });
      }
    }
  }
  if (value !== undefined) {
    try {
      value =
        options.protocol === TEAM_PROTOCOL_V3
          ? decodeTeamProtocolV3CurrentHttpResponse(method, path, response.status, value)
          : decodeTeamProtocolV1CurrentHttpResponse(method, path, response.status, value);
    } catch (error) {
      throw new RemoteProtocolError(
        "protocol_error",
        "The host returned data that this app could not safely use.",
        null,
        { cause: error },
      );
    }
  }
  if (!response.ok) {
    const message =
      isDynamicRecord(value) && isString(value.error)
        ? value.error
        : `Remote server request failed (${response.status}).`;
    const code = isDynamicRecord(value) && isString(value.code) ? value.code : null;
    throw new RemoteRequestError(response.status, message, code);
  }
  try {
    return decoder(value);
  } catch (error) {
    throw new RemoteProtocolError(
      "protocol_error",
      "The host returned data that this app could not safely use.",
      null,
      {
        cause: error,
      },
    );
  }
}

export function webRtcRequestBody(
  body: RequestInit["body"],
  contentType: string | undefined,
): RequestInit["body"] | TeamProtocolV2Json {
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!body || (mimeType !== "application/json" && !mimeType?.endsWith("+json"))) return body;
  let text: string;
  if (isString(body)) text = body;
  else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(body);
  else if (ArrayBuffer.isView(body)) {
    text = new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  } else return body;
  try {
    return decodeTeamProtocolV2Json(JSON.parse(text));
  } catch {
    return body;
  }
}

// The `!response.ok` half of a raw fetch, split out so the authenticated fetch in the manager and
// `requestJson` above agree on what a failing host response means. A host that answers with a JSON
// error envelope produces a `RemoteRequestError` carrying its own message and code; a host that
// claims JSON and does not send it is a protocol failure, not a request failure.
export async function throwRemoteResponseError(response: Response, method: string, path: string): Promise<never> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch (error) {
    if (response.headers.get("content-type")?.toLowerCase().includes("json")) {
      throw new RemoteProtocolError(
        "protocol_error",
        "The host returned data that this app could not safely use.",
        null,
        { cause: error },
      );
    }
    throw new RemoteRequestError(response.status, `Remote server request failed (${response.status}).`);
  }
  try {
    const value = decodeTeamProtocolV1CurrentHttpResponse(method, path, response.status, body);
    if (!isDynamicRecord(value) || !isString(value.error)) throw new Error("Invalid error envelope.");
    throw new RemoteRequestError(response.status, value.error, isString(value.code) ? value.code : null);
  } catch (error) {
    if (error instanceof RemoteRequestError) throw error;
    throw new RemoteProtocolError(
      "protocol_error",
      "The host returned data that this app could not safely use.",
      null,
      {
        cause: error,
      },
    );
  }
}
