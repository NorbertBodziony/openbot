// One Team API call, from picking a wire format to recording that it failed.
//
// **Two encodings, on purpose. Never merge them.** The HTTPS path frames V1 or V3 according to the
// protocol this app and the host negotiated; the WebRTC path frames V2 JSON and nothing else. Both
// are released wire protocols, so a shipped frame never changes meaning -- see
// `packages/contracts/AGENTS.md`. What looks like duplication between the two arms of every method
// here is two protocols that happen to carry the same payload today. Collapsing them is the one
// edit in this file that silently breaks a build already in users' hands. Deleting a *duplicated
// call site* is fine; merging the two encodings is not.
//
// Everything above the wire is shared and lives here once: compatibility negotiation and its
// in-flight deduplication, the protocol and capability headers, translating a transport failure
// into a `RemoteRequestError`, and reporting the failure to the connection registry. The registry
// decides what a failure means to the user; this file only decides what it means to the request.
//
// This file does not know the event stream exists. When a failure makes reconnecting pointless the
// registry says so and its owner acts on it -- that is what keeps a failed HTTP request from
// reaching in and closing a WebSocket.

import { randomBytes, verify } from "node:crypto";
import type { RemoteDesktopCapabilities, ServerCompatibility } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  supportsTeamSemanticTags,
  TEAM_CURRENT_CAPABILITIES,
  type TeamCurrentCapability,
} from "@openbot/contracts/team-protocol/current";
import {
  decodeTeamProtocolSupportV1,
  highestCommonTeamProtocol,
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
  type TeamProtocolSupportV1,
  teamProtocolUpdateDirection,
} from "@openbot/contracts/team-protocol/v1";
import { decodeRemoteDesktopCapabilities } from "./remote-device-decoding";
import type { ResponseDecoder } from "./remote-host-decoding";
import {
  assumedCompatibility,
  LOCAL_TEAM_PROTOCOL,
  negotiatedCompatibility,
  webRtcCompatibility,
} from "./remote-server-connection-status";
import { RemoteProtocolError, RemoteRequestError } from "./remote-server-errors";
import { remoteFetch, requestJson, throwRemoteResponseError, webRtcRequestBody } from "./remote-server-http";
import type { StoredRemoteServerView } from "./remote-server-store";
import { addRemotePreviewUrls } from "./remote-server-urls";
import { decodeIdentityProof } from "./remote-team-decoding";
import { fingerprint } from "./team-store";
import { TeamWebRtcRequestError } from "./team-webrtc-client-transport";

/**
 * The two transport methods a request needs. `TeamWebRtcClientTransport` also carries a live event
 * channel and a control-plane client; naming only these two is what keeps those out of this file.
 */
export interface RemoteHostRequestTransport {
  request: (
    hostId: string,
    path: string,
    init?: { method?: string; body?: unknown; preserveSemanticTags?: boolean },
  ) => Promise<unknown>;
  requestResponse: (
    hostId: string,
    path: string,
    init?: { method?: string; body?: unknown; contentType?: string; preserveSemanticTags?: boolean },
  ) => Promise<{
    status: number;
    body: unknown;
    file?: { bytes: Uint8Array; name: string; mimeType: string };
  }>;
}

/** What the client needs from the stored server list: a server, and the token to speak for it. */
export interface RemoteServerLookup {
  require: (serverId: string) => StoredRemoteServerView;
  token: (server: StoredRemoteServerView) => string;
}

/**
 * Where a request records what happened. The client reads the last known compatibility to avoid
 * renegotiating, and reads the last issue because a protocol failure must not be retried on every
 * call -- see `ensureCompatibility`.
 */
export interface RemoteConnectionSink {
  compatibilityFor: (serverId: string) => ServerCompatibility | null;
  issueFor: (serverId: string) => { code: string; message: string } | null;
  setCompatibility: (serverId: string, compatibility: ServerCompatibility) => void;
  clearIssue: (serverId: string) => void;
  reportError: (serverId: string, error: unknown) => void;
}

export interface RemoteServerClientOptions {
  appVersion: string | null;
  servers: RemoteServerLookup;
  connections: RemoteConnectionSink;
  transport: RemoteHostRequestTransport | null;
}

export interface RemoteRequestInit {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

/** `RemoteServerClient.request` as a plain function, for callers that need nothing else from it. */
export type RemoteRequestFn = <T>(
  serverId: string,
  path: string,
  decoder: ResponseDecoder<T>,
  init?: RemoteRequestInit,
) => Promise<T>;

export class RemoteServerClient {
  readonly #appVersion: string | null;
  readonly #servers: RemoteServerLookup;
  readonly #connections: RemoteConnectionSink;
  readonly #transport: RemoteHostRequestTransport | null;
  // In-flight negotiations, so a burst of calls to a cold server produces one compatibility request
  // rather than one per call. Private to the client: the UI never sees this, unlike the status the
  // negotiation produces.
  readonly #compatibilityRequests = new Map<string, Promise<ServerCompatibility>>();

  constructor(options: RemoteServerClientOptions) {
    this.#appVersion = options.appVersion;
    this.#servers = options.servers;
    this.#connections = options.connections;
    this.#transport = options.transport;
  }

  /** One decoded Team API call. Every failure is reported to the registry before it is rethrown. */
  async request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init: RemoteRequestInit = {},
  ): Promise<T> {
    const server = this.#servers.require(serverId);
    try {
      if (server.transport === "webrtc-v2") {
        const transport = this.#requireTransport();
        try {
          const compatibility = await this.ensureCompatibility(server);
          const value = await transport.request(server.id, path, {
            ...init,
            preserveSemanticTags: supportsTeamSemanticTags(compatibility.capabilities),
          });
          return addRemotePreviewUrls(decoder(value), server.id);
        } catch (error) {
          rethrowAsRemoteRequestError(error);
        }
      }
      const compatibility = await this.ensureCompatibility(server);
      const value = await requestJson(server.apiUrl, path, decoder, {
        ...init,
        token: this.#servers.token(server),
        timeoutMs: init.timeoutMs,
        ...this.requestProtocol(compatibility),
      });
      return addRemotePreviewUrls(value, server.id);
    } catch (error) {
      this.#connections.reportError(server.id, error);
      throw error;
    }
  }

  /**
   * The undecoded form, for bytes: attachments, avatars, logos and the remote viewer. The WebRTC arm
   * rebuilds an HTTP `Response` from a V2 frame so both arms hand back the same thing.
   *
   * `affectsConnection` is false for the remote viewer, whose requests are triggered by page loads
   * rather than by the user and so must not mark a healthy server offline.
   */
  async fetch(
    server: StoredRemoteServerView,
    input: string | URL,
    init: RequestInit = {},
    affectsConnection = true,
  ): Promise<Response> {
    try {
      if (server.transport === "webrtc-v2") {
        const transport = this.#requireTransport();
        const url = new URL(input);
        try {
          const compatibility = await this.ensureCompatibility(server);
          const contentType = new Headers(init.headers).get("Content-Type") ?? undefined;
          const response = await transport.requestResponse(server.id, `${url.pathname}${url.search}`, {
            method: init.method,
            body: webRtcRequestBody(init.body, contentType),
            contentType,
            preserveSemanticTags: supportsTeamSemanticTags(compatibility.capabilities),
          });
          const headers = new Headers();
          if (response.file) {
            headers.set("Content-Type", response.file.mimeType);
            headers.set(
              "Content-Disposition",
              `attachment; filename*=UTF-8''${encodeURIComponent(response.file.name)}`,
            );
            return new Response(Buffer.from(response.file.bytes), { status: response.status, headers });
          }
          headers.set("Content-Type", "application/json");
          return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
            status: response.status,
            headers,
          });
        } catch (error) {
          rethrowAsRemoteRequestError(error);
        }
      }
      const compatibility = await this.ensureCompatibility(server);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.#servers.token(server)}`);
      headers.set(TEAM_PROTOCOL_VERSION_HEADER, String(compatibility.negotiatedProtocol));
      if (this.#appVersion) {
        headers.set(TEAM_APP_VERSION_HEADER, this.#appVersion);
        headers.set(TEAM_CAPABILITIES_HEADER, TEAM_CURRENT_CAPABILITIES.join(","));
      }
      const response = await remoteFetch(input, { ...init, headers });
      if (!response.ok) {
        await throwRemoteResponseError(response, init.method ?? "GET", new URL(input).pathname);
      }
      return response;
    } catch (error) {
      if (affectsConnection) this.#connections.reportError(server.id, error);
      throw error;
    }
  }

  /** The negotiated protocol and this app's capabilities, as `requestJson` wants them. */
  requestProtocol(compatibility: ServerCompatibility): {
    protocol?: number;
    appVersion?: string;
    capabilities?: readonly TeamCurrentCapability[];
    preserveSemanticTags?: boolean;
  } {
    return {
      protocol: compatibility.negotiatedProtocol ?? undefined,
      appVersion: this.#appVersion ?? undefined,
      capabilities: this.#appVersion ? TEAM_CURRENT_CAPABILITIES : undefined,
      preserveSemanticTags: supportsTeamSemanticTags(compatibility.capabilities),
    };
  }

  /**
   * The negotiated compatibility for a server, negotiating it if this is the first call.
   *
   * A recorded protocol issue is rethrown without touching the network: the two ends have already
   * agreed they cannot talk, and re-asking on every call would turn one incompatibility into a
   * request storm. `refresh` is how an explicit reconnect gets past that.
   */
  async ensureCompatibility(server: StoredRemoteServerView, refresh = false): Promise<ServerCompatibility> {
    const current = this.#connections.compatibilityFor(server.id);
    const issue = this.#connections.issueFor(server.id);
    if (
      !refresh &&
      (issue?.code === "client_update_required" ||
        issue?.code === "host_update_required" ||
        issue?.code === "protocol_error")
    ) {
      throw new RemoteProtocolError(
        issue.code,
        issue.message,
        current?.hostAppVersion && current.hostProtocol
          ? {
              appVersion: current.hostAppVersion,
              protocol: current.hostProtocol,
              capabilities: current.capabilities,
            }
          : null,
      );
    }
    if (!this.#appVersion) {
      const compatibility = assumedCompatibility(this.#appVersion);
      this.#connections.setCompatibility(server.id, compatibility);
      return compatibility;
    }
    if (!refresh && current?.negotiatedProtocol) return current;
    const pending = this.#compatibilityRequests.get(server.id);
    if (pending) return pending;
    const request = (
      server.transport === "webrtc-v2"
        ? this.#negotiateWebRtcCompatibility(server.id)
        : this.negotiateCompatibility(server.apiUrl)
    )
      .then((compatibility) => {
        this.#connections.setCompatibility(server.id, compatibility);
        this.#connections.clearIssue(server.id);
        return compatibility;
      })
      .finally(() => {
        if (this.#compatibilityRequests.get(server.id) === request) this.#compatibilityRequests.delete(server.id);
      });
    this.#compatibilityRequests.set(server.id, request);
    return request;
  }

  /**
   * Re-reads what a WebRTC host supports and records it. Unlike the pinned V2 framing the WebRTC arm
   * always uses, this reports the host's real protocol range, so the user is told to update the end
   * that is actually behind.
   */
  async refreshWebRtcCompatibility(serverId: string): Promise<void> {
    if (!this.#transport) return;
    const host = decodeTeamProtocolSupportV1(await this.#transport.request(serverId, TEAM_API_ROUTES.compatibility));
    this.#connections.setCompatibility(
      serverId,
      negotiatedCompatibility(this.#appVersion, host, highestCommonTeamProtocol(LOCAL_TEAM_PROTOCOL, host.protocol)),
    );
  }

  /**
   * Negotiation against a bare URL, for a server not stored yet -- joining, or verifying an
   * identity. Nothing here is recorded, because there is no connection to record it against.
   */
  async negotiateCompatibility(apiUrl: string): Promise<ServerCompatibility> {
    if (!this.#appVersion) return assumedCompatibility(this.#appVersion);
    let host: TeamProtocolSupportV1;
    try {
      host = await requestJson(apiUrl, TEAM_API_ROUTES.compatibility, decodeTeamProtocolSupportV1);
    } catch (error) {
      if (error instanceof RemoteRequestError && error.status === 404) {
        throw new RemoteProtocolError("host_update_required", "Update OpenBot on the host before connecting.");
      }
      if (error instanceof SyntaxError || (error instanceof RemoteProtocolError && error.code === "protocol_error")) {
        throw new RemoteProtocolError("protocol_error", "The host returned invalid compatibility information.");
      }
      throw error;
    }
    const negotiatedProtocol = highestCommonTeamProtocol(LOCAL_TEAM_PROTOCOL, host.protocol);
    if (negotiatedProtocol === null) {
      if (teamProtocolUpdateDirection(LOCAL_TEAM_PROTOCOL, host.protocol) === "client_update_required") {
        throw new RemoteProtocolError(
          "client_update_required",
          "Update this OpenBot app before connecting to the host.",
          host,
        );
      }
      throw new RemoteProtocolError("host_update_required", "Update OpenBot on the host before connecting.", host);
    }
    return negotiatedCompatibility(this.#appVersion, host, negotiatedProtocol);
  }

  /**
   * Proves the host at `apiUrl` holds the key behind `expectedFingerprint`, by making it sign a
   * challenge this app just generated. This is what an invite link's fingerprint is for, and it runs
   * before any token is ever sent -- so a host that fails it never learns anything.
   */
  async verifyIdentity(
    apiUrl: string,
    serverId: string,
    expectedFingerprint: string,
  ): Promise<{
    publicKey: string;
    serverName: string;
    logoVersion: string | null;
    compatibility: ServerCompatibility;
  }> {
    const compatibility = await this.negotiateCompatibility(apiUrl);
    const challenge = randomBytes(24).toString("base64url");
    const proof = await requestJson(
      apiUrl,
      `${TEAM_API_ROUTES.identity}?challenge=${encodeURIComponent(challenge)}`,
      decodeIdentityProof,
      { ...this.requestProtocol(compatibility) },
    );
    const valid =
      proof.serverId === serverId &&
      proof.challenge === challenge &&
      proof.fingerprint === expectedFingerprint &&
      fingerprint(proof.publicKey) === expectedFingerprint &&
      verify(null, Buffer.from(challenge), proof.publicKey, Buffer.from(proof.signature, "base64url"));
    if (!valid) throw new Error("The server identity could not be verified.");
    return {
      publicKey: proof.publicKey,
      serverName: proof.serverName,
      logoVersion: proof.logoVersion,
      compatibility,
    };
  }

  /**
   * Whether this server can share a screen right now. A host that has never heard of the route
   * answers 404, 426 or 503; those mean "no", not "the connection is broken".
   */
  async probeRemoteDesktop(server: StoredRemoteServerView): Promise<boolean> {
    try {
      const compatibility = await this.ensureCompatibility(server);
      if (!compatibility.capabilities.includes("remote-desktop")) return false;
      let capabilities: RemoteDesktopCapabilities;
      if (server.transport === "webrtc-v2") {
        capabilities = decodeRemoteDesktopCapabilities(
          await this.#requireTransport().request(server.id, TEAM_API_ROUTES.remoteScreen.capabilities, {
            preserveSemanticTags: supportsTeamSemanticTags(compatibility.capabilities),
          }),
        );
      } else {
        capabilities = await requestJson(
          server.apiUrl,
          TEAM_API_ROUTES.remoteScreen.capabilities,
          decodeRemoteDesktopCapabilities,
          { token: this.#servers.token(server), ...this.requestProtocol(compatibility) },
        );
      }
      return capabilities.ready;
    } catch (error) {
      if (error instanceof RemoteRequestError && [404, 426, 503].includes(error.status)) return false;
      throw error;
    }
  }

  /** Forgets an in-flight negotiation. Called when a server is removed or the app stops. */
  forget(serverId: string): void {
    this.#compatibilityRequests.delete(serverId);
  }

  clear(): void {
    this.#compatibilityRequests.clear();
  }

  async #negotiateWebRtcCompatibility(serverId: string): Promise<ServerCompatibility> {
    const value = await this.#requireTransport().request(serverId, TEAM_API_ROUTES.compatibility);
    return webRtcCompatibility(this.#appVersion, decodeTeamProtocolSupportV1(value));
  }

  #requireTransport(): RemoteHostRequestTransport {
    if (!this.#transport) throw new Error("The WebRTC transport is unavailable.");
    return this.#transport;
  }
}

/** A transport failure carries a status and a code; everything else is rethrown untouched. */
function rethrowAsRemoteRequestError(error: unknown): never {
  if (error instanceof TeamWebRtcRequestError) throw new RemoteRequestError(error.status, error.message, error.code);
  throw error;
}
