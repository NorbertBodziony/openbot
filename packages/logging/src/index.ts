import { dummyLogger, type Logger } from "ts-log";

export type { Logger };
export { dummyLogger };

// The values a log call can carry. A recursive domain type instead of
// `unknown`: redaction branches on it without assertions, and callers keep
// their own types because every JSON-shaped value already fits.
export type LogValue = string | number | boolean | bigint | null | undefined | LogValue[] | { [key: string]: LogValue };

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_RANK: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 60 };
const LOG_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "silent"];

// A label whose value is a secret, used both for `key: value` shapes inside a
// string and for object keys. Prefix and suffix let `machineToken`,
// `refresh_token` and `X-Api-Key` all match; bare `key` is handled separately
// because `monkey` and `keyboard` are not secrets.
const SECRET_LABEL = `[A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key|signing[_-]?key)[A-Za-z0-9_.-]*`;

// `Authorization: Basic <base64>` and `Bearer <token>` carry the secret after
// a scheme word, so the assignment rule below cannot see it: its value stops
// at the space.
const AUTH_SCHEME_SECRET = /(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{8,}/giu;
// Quotes are optional on both sides and around the separator, so a serialized
// payload (`{"apiKey":"…"}`) redacts the same as a shell line (`apiKey=…`).
// A quoted value is consumed whole; an unquoted one stops at the first
// delimiter.
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(["']?(?:${SECRET_LABEL})["']?(?:\s*[=:]+\s*|\s+))(\[redacted\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)`,
  "giu",
);
const KNOWN_SECRET_PREFIXES = /(?:sk-ant|sk-|xai-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9._-]{8,}/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const SECRET_KEY = new RegExp(`^(?:${SECRET_LABEL}|keys?)$`, "iu");

const MAX_PARAM_LENGTH = 2_000;
// Above this a string is logged as text rather than reparsed as JSON: the
// parse is a redaction aid, not a formatter, and it is not worth the scan.
const MAX_JSON_REPARSE_LENGTH = 100_000;

export function redactText(value: string): string {
  const reparsed = redactSerializedJson(value);
  if (reparsed !== null) return reparsed;
  return value
    .replace(AUTH_SCHEME_SECRET, "[redacted]")
    .replace(CREDENTIAL_ASSIGNMENT, redactAssignedValue)
    .replace(KNOWN_SECRET_PREFIXES, "[redacted]")
    .replace(EMAIL, "[redacted-email]");
}

function redactAssignedValue(_match: string, label: string, value: string): string {
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
  return `${label}${quote}[redacted]${quote}`;
}

// A payload logged as one string is the shape secrets escape in most often -
// an echoed response body, a spawn argument list, a serialized request. Once
// it parses, the key rules apply to it exactly as they would to a structured
// param, so `{"apiKey":"…"}` cannot pass as prose.
function redactSerializedJson(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > MAX_JSON_REPARSE_LENGTH) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return JSON.stringify(convertValue(parsed, new Set<object>())) ?? null;
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
    const converted: { [key: string]: LogValue } = { name: value.name, message: redactText(value.message) };
    if (typeof value.stack === "string") converted.stack = redactText(value.stack);
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

// `info` by default, so a `debug` call added for one investigation does not
// keep writing on every user's machine. `OPENBOT_LOG_LEVEL` raises or lowers
// it without a rebuild; an unknown value is ignored rather than silencing the
// log.
export function resolveLogLevel(raw: string | undefined, fallback: LogLevel = "info"): LogLevel {
  for (const level of LOG_LEVELS) {
    if (level === raw) return level;
  }
  return fallback;
}

export function createOpenBotLogger(prefix: string, sink?: (line: string) => void, level?: LogLevel): Logger {
  const threshold = LEVEL_RANK[level ?? resolveLogLevel(process.env.OPENBOT_LOG_LEVEL)];
  const out = sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const write = (
    logLevel: LogLevel,
    label: string,
    stream: (line: string) => void,
  ): ((message?: LogValue, ...params: LogValue[]) => void) => {
    if (LEVEL_RANK[logLevel] < threshold) return () => undefined;
    return (message?: LogValue, ...params: LogValue[]) => stream(formatLine(label, prefix, message, params));
  };
  return {
    trace: write("trace", "TRACE", out),
    debug: write("debug", "DEBUG", out),
    info: write("info", "INFO", out),
    warn: write("warn", "WARN", err),
    error: write("error", "ERROR", err),
  };
}
