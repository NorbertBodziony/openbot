export const SIGNAL_PROTOCOL_VERSION = 1 as const;
export const SIGNAL_MESSAGE_BYTES_LIMIT = 64 * 1024;

export type RemoteRole = "host" | "owner" | "admin" | "member";
export type SignalChannel = "team" | "remote-desktop";

export interface RemoteTicketClaims {
  aud: "openbot-remote";
  jti: string;
  sessionId: string;
  hostId: string;
  userId: string;
  membershipId: string;
  role: RemoteRole;
  authEpoch: number;
  protocolMinimum: number;
  protocolMaximum: number;
  sessionExpiresAt: number;
  clientPublicKey?: string;
  iat: number;
  exp: number;
}

export type SignalClientMessage =
  | { type: "hello"; version: 1; peer: "host" | "client"; token: string; multiplex?: boolean }
  | { type: "offer" | "answer"; version: 1; connectionId: string; channel: SignalChannel; sdp: string }
  | {
      type: "ice-candidate";
      version: 1;
      connectionId: string;
      channel: SignalChannel;
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    }
  | { type: "ice-restart"; version: 1; connectionId: string; channel: SignalChannel }
  | { type: "turn-refresh"; version: 1; connectionId: string | null }
  | { type: "disconnect"; version: 1; connectionId: string };

export type SignalServerMessage =
  | {
      type: "ready";
      version: 1;
      connectionId: string | null;
      resumeToken: string;
      iceServers: IceServer[];
    }
  | {
      type: "peer-ready";
      version: 1;
      connectionId: string;
      sessionId: string;
      userId: string;
      membershipId: string;
      role: Exclude<RemoteRole, "host">;
      sessionExpiresAt: number;
      resumed: boolean;
    }
  | Exclude<SignalClientMessage, { type: "hello"; version: 1; peer: "host" | "client"; token: string }>
  | { type: "error"; version: 1; code: SignalErrorCode; message: string; connectionId?: string };

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type SignalErrorCode =
  | "authentication_required"
  | "invalid_message"
  | "host_unavailable"
  | "host_busy"
  | "permission_denied"
  | "rate_limited"
  | "session_revoked"
  | "protocol_error";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const channelSchema = z.enum(["team", "remote-desktop"]);
const signalMessageTypeSchema = z.enum([
  "hello",
  "offer",
  "answer",
  "ice-candidate",
  "ice-restart",
  "turn-refresh",
  "disconnect",
]);
const signalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    version: z.literal(1),
    peer: z.enum(["host", "client"]),
    token: z.string().min(1).max(8_192),
    multiplex: z.boolean().optional(),
  }),
  z.object({
    type: z.enum(["offer", "answer"]),
    version: z.literal(1),
    connectionId: identifierSchema,
    channel: channelSchema,
    sdp: z.string().min(1).max(60_000),
  }),
  z.object({
    type: z.literal("ice-candidate"),
    version: z.literal(1),
    connectionId: identifierSchema,
    channel: channelSchema,
    candidate: z.string().min(1).max(8_192),
    sdpMid: z.string().min(1).max(256).nullable(),
    sdpMLineIndex: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    type: z.literal("ice-restart"),
    version: z.literal(1),
    connectionId: identifierSchema,
    channel: channelSchema,
  }),
  z.object({
    type: z.literal("turn-refresh"),
    version: z.literal(1),
    connectionId: identifierSchema.nullable(),
  }),
  z.object({
    type: z.literal("disconnect"),
    version: z.literal(1),
    connectionId: identifierSchema,
  }),
]);

export function decodeSignalClientMessage(value: unknown): SignalClientMessage {
  const envelope = z.object({ type: z.string() }).safeParse(value);
  if (envelope.success && !signalMessageTypeSchema.safeParse(envelope.data.type).success) {
    throw new Error("Unsupported signal message.");
  }
  return signalClientMessageSchema.parse(value);
}

export function encodeSignalServerMessage(message: SignalServerMessage): string {
  return JSON.stringify(message);
}

import { z } from "zod";
