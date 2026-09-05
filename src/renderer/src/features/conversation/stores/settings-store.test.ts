import { describe, expect, it } from "vitest";
import { isCompleteRuntimeSettingsPatch, runtimeSettingsEqual } from "./settings-store";

const SETTINGS = { provider: "codex", model: "gpt-5.6-luna", reasoningEffort: "medium" } as const;

describe("runtime settings patches", () => {
  it("compares every settings field", () => {
    expect(runtimeSettingsEqual({ ...SETTINGS }, { ...SETTINGS })).toBe(true);
    expect(runtimeSettingsEqual({ ...SETTINGS }, { ...SETTINGS, model: "gpt-5.6-sol" })).toBe(false);
    expect(runtimeSettingsEqual({ ...SETTINGS }, { ...SETTINGS, provider: "claude" })).toBe(false);
    expect(runtimeSettingsEqual({ ...SETTINGS }, { ...SETTINGS, reasoningEffort: "high" })).toBe(false);
  });

  it("requires provider and model for a complete patch", () => {
    expect(isCompleteRuntimeSettingsPatch({ provider: "codex", model: "x", reasoningEffort: "low" })).toBe(true);
    expect(isCompleteRuntimeSettingsPatch({ reasoningEffort: "high" })).toBe(false);
  });
});
