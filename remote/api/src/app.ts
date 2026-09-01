import { Elysia } from "elysia";
import { z } from "zod";
import type { RemoteApiConfig } from "./config";
import type { SignalService, SignalSocket } from "./signal-service";
import { verifyWebhookSignature } from "./tokens";

const authEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("remote-auth-changed"),
    hostId: z.string().min(1),
    authEpoch: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("remote-session-ended"),
    hostId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
]);

export function createRemoteApiApp(config: RemoteApiConfig, signal: SignalService) {
  const socketIds = new SignalSocketIds();
  const app = new Elysia()
    .get("/health/live", () => ({ service: "openbot-remote-api", status: "live" }))
    .get("/health/ready", () => ({ service: "openbot-remote-api", status: "ready" }))
    .post("/internal/auth-events", async ({ request, set }) => {
      const timestamp = request.headers.get("OpenBot-Timestamp") ?? "";
      const signature = request.headers.get("OpenBot-Signature") ?? "";
      const body = await request.text();
      if (!verifyWebhookSignature(body, timestamp, signature, config.authWebhookSecret)) {
        set.status = 401;
        return { error: { code: "invalid_signature", message: "The auth event signature is invalid." } };
      }
      const event = decodeAuthEvent(body);
      if (!event) {
        set.status = 400;
        return { error: { code: "invalid_event", message: "The auth event is invalid." } };
      }
      if (event.type === "remote-auth-changed") signal.revoke(event.hostId, event.authEpoch);
      else signal.revokeSession(event.sessionId);
      set.status = 204;
      return;
    })
    .ws("/v1/signal", {
      idleTimeout: 120,
      maxPayloadLength: 64 * 1024,
      backpressureLimit: 256 * 1024,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      sendPings: true,
      open(ws) {
        signal.connect(socketAdapter(ws, config.trustProxy, socketIds.create(ws.raw)));
      },
      async message(ws, message) {
        const socket = socketAdapter(ws, config.trustProxy, socketIds.get(ws.raw));
        const textMessage = z.string().safeParse(message);
        const input = textMessage.success
          ? textMessage.data
          : message instanceof Uint8Array
            ? message
            : JSON.stringify(message);
        await signal.receive(socket, input);
      },
      close(ws) {
        signal.disconnect(socketAdapter(ws, config.trustProxy, socketIds.get(ws.raw)));
        socketIds.delete(ws.raw);
      },
      error({ error }) {
        console.error("Remote signal WebSocket failed.", error instanceof Error ? error.message : "Unknown error");
      },
    });
  return app;
}

interface SignalSocketOwner {
  readonly data?: unknown;
}

interface ElysiaSocketLike {
  raw: SignalSocketOwner;
  data?: { request?: Request };
  remoteAddress?: string;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

export class SignalSocketIds {
  readonly #values = new WeakMap<SignalSocketOwner, string>();

  create(socket: SignalSocketOwner): string {
    const id = crypto.randomUUID();
    this.#values.set(socket, id);
    return id;
  }

  get(socket: SignalSocketOwner): string {
    const id = this.#values.get(socket);
    if (!id) throw new Error("Signal socket has no identifier.");
    return id;
  }

  delete(socket: SignalSocketOwner): void {
    this.#values.delete(socket);
  }
}

function socketAdapter(ws: ElysiaSocketLike, trustProxy: boolean, id: string): SignalSocket {
  return {
    id,
    ip: signalClientIp(ws.remoteAddress, ws.data?.request?.headers.get("x-forwarded-for"), trustProxy),
    send: (message) => {
      ws.send(message);
    },
    close: (code, reason) => ws.close(code, reason.slice(0, 123)),
  };
}

export function signalClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | null | undefined,
  trustProxy: boolean,
) {
  if (!trustProxy) return remoteAddress ?? "unknown";
  const forwarded = forwardedFor?.split(",", 1)[0]?.trim();
  return forwarded || remoteAddress || "unknown";
}

function decodeAuthEvent(body: string): z.infer<typeof authEventSchema> | null {
  try {
    const result = authEventSchema.safeParse(JSON.parse(body));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function prometheusMetrics(signal: SignalService): string {
  const metrics = signal.metrics();
  return [
    "# TYPE openbot_remote_signal_sockets gauge",
    `openbot_remote_signal_sockets ${metrics.activeSockets}`,
    "# TYPE openbot_remote_peer_connections gauge",
    `openbot_remote_peer_connections ${metrics.activePeerConnections}`,
    "# TYPE openbot_remote_signal_messages_total counter",
    `openbot_remote_signal_messages_total ${metrics.relayedMessages}`,
    "# TYPE openbot_remote_auth_failures_total counter",
    `openbot_remote_auth_failures_total ${metrics.authenticationFailures}`,
    "# TYPE openbot_remote_protocol_failures_total counter",
    `openbot_remote_protocol_failures_total ${metrics.protocolFailures}`,
    "",
  ].join("\n");
}
