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
// The affix runs are bounded rather than open: with `*` on both sides, every
// position in a long payload retried the whole keyword list, and redacting a
// 200 KB body took tens of seconds. No real label approaches 64 characters.
const SECRET_LABEL = `[A-Za-z0-9_.-]{0,64}(?:password|passwd|passphrase|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key|signing[_-]?key)[A-Za-z0-9_.-]{0,64}`;

// A scheme word carries the secret after it, so the assignment rule below
// cannot see it: its value stops at the space.
// `Bearer` is unambiguous enough to match anywhere - no English sentence puts
// a 8+ character token after it. `Basic`, `Digest` and `Token` are ordinary
// words, so they only count inside an `Authorization` header: without that
// context `Token validation failed` became `[redacted] failed` and
// `Basic authentication unavailable` lost its subject.
const BEARER_SECRET = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const AUTH_HEADER_SECRET = /(authorization["']?\s*[=:]+\s*)(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{8,}/giu;
// Quotes are optional on both sides and around the separator, so a serialized
// payload (`{"apiKey":"…"}`) redacts the same as a shell line (`apiKey=…`).
// A quoted value is consumed whole; an unquoted one stops at the first
// delimiter.
// The separator has to be an explicit `=` or `:`. Accepting bare whitespace as
// well turned prose into an assignment - `SKILLS_ADMIN_TOKEN is missing` lost
// the "is" - and a secret written without a separator is prose, not a
// key-value pair. `Bearer`-style values are the one real exception and the
// rule above owns them.
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`(["']?(?:${SECRET_LABEL})["']?\s*[=:]+\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)`,
  "giu",
);
// The prefix has to start a token: without the boundary, `sk-` matched inside
// ordinary words and `risk-register` came out as `ri[redacted]`, erasing the
// part of a diagnostic that names what failed.
const KNOWN_SECRET_PREFIXES = /(?<![A-Za-z0-9_-])(?:sk-ant|sk-|xai-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9._-]{8,}/g;
// Bounded for the same reason as the label above, and more sharply: with `+`
// on the local part, every character of a long payload consumed the rest of
// the run looking for an `@` and then backtracked over all of it.
const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/giu;
const SECRET_KEY = new RegExp(`^(?:${SECRET_LABEL}|keys?)$`, "iu");

// `key` and `keys` are too common in prose to redact on their own, but as a
// quoted JSON label they are a key-value pair like any other. This is the
// fallback for a payload too malformed to reparse, where `SECRET_KEY` - which
// does accept a bare `key` - never gets to see it.
const JSON_BARE_KEY = /("keys?"\s*:\s*)(\[redacted\]|"[^"]*"|'[^']*'|[^\s,;)}\]]+)/giu;

const MAX_PARAM_LENGTH = 2_000;

// What a value becomes when reading it is itself the failure. A constant
// rather than the thrown message: that message comes from the same
// caller-controlled getter and would leak what redaction just refused to read.
const UNSERIALIZABLE = "[unserializable]";

export function redactText(value: string): string {
  const reparsed = redactSerializedJson(value);
  if (reparsed !== null) return reparsed;
  return value
    .replace(AUTH_HEADER_SECRET, "$1[redacted]")
    .replace(BEARER_SECRET, "[redacted]")
    .replace(CREDENTIAL_ASSIGNMENT, redactAssignedValue)
    .replace(JSON_BARE_KEY, redactAssignedValue)
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
  // No size cap: a long payload is exactly where a secret hides, and the
  // truncation that follows keeps only the first characters - which would be
  // the unredacted ones.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.stringify(convertValue(JSON.parse(trimmed), new Set<object>())) ?? null;
  } catch {
    // Neither a parse failure nor a conversion failure may become the failure
    // the caller was trying to report: fall back to the regex rules, which
    // scan the text without recursing.
    return null;
  }
}

// `typeof` below narrows caller-provided unions, not already-known domain
// types, so the no-runtime-typeof warning does not apply. Conversion is
// cycle-safe: a revisited object becomes "[circular]" instead of overflowing,
// so logging a rejection value can never hide the failure it reports.
export function redactValue(value: LogValue): LogValue {
  return convertSafely(value);
}

// Converts anything a catch block or an external boundary hands over into a
// redaction-safe value. Errors keep name, message and stack; bigints keep
// their `n` suffix because JSON cannot carry them; anything else falls back
// to its string form rather than leaking through unredacted.
export function toLogValue(value: unknown): LogValue {
  return convertSafely(value);
}

// The last line of defence for both public entry points: whatever a caller
// hands over, converting it must never become the exception that hides the one
// being logged.
function convertSafely<T>(value: T): LogValue {
  try {
    return convertValue(value, new Set<object>());
  } catch {
    return UNSERIALIZABLE;
  }
}

// A cycle-free but very deep value - a nested array from an external payload -
// would otherwise recurse until the stack gives out, and the overflow would
// replace the failure the caller was reporting. The bound is far past any
// shape worth reading in a log line.
const MAX_CONVERSION_DEPTH = 32;

function convertValue<T>(value: T, seen: Set<object>, depth = 0): LogValue {
  if (typeof value === "string") return redactText(value);
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (value instanceof Error) {
    // The name is caller-controlled too - `new Error()` with a custom `name`,
    // or a class named after the header it failed on - so it is no safer than
    // the message.
    const converted: { [key: string]: LogValue } = {
      name: redactText(value.name),
      message: redactText(value.message),
    };
    if (typeof value.stack === "string") converted.stack = redactText(value.stack);
    return converted;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    if (depth >= MAX_CONVERSION_DEPTH) return "[too deep]";
    seen.add(value);
    return value.map((entry: LogValue) => convertValue(entry, seen, depth + 1));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    if (depth >= MAX_CONVERSION_DEPTH) return "[too deep]";
    seen.add(value);
    // `Object.entries` runs enumerable getters and proxy traps, so a rejection
    // value like `{ get detail() { throw … } }` would throw from inside the
    // logger and replace the failure the caller was reporting.
    let entries: [string, unknown][];
    try {
      entries = Object.entries(value);
    } catch {
      return UNSERIALIZABLE;
    }
    return Object.fromEntries(
      entries.map(([key, entry]): [string, LogValue] => [
        // A key is as caller-controlled as a value: a payload keyed by an
        // email address, or by the header that failed, leaks through a rule
        // that only looks at values.
        redactText(key),
        SECRET_KEY.test(key) ? "[redacted]" : convertValue(entry, seen, depth + 1),
      ]),
    );
  }
  // A symbol description or a `toString` of a foreign object is text of
  // unknown origin, so it goes through the same rules as any other string -
  // and `String()` itself can throw for a null-prototype object or a
  // throwing `toString`.
  try {
    return redactText(String(value));
  } catch {
    return UNSERIALIZABLE;
  }
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
