// @vitest-environment node
import { describe, expect, it } from "vitest";
import { classifyRemoteConnectionError, classifyTransportError } from "./remote-server-connection-status";
import { RemoteProtocolError, RemoteRequestError } from "./remote-server-errors";

describe("classifyRemoteConnectionError", () => {
  it("tells an out-of-date end from a wire this app cannot read", () => {
    expect(classifyRemoteConnectionError(new RemoteProtocolError("client_update_required", "Update OpenBot."))).toEqual(
      {
        issue: { code: "client_update_required", message: "Update OpenBot.", retryable: true },
        state: "incompatible",
        suspendReconnect: true,
        hostSupport: null,
      },
    );
    expect(classifyRemoteConnectionError(new RemoteProtocolError("protocol_error", "Bad frame.")).state).toBe("error");
  });

  it("keeps what the host said it supports, so the app can say which end to update", () => {
    const support = { appVersion: "9.9.9", protocol: { minimum: 4, maximum: 5 }, capabilities: ["remote-desktop"] };
    const outcome = classifyRemoteConnectionError(
      new RemoteProtocolError("client_update_required", "Update OpenBot.", support),
    );
    expect(outcome.hostSupport).toEqual(support);
  });

  it("answers a 401 in its own words rather than the host's", () => {
    const outcome = classifyRemoteConnectionError(new RemoteRequestError(401, "jwt malformed"));
    expect(outcome.issue).toEqual({
      code: "authentication_required",
      message: "Sign in to this host again.",
      retryable: true,
    });
    expect(outcome.suspendReconnect).toBe(true);
  });

  it("leaves an ordinary refusal to the caller instead of blaming the connection", () => {
    expect(classifyRemoteConnectionError(new RemoteRequestError(404, "No such agent."))).toEqual({
      issue: null,
      state: null,
      suspendReconnect: false,
      hostSupport: null,
    });
  });

  it("stops reconnecting for a body it cannot parse, but keeps trying when the host is unreachable", () => {
    const unparseable = classifyRemoteConnectionError(new SyntaxError("Unexpected token <"));
    expect(unparseable.issue?.code).toBe("protocol_error");
    expect(unparseable.suspendReconnect).toBe(true);

    const unreachable = classifyRemoteConnectionError(new TypeError("fetch failed"));
    expect(unreachable.issue?.code).toBe("network_unavailable");
    expect(unreachable.state).toBe("offline");
    expect(unreachable.suspendReconnect).toBe(false);
  });

  it("says nothing about a failure it does not recognise", () => {
    expect(classifyRemoteConnectionError(new Error("boom")).issue).toBeNull();
  });
});

describe("classifyTransportError", () => {
  it("reports a revoked session as needing a sign-in, and stops reconnecting", () => {
    expect(classifyTransportError("session_revoked", "Session revoked.")).toEqual({
      issue: { code: "authentication_required", message: "Session revoked.", retryable: false },
      state: "error",
      suspendReconnect: true,
      hostSupport: null,
    });
  });

  it("agrees with the HTTP path that a protocol error is incompatibility, not a retryable blip", () => {
    const outcome = classifyTransportError("protocol_error", "Unsupported frame.");
    expect(outcome.state).toBe("incompatible");
    expect(outcome.issue?.retryable).toBe(false);
    expect(outcome.suspendReconnect).toBe(true);
  });

  it("keeps retrying anything else", () => {
    expect(classifyTransportError("ice_failed", "The connection dropped.")).toEqual({
      issue: { code: "network_unavailable", message: "The connection dropped.", retryable: true },
      state: "error",
      suspendReconnect: false,
      hostSupport: null,
    });
  });
});
