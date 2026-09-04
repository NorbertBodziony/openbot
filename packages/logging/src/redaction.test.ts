// Automation and diagnostic logs must never leak tokens or emails,
// even when a caller passes them as structured params.
import { describe, expect, it, vi } from "vitest";
import { createOpenBotLogger, redactText, redactValue, resolveLogLevel, toLogValue } from "./index";

describe("redactText", () => {
  it("redacts bearer tokens while keeping surrounding text", () => {
    expect(redactText("call with Bearer abcdef123456 and continue")).toBe("call with [redacted] and continue");
  });

  it("redacts provider secret prefixes", () => {
    expect(redactText("key sk-ant-abcdefgh1234 leaked")).toBe("key [redacted] leaked");
    expect(redactText("key xai-abcdefgh1234 leaked")).toBe("key [redacted] leaked");
  });

  it("leaves an ordinary word that starts like a provider prefix alone", () => {
    expect(redactText("marketplace agent risk-register failed to install")).toBe(
      "marketplace agent risk-register failed to install",
    );
  });

  it("redacts a bare JSON key in a payload too malformed to reparse", () => {
    expect(redactText('{"key":"pk_live_abcdefgh1234","truncated')).toBe('{"key":"[redacted]","truncated');
  });

  it("redacts a serialized payload no matter how long it is", () => {
    const padding = "x".repeat(200_000);
    expect(redactText(JSON.stringify({ key: "pk_live_abcdefgh1234", padding }))).toBe(
      JSON.stringify({ key: "[redacted]", padding }),
    );
  });

  it("redacts credential assignments and emails", () => {
    expect(redactText("password=hunter2 ok")).toBe("password=[redacted] ok");
    expect(redactText("contact jan@example.com please")).toBe("contact [redacted-email] please");
  });

  it("redacts secrets inside a payload that arrives as one string", () => {
    expect(redactText('{"apiKey":"pk_live_9f2b3c4d5e"}')).not.toContain("pk_live_9f2b3c4d5e");
    expect(redactText('{"machineToken":"mt_abc123def456"}')).not.toContain("mt_abc123def456");
    expect(redactText('body={"password":"hunter2"}')).not.toContain("hunter2");
    // Only the key rules know that a bare `key` holds a secret, so this one
    // proves the payload is reparsed rather than pattern-matched as prose.
    expect(redactText('{"key":"pk_live_9f2b3c4d5e"}')).not.toContain("pk_live_9f2b3c4d5e");
  });

  it("redacts a quoted credential whole instead of stopping at the first space", () => {
    expect(redactText('password: "my secret pass"')).toBe('password: "[redacted]"');
  });

  it("redacts scheme-prefixed authorization values and cookies", () => {
    expect(redactText("Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l")).toBe("Authorization: [redacted]");
    expect(redactText("set-cookie: session=9f2b3c4d5e6f")).not.toContain("9f2b3c4d5e6f");
  });

  it("leaves an already redacted line unchanged when it passes through twice", () => {
    const once = redactText('{"password":"hunter2"}');
    expect(redactText(once)).toBe(once);
    expect(redactText(redactText("password=hunter2"))).toBe("password=[redacted]");
  });

  it("leaves identifiers such as bot UUIDs untouched", () => {
    const uuid = "bot-3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(redactText(`loaded ${uuid}`)).toBe(`loaded ${uuid}`);
  });
});

describe("redactValue", () => {
  it("redacts secret-valued keys deep inside objects", () => {
    expect(redactValue({ nested: { machineToken: "abcdef123456", name: "alfred" } })).toEqual({
      nested: { machineToken: "[redacted]", name: "alfred" },
    });
  });
});

describe("toLogValue", () => {
  it("breaks reference cycles instead of overflowing", () => {
    const loop: { name: string; self?: unknown } = { name: "chief" };
    loop.self = loop;
    expect(() => toLogValue(loop)).not.toThrow();
    expect(toLogValue(loop)).toEqual({ name: "chief", self: "[circular]" });
  });

  it("serializes bigints instead of throwing in JSON.stringify", () => {
    const lines: string[] = [];
    const logger = createOpenBotLogger("automation", (line) => lines.push(line));
    expect(() => logger.info("count", 10n)).not.toThrow();
    expect(lines[0]).toContain("10n");
  });
  it("keeps error details while redacting secrets when logged", () => {
    const lines: string[] = [];
    const logger = createOpenBotLogger("automation", (line) => lines.push(line));
    logger.error("provider failed", toLogValue(new Error("failed with Bearer abcdef123456")));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("provider failed");
    expect(lines[0]).toContain("Error");
    expect(lines[0]).not.toContain("abcdef123456");
  });

  it("falls back to strings for values without a log shape", () => {
    expect(toLogValue(undefined)).toBe(undefined);
    expect(toLogValue(42)).toBe(42);
    expect(typeof toLogValue(Symbol("scope"))).toBe("string");
  });
});

describe("resolveLogLevel", () => {
  it("falls back to info for an unset or unknown value", () => {
    expect(resolveLogLevel(undefined)).toBe("info");
    expect(resolveLogLevel("verbose")).toBe("info");
    expect(resolveLogLevel("debug")).toBe("debug");
  });
});

describe("createOpenBotLogger", () => {
  it("prefixes lines and redacts secrets before they reach the sink", () => {
    const lines: string[] = [];
    const logger = createOpenBotLogger("automation", (line) => lines.push(line));
    logger.info("hello", { token: "abcdef123456" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[automation]");
    expect(lines[0]).toContain("hello");
    expect(lines[0]).not.toContain("abcdef123456");
  });

  it("drops calls below the configured level", () => {
    const lines: string[] = [];
    const logger = createOpenBotLogger("automation", (line) => lines.push(line), "warn");
    logger.debug("noisy");
    logger.info("routine");
    logger.warn("careful");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("careful");
  });

  it("keeps every level when asked for trace and none when silenced", () => {
    const traced: string[] = [];
    createOpenBotLogger("automation", (line) => traced.push(line), "trace").trace("deep");
    expect(traced).toHaveLength(1);
    const silenced: string[] = [];
    createOpenBotLogger("automation", (line) => silenced.push(line), "silent").error("boom");
    expect(silenced).toHaveLength(0);
  });

  it("routes warnings through the error sink when no sink is given", () => {
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    createOpenBotLogger("automation").warn("careful");
    expect(error).toHaveBeenCalledOnce();
  });
});
