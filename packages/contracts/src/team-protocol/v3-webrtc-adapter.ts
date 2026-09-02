import { decodeTeamProtocolV2Json, type TeamProtocolV2Json } from "./v2";
import {
  decodeTeamProtocolV2CurrentHttpRequest,
  decodeTeamProtocolV2CurrentHttpResponse,
  encodeTeamProtocolV2CurrentHttpRequest,
  encodeTeamProtocolV2CurrentHttpResponse,
} from "./v2-adapter";
import { decodeTeamProtocolV3CurrentHttpRequest, decodeTeamProtocolV3CurrentHttpResponse } from "./v3-adapter";

export function encodeTeamProtocolV3WebRtcHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV2Json {
  return duplicateRoute(method, path)
    ? wireJson(decodeTeamProtocolV3CurrentHttpRequest(method, path, value ?? {}))
    : encodeTeamProtocolV2CurrentHttpRequest(method, path, value, options);
}

export function decodeTeamProtocolV3WebRtcHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV2Json {
  return duplicateRoute(method, path)
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
  return duplicateRoute(method, path)
    ? wireJson(decodeTeamProtocolV3CurrentHttpResponse(method, path, status, value ?? null))
    : encodeTeamProtocolV2CurrentHttpResponse(method, path, status, value, options);
}

export function decodeTeamProtocolV3WebRtcHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV2Json {
  return duplicateRoute(method, path)
    ? wireJson(decodeTeamProtocolV3CurrentHttpResponse(method, path, status, value ?? null))
    : decodeTeamProtocolV2CurrentHttpResponse(method, path, status, value);
}

function duplicateRoute(method: string, path: string): boolean {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  return method === "POST" && /^\/v1\/agents\/[^/]+\/duplicate$/u.test(pathname);
}

function wireJson(value: unknown): TeamProtocolV2Json {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("The Team protocol value is not JSON serializable.");
  return decodeTeamProtocolV2Json(JSON.parse(encoded));
}
