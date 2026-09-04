// Automation and diagnostic logs must never leak tokens or emails,
// even when a caller passes them as structured params.
import { describe, expect, it, vi } from "vitest";
import { createOpenBotLogger, redactText, redactValue, toLogValue } from "./index";

describe("redactText", () => {
  it("redacts bearer tokens while keeping surrounding text", () => {
    expect(redactText("call with Bearer abcdef123456 and continue")).toBe("call with [redacted] and continue");
  });

  it("redacts provider secret prefixes", () => {
    expect(redactText("key sk-ant-abcdefgh1234 leaked")).toBe("key [redacted] leaked");
    expect(redactText("key xai-abcdefgh1234 leaked")).toBe("key [redacted] leaked");
  });

  it("redacts credential assignments and emails", () => {
    expect(redactText("password=hunter2 ok")).toBe("password=[redacted] ok");
    expect(redactText("contact jan@example.com please")).toBe("contact [redacted-email] please");
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

  it("routes warnings through the error sink when no sink is given", () => {
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    createOpenBotLogger("automation").warn("careful");
    expect(error).toHaveBeenCalledOnce();
  });
});
