import { describe, expect, it } from "vitest";
import { avatarCandidateSeeds, bloubAvatarProfile, createStaticAvatarSvg } from "./bloub-avatar";

describe("Bloub avatar adapter", () => {
  it("returns a stable, duplicate-free candidate set that never offers the droplet", () => {
    const firstSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 0);
    const repeatedSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 0);
    const nextSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 1);

    expect(firstSet).toEqual(repeatedSet);
    expect(new Set(firstSet)).toHaveLength(firstSet.length);
    expect(firstSet[0]).toBe("chief:avatar:4:7");
    expect(firstSet.map((seed) => bloubAvatarProfile(seed, null).shape)).not.toContain("goutte");
    expect(nextSet[0]).toBe(firstSet[0]);
    expect(nextSet.slice(1)).not.toEqual(firstSet.slice(1));
  });

  it("hides the static avatar from assistive technology", () => {
    const svg = createStaticAvatarSvg("chief", 215);

    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.hasAttribute("role")).toBe(false);
    expect(svg.hasAttribute("aria-label")).toBe(false);
  });
});
