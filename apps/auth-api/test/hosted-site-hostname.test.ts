import { describe, expect, it } from "vitest";
import { descriptiveSlug } from "../src/server/hosted-site-service";

describe("hosted site hostname", () => {
  it("keeps the descriptive prefix between 32 and 48 characters", () => {
    expect(descriptiveSlug(["web", "page", "project"]).length).toBeGreaterThanOrEqual(32);
    expect(
      descriptiveSlug(["interactive", "budget", "planner", "for", "university", "students"]).length,
    ).toBeLessThanOrEqual(48);
  });
});
