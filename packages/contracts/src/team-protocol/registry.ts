import {
  decodeTeamProtocolV1ClientEvent,
  decodeTeamProtocolV1HttpRequest,
  decodeTeamProtocolV1HttpResponse,
  encodeTeamProtocolV1ClientEvent,
  TEAM_PROTOCOL_V1,
  TEAM_PROTOCOL_V1_CAPABILITIES,
  TEAM_PROTOCOL_V1_WEBSOCKET,
} from "./v1";
import {
  decodeTeamProtocolV1CurrentEvent,
  encodeTeamProtocolV1CurrentEvent,
  encodeTeamProtocolV1CurrentHttpRequest,
  encodeTeamProtocolV1CurrentHttpResponse,
} from "./v1-adapter";
import {
  decodeTeamProtocolV2HttpRequest,
  decodeTeamProtocolV2HttpResponse,
  TEAM_PROTOCOL_V2,
  TEAM_PROTOCOL_V2_CAPABILITIES,
  TEAM_PROTOCOL_V2_WEBSOCKET,
} from "./v2";
import {
  decodeTeamProtocolV2CurrentEvent,
  encodeTeamProtocolV2CurrentEvent,
  encodeTeamProtocolV2CurrentHttpRequest,
  encodeTeamProtocolV2CurrentHttpResponse,
} from "./v2-adapter";

export const TEAM_PROTOCOL_MINIMUM = TEAM_PROTOCOL_V1;
export const TEAM_PROTOCOL_MAXIMUM = TEAM_PROTOCOL_V2;
export const TEAM_PROTOCOL_CAPABILITIES = TEAM_PROTOCOL_V2_CAPABILITIES;

const adapters = {
  [TEAM_PROTOCOL_V1]: {
    version: TEAM_PROTOCOL_V1,
    websocketProtocol: TEAM_PROTOCOL_V1_WEBSOCKET,
    capabilities: TEAM_PROTOCOL_V1_CAPABILITIES,
    decodeClientEvent: decodeTeamProtocolV1ClientEvent,
    encodeClientEvent: encodeTeamProtocolV1ClientEvent,
    decodeCurrentEvent: decodeTeamProtocolV1CurrentEvent,
    encodeCurrentEvent: encodeTeamProtocolV1CurrentEvent,
    decodeHttpRequest: decodeTeamProtocolV1HttpRequest,
    encodeHttpRequest: encodeTeamProtocolV1CurrentHttpRequest,
    decodeHttpResponse: decodeTeamProtocolV1HttpResponse,
    encodeHttpResponse: encodeTeamProtocolV1CurrentHttpResponse,
  },
  [TEAM_PROTOCOL_V2]: {
    version: TEAM_PROTOCOL_V2,
    websocketProtocol: TEAM_PROTOCOL_V2_WEBSOCKET,
    capabilities: TEAM_PROTOCOL_V2_CAPABILITIES,
    decodeClientEvent: decodeTeamProtocolV1ClientEvent,
    encodeClientEvent: encodeTeamProtocolV1ClientEvent,
    decodeCurrentEvent: decodeTeamProtocolV2CurrentEvent,
    encodeCurrentEvent: encodeTeamProtocolV2CurrentEvent,
    decodeHttpRequest: decodeTeamProtocolV2HttpRequest,
    encodeHttpRequest: encodeTeamProtocolV2CurrentHttpRequest,
    decodeHttpResponse: decodeTeamProtocolV2HttpResponse,
    encodeHttpResponse: encodeTeamProtocolV2CurrentHttpResponse,
  },
} as const;

export type TeamProtocolAdapter = (typeof adapters)[keyof typeof adapters];

export function teamProtocolAdapter(version: number): TeamProtocolAdapter | null {
  return version === TEAM_PROTOCOL_V1 || version === TEAM_PROTOCOL_V2 ? adapters[version] : null;
}

export function teamProtocolAdapterForWebSocket(protocol: string): TeamProtocolAdapter | null {
  return Object.values(adapters).find((adapter) => adapter.websocketProtocol === protocol) ?? null;
}

export function teamProtocolWebSocketProtocols(): string[] {
  return Object.values(adapters)
    .sort((left, right) => right.version - left.version)
    .map((adapter) => adapter.websocketProtocol);
}
