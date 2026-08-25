import { describe, expect, it } from "vitest";
import { isSkillCategory, SKILL_CATEGORIES } from "./ipc-skills";

describe("skill marketplace contracts", () => {
  it("keeps the category taxonomy closed", () => {
    expect(SKILL_CATEGORIES).toHaveLength(8);
    expect(isSkillCategory("data-analytics")).toBe(true);
    expect(isSkillCategory("payments")).toBe(false);
  });
});
