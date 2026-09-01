export interface RemoteApiConfig {
  host: string;
  port: number;
  healthPort: number;
  tlsCertificatePath: string | null;
  tlsPrivateKeyPath: string | null;
  ticketJwks: string | null;
  ticketJwksUrl: string | null;
  controlPlaneUrl: string;
  sessionSecret: string;
  authWebhookSecret: string;
  turnSecret: string;
  turnHost: string;
  turnPort: number;
  turnTlsPort: number;
  metricsToken: string | null;
  maximumConnectionsPerUser: number;
  maximumConnectionsPerIp: number;
  maximumMessagesPerMinute: number;
  trustProxy: boolean;
}

export function readRemoteApiConfig(environment: Record<string, string | undefined> = process.env): RemoteApiConfig {
  const tlsDisabled = environment.REMOTE_TLS_DISABLED === "true";
  const ticketJwks = optional(environment.REMOTE_TICKET_PUBLIC_KEYS);
  const ticketJwksUrl = optional(environment.REMOTE_TICKET_JWKS_URL);
  if (!ticketJwks && !ticketJwksUrl)
    throw new Error("REMOTE_TICKET_PUBLIC_KEYS or REMOTE_TICKET_JWKS_URL is required.");
  return {
    host: environment.REMOTE_SIGNAL_HOST ?? "0.0.0.0",
    port: positiveInteger(environment.REMOTE_SIGNAL_PORT, tlsDisabled ? 8081 : 8443),
    healthPort: positiveInteger(environment.REMOTE_HEALTH_PORT, 8080),
    tlsCertificatePath: tlsDisabled ? null : required(environment.REMOTE_TLS_CERT_PATH, "REMOTE_TLS_CERT_PATH"),
    tlsPrivateKeyPath: tlsDisabled ? null : required(environment.REMOTE_TLS_KEY_PATH, "REMOTE_TLS_KEY_PATH"),
    ticketJwks,
    ticketJwksUrl,
    controlPlaneUrl: required(environment.REMOTE_CONTROL_PLANE_URL, "REMOTE_CONTROL_PLANE_URL"),
    sessionSecret: strongSecret(environment.REMOTE_SESSION_SECRET, "REMOTE_SESSION_SECRET"),
    authWebhookSecret: strongSecret(environment.REMOTE_AUTH_WEBHOOK_SECRET, "REMOTE_AUTH_WEBHOOK_SECRET"),
    turnSecret: strongSecret(environment.TURN_SHARED_SECRET, "TURN_SHARED_SECRET"),
    turnHost: required(environment.TURN_HOST, "TURN_HOST"),
    turnPort: positiveInteger(environment.TURN_PORT, 3478),
    turnTlsPort: positiveInteger(environment.TURN_TLS_PORT, 5349),
    metricsToken: optional(environment.REMOTE_METRICS_TOKEN),
    maximumConnectionsPerUser: positiveInteger(environment.REMOTE_MAX_CONNECTIONS_PER_USER, 8),
    maximumConnectionsPerIp: positiveInteger(environment.REMOTE_MAX_CONNECTIONS_PER_IP, 32),
    maximumMessagesPerMinute: positiveInteger(environment.REMOTE_MAX_MESSAGES_PER_MINUTE, 600),
    trustProxy: environment.REMOTE_TRUST_PROXY === "true",
  };
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function optional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function strongSecret(value: string | undefined, name: string): string {
  const secret = required(value, name);
  if (new TextEncoder().encode(secret).byteLength < 32) throw new Error(`${name} must contain at least 32 bytes.`);
  return secret;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}
