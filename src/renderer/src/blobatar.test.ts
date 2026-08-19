import { traits, VERSION } from "blobatar";
import { blobatar, layout } from "blobatar/blob";
import { describe, expect, it } from "vitest";
import { avatarCandidateSeeds, avatarHeadColor, buildAnimatedAvatarSvg } from "./blobatar";

const avatarGeometryMarkup = (markup: string) => {
  const document = new DOMParser().parseFromString(markup, "image/svg+xml");
  return Array.from(document.querySelectorAll("circle, ellipse, line, path, polygon, polyline, rect")).map(
    (element) => element.outerHTML,
  );
};

describe("animated Blobatar adapter", () => {
  it("uses the current Blobatar generation", () => {
    expect(VERSION).toBe("2.0.0");
  });

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

  it("resolves the same head color used by the rendered avatar", () => {
    const seed = "new-agent";
    const markup = buildAnimatedAvatarSvg(seed, 0);

    expect(avatarHeadColor(seed, 0)).toBe(markup.match(/--mo-head:([^;]+)/)?.[1]);
  });

  it("keeps all visible geometry from the pinned Blobatar renderer", () => {
    const seed = "chief:avatar:2:4";
    const hue = 215;

    expect(avatarGeometryMarkup(buildAnimatedAvatarSvg(seed, hue))).toEqual(
      avatarGeometryMarkup(blobatar(seed, { hue })),
    );
  });

  it("keeps the current face and all ten package silhouettes in each deterministic set", () => {
    const firstSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 0);
    const repeatedSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 0);
    const nextSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 1);

    expect(firstSet).toEqual(repeatedSet);
    expect(firstSet).toHaveLength(12);
    expect(new Set(firstSet)).toHaveLength(12);
    expect(firstSet[0]).toBe("chief:avatar:4:7");
    expect(new Set(firstSet.map((seed) => layout(traits(seed)).shape))).toEqual(
      new Set(["round", "organic", "boxy", "nub", "cloud", "sun", "capsule", "triangle", "hexagon", "droplet"]),
    );
    expect(nextSet[0]).toBe(firstSet[0]);
    expect(nextSet.slice(1)).not.toEqual(firstSet.slice(1));
  });

  it("adds motion markup without changing any version 2 silhouette", () => {
    const seeds = avatarCandidateSeeds("chief", "chief:avatar:4:7", 0);

    for (const seed of seeds) {
      const animated = buildAnimatedAvatarSvg(seed, 215);
      expect(animated).toContain('class="mo-root"');
      expect(animated.match(/class="mo-eye"/gu)).toHaveLength(2);
      expect(avatarGeometryMarkup(animated)).toEqual(avatarGeometryMarkup(blobatar(seed, { hue: 215 })));
    }
  });
});
