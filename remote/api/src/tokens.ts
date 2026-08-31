import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from "jose";
import { z } from "zod";
import type { RemoteApiConfig } from "./config";
import type { IceServer, RemoteTicketClaims } from "./protocol";

const TICKET_AUDIENCE = "openbot-remote";
const RESUME_AUDIENCE = "openbot-remote-resume";
const RESUME_TTL_SECONDS = 24 * 60 * 60;
const HOST_RESUME_TTL_SECONDS = 30 * 24 * 60 * 60;
const TURN_TTL_SECONDS = 60 * 60;
const jwksSchema = z.object({ keys: z.array(z.object({ kty: z.string() }).loose()).min(1) });
const remoteTicketClaimsSchema = z.object({
  aud: z.literal(TICKET_AUDIENCE),
  jti: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  hostId: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  membershipId: z.string().min(1).max(256),
  role: z.enum(["host", "owner", "admin", "member"]),
  authEpoch: z.number().int().nonnegative(),
  protocolMinimum: z.number().int().nonnegative(),
  protocolMaximum: z.number().int().nonnegative(),
  sessionExpiresAt: z.number().int().nonnegative(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});

export class RemoteTokenService {
  readonly #ticketKey: JWTVerifyGetKey;
  readonly #sessionSecret: Uint8Array;
  readonly #turnSecret: string;
  readonly #turnHost: string;
  readonly #turnPort: number;
  readonly #turnTlsPort: number;

  constructor(
    config: Pick<
      RemoteApiConfig,
      "ticketJwks" | "ticketJwksUrl" | "sessionSecret" | "turnSecret" | "turnHost" | "turnPort" | "turnTlsPort"
    >,
  ) {
    this.#ticketKey = config.ticketJwks
      ? createLocalJWKSet(parseJwks(config.ticketJwks))
      : createRemoteJWKSet(new URL(config.ticketJwksUrl ?? invalidJwksConfiguration()));
    this.#sessionSecret = new TextEncoder().encode(config.sessionSecret);
    this.#turnSecret = config.turnSecret;
    this.#turnHost = config.turnHost;
    this.#turnPort = config.turnPort;
    this.#turnTlsPort = config.turnTlsPort;
  }

  async verifyTicket(token: string, now = new Date()): Promise<RemoteTicketClaims> {
    const { payload } = await jwtVerify(token, this.#ticketKey, {
      audience: TICKET_AUDIENCE,
      algorithms: ["ES256"],
      currentDate: now,
    });
    return decodeTicketClaims(payload, now);
  }

  async verifyResumeToken(token: string, now = new Date()): Promise<RemoteTicketClaims> {
    const { payload } = await jwtVerify(token, this.#sessionSecret, {
      audience: RESUME_AUDIENCE,
      algorithms: ["HS256"],
      currentDate: now,
    });
    return decodeTicketClaims({ ...payload, aud: TICKET_AUDIENCE }, now);
  }

  async issueResumeToken(claims: RemoteTicketClaims, nowSeconds = Math.floor(Date.now() / 1_000)): Promise<string> {
    return new SignJWT({
      sessionId: claims.sessionId,
      hostId: claims.hostId,
      userId: claims.userId,
      membershipId: claims.membershipId,
      role: claims.role,
      authEpoch: claims.authEpoch,
      protocolMinimum: claims.protocolMinimum,
      protocolMaximum: claims.protocolMaximum,
      sessionExpiresAt: claims.sessionExpiresAt,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setJti(crypto.randomUUID())
      .setIssuedAt(nowSeconds)
      .setAudience(RESUME_AUDIENCE)
      .setExpirationTime(
        Math.min(
          claims.sessionExpiresAt,
          nowSeconds + (claims.role === "host" ? HOST_RESUME_TTL_SECONDS : RESUME_TTL_SECONDS),
        ),
      )
      .sign(this.#sessionSecret);
  }

  iceServers(claims: RemoteTicketClaims, nowSeconds = Math.floor(Date.now() / 1_000)): IceServer[] {
    const expiration = Math.min(claims.sessionExpiresAt, nowSeconds + TURN_TTL_SECONDS);
    const username = `${expiration}:${claims.sessionId}`;
    const credential = createHmac("sha1", this.#turnSecret).update(username).digest("base64");
    return [
      { urls: `stun:${this.#turnHost}:${this.#turnPort}` },
      {
        urls: [
          `turn:${this.#turnHost}:${this.#turnPort}?transport=udp`,
          `turn:${this.#turnHost}:${this.#turnPort}?transport=tcp`,
          `turns:${this.#turnHost}:${this.#turnTlsPort}?transport=tcp`,
        ],
        username,
        credential,
      },
    ];
  }
}

export function verifyWebhookSignature(
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
): boolean {
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(now - timestampSeconds * 1_000) > 5 * 60_000) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("base64url");
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function parseJwks(value: string): JSONWebKeySet {
  return jwksSchema.parse(JSON.parse(value));
}

function decodeTicketClaims(value: unknown, now: Date): RemoteTicketClaims {
  const claims = remoteTicketClaimsSchema.parse(value);
  if (claims.protocolMinimum > claims.protocolMaximum) throw new Error("Invalid protocol range.");
  if (claims.protocolMinimum > 2 || claims.protocolMaximum < 2) throw new Error("Unsupported protocol range.");
  if (claims.sessionExpiresAt <= Math.floor(now.getTime() / 1_000)) throw new Error("The remote session expired.");
  return claims;
}

function invalidJwksConfiguration(): never {
  throw new Error("Missing ticket JWKS configuration.");
}
