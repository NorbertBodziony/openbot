const LOCAL_RUNTIME_KEYS = [
  "AUTH_EXPOSE_DEVELOPMENT_CODE",
  "EMAIL_SMTP_PASSWORD",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_TUNNEL_DOMAIN",
  "CLOUDFLARE_API_TOKEN",
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
