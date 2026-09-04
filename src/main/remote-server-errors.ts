// The two failure kinds a Team API call produces, and the difference between them.
//
// `RemoteRequestError` is the host answering: it understood the request and refused it, so `status`
// and `code` are the host's own words and the connection is still good. `RemoteProtocolError` is the
// host and this app disagreeing about the wire itself -- an unreadable body, or a protocol range with
// no overlap -- which no retry fixes and which pauses the event stream.
//
// `remote-server-connection-status.ts` is the only place that turns either into something a user
// sees. Both are classified by `instanceof`, so this file must stay their single definition: a second
// copy of a class makes every `instanceof` silently false.

import type { TeamProtocolSupportV1 } from "@openbot/contracts/team-protocol/v1";

export class RemoteRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "RemoteRequestError";
    this.status = status;
    this.code = code;
  }
}

export class RemoteProtocolError extends Error {
  constructor(
    readonly code: "client_update_required" | "host_update_required" | "protocol_error",
    message: string,
    readonly support: TeamProtocolSupportV1 | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RemoteProtocolError";
  }
}
