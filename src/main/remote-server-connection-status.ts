// What a failure means to the user, and what this build claims to support. Pure functions only --
// nothing here reads or writes connection state, so the whole table can be checked with a value in
// and a value out.
//
// This is the only translation from `RemoteRequestError` / `RemoteProtocolError` / a transport error
// code into a `ServerConnectionIssue`. It used to be two `instanceof` ladders in the manager, one for
// HTTP failures and one for WebRTC transport codes, that had drifted apart -- the same condition
// could show the user two different messages depending on which transport a server happened to use.
// They are siblings in this file now so that stays visible. Adding a third caller means adding a
// classifier here, not another ladder somewhere else.

import type { ServerCompatibility, ServerConnectionIssue, ServerSummary } from "@openbot/contracts/ipc";
import { TEAM_PROTOCOL_V1, type TeamProtocolSupportV1 } from "@openbot/contracts/team-protocol/v1";
import { TEAM_PROTOCOL_V3, TEAM_PROTOCOL_V3_CAPABILITIES } from "@openbot/contracts/team-protocol/v3";
import { RemoteProtocolError, RemoteRequestError } from "./remote-server-errors";

// The protocol range this build speaks. Every compatibility record reports it as the local half.
export const LOCAL_TEAM_PROTOCOL = { minimum: TEAM_PROTOCOL_V1, maximum: TEAM_PROTOCOL_V3 } as const;

// Everything the app tracks about one server's connection, and the whole of what `list()` reports
// beyond the server's stored fields.
export interface RemoteServerConnectionStatus {
  state: ServerSummary["state"];
  compatibility: ServerCompatibility | null;
  issue: ServerConnectionIssue | null;
  // Bumped on every fresh connection. The renderer uses it to tell a reconnect from a still-open
  // connection, so it has to change even when nothing else about the status does.
  connectionSequence: number;
}

export interface RemoteConnectionOutcome {
  issue: ServerConnectionIssue | null;
  // Null means "leave the state alone" -- an error the caller has no better word for than whatever
  // the server was already showing.
  state: ServerSummary["state"] | null;
  // True for failures no retry fixes: the event stream stops reconnecting until the user acts.
  suspendReconnect: boolean;
  // What the host said it supports, when the failure was the two ends disagreeing about the wire.
  hostSupport: TeamProtocolSupportV1 | null;
}

const NO_OUTCOME: RemoteConnectionOutcome = { issue: null, state: null, suspendReconnect: false, hostSupport: null };

// `fetch` rejects with a `TypeError` when it never reached the host, and a WebSocket that fails to
// open says nothing useful at all. Both mean the same thing to the user, so they report it the same
// way. A function rather than a constant: the issue ends up inside a status record, and one shared
// object there would be one mutation away from being every server's issue.
export function hostUnreachable(): RemoteConnectionOutcome {
  return {
    issue: { code: "network_unavailable", message: "The host is not reachable.", retryable: true },
    state: "offline",
    suspendReconnect: false,
    hostSupport: null,
  };
}

export function classifyRemoteConnectionError(error: unknown): RemoteConnectionOutcome {
  if (error instanceof RemoteProtocolError) {
    return {
      issue: { code: error.code, message: error.message, retryable: true },
      // A protocol error is this app and the host disagreeing about the bytes, which is not the same
      // as either being out of date -- only the two update codes say "incompatible".
      state: error.code === "protocol_error" ? "error" : "incompatible",
      suspendReconnect: true,
      hostSupport: error.support,
    };
  }
  if (error instanceof RemoteRequestError) {
    if (error.code === "client_update_required" || error.code === "host_update_required") {
      return {
        issue: { code: error.code, message: error.message, retryable: true },
        state: "incompatible",
        suspendReconnect: true,
        hostSupport: null,
      };
    }
    if (error.code === "protocol_error") {
      return {
        issue: { code: "protocol_error", message: error.message, retryable: true },
        state: "error",
        suspendReconnect: true,
        hostSupport: null,
      };
    }
    if (error.status === 401) {
      // Deliberately not the host's own message: a 401 body is written for a developer, and the one
      // thing the user can do about it is sign in again.
      return {
        issue: { code: "authentication_required", message: "Sign in to this host again.", retryable: true },
        state: "error",
        suspendReconnect: true,
        hostSupport: null,
      };
    }
    // Any other refusal is the host answering normally. It is the caller's to report, not a
    // connection problem.
    return NO_OUTCOME;
  }
  if (error instanceof SyntaxError) {
    return {
      issue: { code: "protocol_error", message: "The host returned invalid data.", retryable: true },
      state: "error",
      suspendReconnect: true,
      hostSupport: null,
    };
  }
  if (error instanceof TypeError) return hostUnreachable();
  return NO_OUTCOME;
}

// The WebRTC transport reports failures as a code and a message rather than an error object, so it
// gets its own entry point into the same table.
export function classifyTransportError(code: string, message: string): RemoteConnectionOutcome {
  const authenticationEnded = code === "session_revoked";
  const suspendReconnect = code === "protocol_error" || authenticationEnded;
  return {
    issue: {
      code:
        code === "protocol_error"
          ? "protocol_error"
          : authenticationEnded
            ? "authentication_required"
            : "network_unavailable",
      message,
      retryable: !suspendReconnect,
    },
    state: code === "protocol_error" ? "incompatible" : "error",
    suspendReconnect,
    hostSupport: null,
  };
}

// What the app reports before it has heard from the host. Every other compatibility record is this
// one with the host's half filled in, so they cannot drift apart.
export function checkingCompatibility(localAppVersion: string | null): ServerCompatibility {
  return {
    localAppVersion: localAppVersion ?? "0.0.0",
    hostAppVersion: null,
    localProtocol: LOCAL_TEAM_PROTOCOL,
    hostProtocol: null,
    negotiatedProtocol: null,
    capabilities: [],
  };
}

// A build with no version of its own is a development build. It cannot negotiate honestly, so it
// assumes the host matches rather than blocking the developer on a check that means nothing here.
export function assumedCompatibility(localAppVersion: string | null): ServerCompatibility {
  return {
    ...checkingCompatibility(localAppVersion),
    hostAppVersion: "0.0.0",
    hostProtocol: LOCAL_TEAM_PROTOCOL,
    negotiatedProtocol: TEAM_PROTOCOL_V1,
    capabilities: [...TEAM_PROTOCOL_V3_CAPABILITIES],
  };
}

// A host that answered the compatibility route: its version and range as reported, and the highest
// protocol both ends speak. The caller has already established that the ranges overlap.
export function negotiatedCompatibility(
  localAppVersion: string | null,
  host: TeamProtocolSupportV1,
  negotiatedProtocol: number | null,
): ServerCompatibility {
  return {
    localAppVersion: localAppVersion ?? "0.0.0",
    hostAppVersion: host.appVersion,
    localProtocol: LOCAL_TEAM_PROTOCOL,
    hostProtocol: host.protocol,
    negotiatedProtocol,
    capabilities: host.capabilities,
  };
}

// The WebRTC transport carries V2 framing and nothing else, so there is nothing to negotiate: the
// protocol is pinned rather than derived from the host's range.
export function webRtcCompatibility(localAppVersion: string | null, host: TeamProtocolSupportV1): ServerCompatibility {
  return {
    localAppVersion: localAppVersion ?? "0.0.0",
    hostAppVersion: host.appVersion,
    localProtocol: LOCAL_TEAM_PROTOCOL,
    hostProtocol: { minimum: 2, maximum: 2 },
    negotiatedProtocol: 2,
    capabilities: host.capabilities,
  };
}
