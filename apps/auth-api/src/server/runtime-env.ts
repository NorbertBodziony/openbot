const LOCAL_RUNTIME_KEYS = [
  "AUTH_EXPOSE_DEVELOPMENT_CODE",
  "EMAIL_SMTP_PASSWORD",
  "SITE_REPORT_HASH_SECRET",
  "SITE_PUBLISH_ENABLED",
  "SITE_COOKIE_ISOLATION_READY",
  "REMOTE_TICKET_PRIVATE_JWK",
  "REMOTE_TICKET_PUBLIC_JWKS",
  "REMOTE_TICKET_KEY_ID",
  "REMOTE_SIGNAL_URL",
  "REMOTE_AUTH_WEBHOOK_URL",
  "REMOTE_AUTH_WEBHOOK_SECRET",
] as const;

const BOOLEAN_RUNTIME_KEYS = new Set<(typeof LOCAL_RUNTIME_KEYS)[number]>([
  "AUTH_EXPOSE_DEVELOPMENT_CODE",
  "SITE_PUBLISH_ENABLED",
  "SITE_COOKIE_ISOLATION_READY",
]);

export function readLocalRuntimeVars(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of LOCAL_RUNTIME_KEYS) {
    const value = environment[key];
    if (value === undefined) continue;
    result[key] = BOOLEAN_RUNTIME_KEYS.has(key) ? (normalizeBooleanFlag(value) ? "true" : "false") : value;
  }
  return result;
}

function normalizeBooleanFlag(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
