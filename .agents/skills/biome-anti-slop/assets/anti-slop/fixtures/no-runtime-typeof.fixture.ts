// Fixture for `no-runtime-typeof`. Every line the rule must reject carries a trailing
// `// flag`; every other line is correct code the rule must leave alone.
// Checked by `scripts/anti-slop-rules.test.ts`; not compiled and not linted.

type Fetcher = typeof globalThis.fetch;
type ProviderId = (typeof AGENT_PROVIDERS)[number];
type Key = keyof typeof AGENT_PROVIDERS;
export function decodeName(value: unknown): string | null {
  return typeof value === "string" ? value : null; // flag
}
