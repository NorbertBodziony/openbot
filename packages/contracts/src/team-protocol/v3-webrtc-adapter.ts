import { isConversationUnreadRoute } from "./current";
import { decodeTeamProtocolV2Json, type TeamProtocolV2Json } from "./v2";
import {
  decodeTeamProtocolV2CurrentHttpRequest,
  decodeTeamProtocolV2CurrentHttpResponse,
  encodeTeamProtocolV2CurrentHttpRequest,
  encodeTeamProtocolV2CurrentHttpResponse,
} from "./v2-adapter";
import {
  decodeTeamProtocolV3CurrentHttpRequest,
  decodeTeamProtocolV3CurrentHttpResponse,
  encodeTeamProtocolV3CurrentHttpRequest,
  encodeTeamProtocolV3CurrentHttpResponse,
} from "./v3-adapter";

// The two directions call different halves of the v3 adapter. Both used to call the decoder, which was
// harmless while encoding and decoding produced the same words -- and stopped being harmless the moment
// the agent gained a current spelling distinct from its frozen wire one. What leaves this process is wire
// vocabulary; what a handler receives is current vocabulary.
export function encodeTeamProtocolV3WebRtcHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV2Json {
  return isTeamProtocolV3OnlyRoute(method, path)
    ? wireJson(JSON.parse(encodeTeamProtocolV3CurrentHttpRequest(method, path, value ?? {}, options)))
    : encodeTeamProtocolV2CurrentHttpRequest(method, path, value, options);
}

export function decodeTeamProtocolV3WebRtcHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV2Json {
  return isTeamProtocolV3OnlyRoute(method, path)
    ? wireJson(decodeTeamProtocolV3CurrentHttpRequest(method, path, value ?? {}))
    : decodeTeamProtocolV2CurrentHttpRequest(method, path, value, options);
}

export function encodeTeamProtocolV3WebRtcHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV2Json {
  return isTeamProtocolV3OnlyRoute(method, path)
    ? wireJson(JSON.parse(encodeTeamProtocolV3CurrentHttpResponse(method, path, status, value ?? null, options)))
    : encodeTeamProtocolV2CurrentHttpResponse(method, path, status, value, options);
}

export function decodeTeamProtocolV3WebRtcHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV2Json {
  return isTeamProtocolV3OnlyRoute(method, path)
    ? wireJson(decodeTeamProtocolV3CurrentHttpResponse(method, path, status, value ?? null))
    : decodeTeamProtocolV2CurrentHttpResponse(method, path, status, value);
}

// The host's local HTTP protocol selection must match the WebRTC codec selection.
export function isTeamProtocolV3OnlyRoute(method: string, path: string): boolean {
  if (isConversationUnreadRoute(method, path)) return true;
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  return (
    (method === "POST" && /^\/v1\/agents\/[^/]+\/duplicate$/u.test(pathname)) ||
    (method === "GET" && /^\/v1\/agents\/[^/]+\/usage$/u.test(pathname))
  );
}

function wireJson(value: unknown): TeamProtocolV2Json {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("The Team protocol value is not JSON serializable.");
  return decodeTeamProtocolV2Json(JSON.parse(encoded));
}
