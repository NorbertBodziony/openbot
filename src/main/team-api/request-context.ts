import type { IncomingMessage, ServerResponse } from "node:http";
import type { TeamMemberSummary } from "@openbot/contracts/ipc";

// What a route module says when it is asked about a request.
//
// `"unmatched"` means the module recognised nothing and wrote nothing, so the router may keep
// asking. `"handled"` means the response is already on the wire and the router must stop - anything
// it does afterwards is an `ERR_HTTP_HEADERS_SENT` in its own error path. The repository does not
// enable `noImplicitReturns`, so a module that falls out of its own end returns `undefined`, which
// reads as `"unmatched"` and turns a route that should have answered into a silent 404. The rule
// that closes that gap is a written one: the last statement of every route module is
// `return "unmatched"`.
export type RouteOutcome = "handled" | "unmatched";

// One authenticated request, as a route module sees it.
//
// The raw `request` and the whole parsed `url` are both here on purpose. Routes read headers off
// the request that no parsed field could carry - the forwarding headers behind `publicHttpBaseUrl`,
// the content type of an avatar upload, the socket address the rate limiter keys on - and about
// fifteen of them read `url.searchParams`. `protocol` and `capabilities` are computed once here so
// that a route which needs them cannot disagree with the values `json` will encode against.
//
// `json` and `empty` are bound closures rather than methods, so a module can destructure them, and
// they return `RouteOutcome` so that every `return json(...)` is also the statement that stops the
// router.
export interface TeamApiRequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly method: string;
  readonly url: URL;
  readonly protocol: number;
  readonly capabilities: Set<string>;
  readonly member: TeamMemberSummary;
  readonly token: string;
  readonly sessionId: string;
  readonly sessionExpiresAt: string;
  readonly json: (status: number, value: object | null) => RouteOutcome;
  readonly empty: (status: number) => RouteOutcome;
}

// The agent one request is about, parsed once by `route-agents.ts` and passed down.
//
// `botId` is decoded above the action switch, exactly where the original chain decoded it, so a
// malformed identifier answers 400 rather than falling through to the router's 404. Every
// agent-scoped module must read the identifier from here rather than re-deriving it, because a
// second `pathIdentifier` call placed below a method check would move that 400 to a 404 for one
// method and leave it alone for the rest.
export interface AgentRouteTarget {
  readonly botId: string;
  readonly action: string;
}
