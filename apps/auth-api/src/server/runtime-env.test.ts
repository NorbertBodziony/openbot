import { describe, expect, it } from "vitest";
import { readLocalRuntimeVars } from "./runtime-env";

describe("local auth runtime variables", () => {
  it.each(["true", "1", "yes", "on"])("enables development codes for %s", (value) => {
    expect(readLocalRuntimeVars({ AUTH_EXPOSE_DEVELOPMENT_CODE: value })).toEqual({
      AUTH_EXPOSE_DEVELOPMENT_CODE: "true",
    });
  });

  it("does not copy unrelated process variables", () => {
    expect(readLocalRuntimeVars({ OTHER_SECRET: "do-not-copy" })).toEqual({});
  });
});
