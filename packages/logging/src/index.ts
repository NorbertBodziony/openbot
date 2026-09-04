import { dummyLogger, type Logger } from "ts-log";

export type { Logger };
export { dummyLogger };

// The values a log call can carry. A recursive domain type instead of
// `unknown`: redaction branches on it without assertions, and callers keep
// their own types because every JSON-shaped value already fits.
export type LogValue = string | number | boolean | bigint | null | undefined | LogValue[] | { [key: string]: LogValue };

const BEARER_OR_TOKEN = /(?:Bearer\s+|token[=: ]+)[A-Za-z0-9._-]{8,}/giu;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const KNOWN_SECRET_PREFIXES = /(?:sk-ant|sk-|xai-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9._-]{8,}/g;
const CREDENTIAL_ASSIGNMENT =
  /((?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|machine[_-]?token)[=: ]+)(["']?)[^"'\s,}]+(["']?)/giu;
const SECRET_KEY = /password|secret|token|key|auth|credential/iu;

const MAX_PARAM_LENGTH = 2_000;

export function redactText(value: string): string {
  return value
    .replace(BEARER_OR_TOKEN, "[redacted]")
    .replace(KNOWN_SECRET_PREFIXES, "[redacted]")
    .replace(CREDENTIAL_ASSIGNMENT, "$1$2[redacted]$3")
    .replace(EMAIL, "[redacted-email]");
}

// `typeof` below narrows caller-provided unions, not already-known domain
// types, so the no-runtime-typeof warning does not apply. Conversion is
// cycle-safe: a revisited object becomes "[circular]" instead of overflowing,
// so logging a rejection value can never hide the failure it reports.
export function redactValue(value: LogValue): LogValue {
  return convertValue(value, new Set<object>());
}

// Converts anything a catch block or an external boundary hands over into a
// redaction-safe value. Errors keep name, message and stack; bigints keep
// their `n` suffix because JSON cannot carry them; anything else falls back
// to its string form rather than leaking through unredacted.
export function toLogValue(value: unknown): LogValue {
  return convertValue(value, new Set<object>());
}

function convertValue<T>(value: T, seen: Set<object>): LogValue {
  if (typeof value === "string") return redactText(value);
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (value instanceof Error) {
    const converted: { [key: string]: LogValue } = { name: value.name, message: value.message };
    if (typeof value.stack === "string") converted.stack = value.stack;
    return converted;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map((entry: LogValue) => convertValue(entry, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]): [string, LogValue] => [
        key,
        SECRET_KEY.test(key) ? "[redacted]" : convertValue(entry, seen),
      ]),
    );
  }
  return String(value);
}

function formatParam(param: LogValue): string {
  if (typeof param === "string") {
    const redacted = redactText(param);
    return redacted.length > MAX_PARAM_LENGTH ? `${redacted.slice(0, MAX_PARAM_LENGTH)}…` : redacted;
  }
  const serialized = JSON.stringify(redactValue(param)) ?? String(param);
  return serialized.length > MAX_PARAM_LENGTH ? `${serialized.slice(0, MAX_PARAM_LENGTH)}…` : serialized;
}

function formatLine(level: string, prefix: string, message: LogValue, params: LogValue[]): string {
  const head = typeof message === "string" ? redactText(message) : formatParam(message);
  const tail = params.map((param) => formatParam(param)).join(" ");
  return `${new Date().toISOString()} ${level} [${prefix}]${head ? ` ${head}` : ""}${tail ? ` ${tail}` : ""}`;
}

export function createOpenBotLogger(prefix: string, sink?: (line: string) => void): Logger {
  const out = sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    trace: (message?: LogValue, ...params: LogValue[]) => out(formatLine("TRACE", prefix, message, params)),
    debug: (message?: LogValue, ...params: LogValue[]) => out(formatLine("DEBUG", prefix, message, params)),
    info: (message?: LogValue, ...params: LogValue[]) => out(formatLine("INFO", prefix, message, params)),
    warn: (message?: LogValue, ...params: LogValue[]) => err(formatLine("WARN", prefix, message, params)),
    error: (message?: LogValue, ...params: LogValue[]) => err(formatLine("ERROR", prefix, message, params)),
  };
}
