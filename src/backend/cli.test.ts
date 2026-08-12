// @vitest-environment node

import { describe, expect, it } from "vitest";
import { CodexCliError, parseCodexVersion } from "./cli";

describe("Codex CLI version parsing", () => {
  it("reads the installed CLI version format", () => {
    expect(parseCodexVersion("codex-cli 0.144.1\n")).toBe("0.144.1");
  });

  it("fails closed on an unknown format", () => {
    expect(() => parseCodexVersion("Codex development build")).toThrow(CodexCliError);
  });
});
