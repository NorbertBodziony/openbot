import { describe, expect, it } from "vitest";
import { avatarCandidateSeeds, buildAnimatedAvatarSvg } from "./blobatar";

describe("animated Blobatar adapter", () => {
  it("renders stable motion markup for the same agent seed", () => {
    const first = buildAnimatedAvatarSvg("chief", null);
    const second = buildAnimatedAvatarSvg("chief", null);

    expect(second).toBe(first);
    expect(first).toContain('class="mo-root"');
    expect(first).toContain('class="mo-breathe"');
    expect(first).toContain('class="mo-eyes"');
    expect(first.match(/class="mo-eye"/g)).toHaveLength(2);
  });

  it("uses continuous motion only when requested", () => {
    expect(buildAnimatedAvatarSvg("chief", 215, "always")).toContain('class="mo-root mo-always"');
    expect(buildAnimatedAvatarSvg("chief", 215, "hover")).not.toContain("mo-always");
  });

  it("keeps the current face while producing deterministic alternative sets", () => {
    const firstSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 0);
    const repeatedSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 0);
    const nextSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 1);

    expect(firstSet).toEqual(repeatedSet);
    expect(firstSet).toHaveLength(12);
    expect(new Set(firstSet)).toHaveLength(12);
    expect(firstSet[0]).toBe("chief:avatar:4:7");
    expect(nextSet[0]).toBe(firstSet[0]);
    expect(nextSet.slice(1)).not.toEqual(firstSet.slice(1));
  });
});
