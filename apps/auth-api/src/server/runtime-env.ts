const LOCAL_RUNTIME_KEYS = [
  "AUTH_EXPOSE_DEVELOPMENT_CODE",
  "EMAIL_SMTP_PASSWORD",
  "REMOTE_TICKET_PRIVATE_JWK",
  "REMOTE_TICKET_PUBLIC_JWKS",
  "REMOTE_TICKET_KEY_ID",
  "REMOTE_SIGNAL_URL",
  "REMOTE_AUTH_WEBHOOK_URL",
  "REMOTE_AUTH_WEBHOOK_SECRET",
] as const;

export function readLocalRuntimeVars(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of LOCAL_RUNTIME_KEYS) {
    const value = environment[key];
    if (value === undefined) continue;
    result[key] = key === "AUTH_EXPOSE_DEVELOPMENT_CODE" ? (normalizeBooleanFlag(value) ? "true" : "false") : value;
  }
  return result;
}

function normalizeBooleanFlag(value: string): boolean {
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
