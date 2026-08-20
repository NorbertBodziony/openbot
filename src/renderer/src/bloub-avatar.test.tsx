import { SHAPES } from "@norbert_bodziony/bloub";
import { describe, expect, it, vi } from "vitest";
import {
  avatarCandidateSeeds,
  avatarHeadColor,
  avatarHueSwatch,
  bloubAvatarProfile,
  createStaticAvatarSvg,
} from "./bloub-avatar";

describe("Bloub avatar adapter", () => {
  it("resolves a stable profile from the stored seed", () => {
    expect(bloubAvatarProfile("chief:avatar:2:4", null)).toEqual(bloubAvatarProfile("chief:avatar:2:4", null));
    expect(bloubAvatarProfile("chief:avatar:2:4", null)).not.toEqual(bloubAvatarProfile("research:avatar:2:4", null));
  });

  it("maps stored hues to the visible Bloub color", () => {
    expect(bloubAvatarProfile("chief", 215).color).toBe("bleu");
    expect(avatarHeadColor("chief", 215)).toBe("#3b93f0");
    expect(avatarHueSwatch(215)).toBe(avatarHeadColor("different-seed", 215));
  });

  it("keeps all eight Bloub shapes in each deterministic candidate set", () => {
    const firstSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 0);
    const repeatedSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 0);
    const nextSet = avatarCandidateSeeds("chief", "chief:avatar:4:7", 1);

    expect(firstSet).toEqual(repeatedSet);
    expect(firstSet).toHaveLength(12);
    expect(new Set(firstSet)).toHaveLength(12);
    expect(firstSet[0]).toBe("chief:avatar:4:7");
    expect(new Set(firstSet.map((seed) => bloubAvatarProfile(seed, null).shape))).toEqual(
      new Set(SHAPES.map((shape) => shape.id)),
    );
    expect(new Set(firstSet.map((seed) => bloubAvatarProfile(seed, null).expression)).size).toBeGreaterThanOrEqual(8);
    expect(nextSet[0]).toBe(firstSet[0]);
    expect(nextSet.slice(1)).not.toEqual(firstSet.slice(1));
  });

  it("renders decorative static SVG without starting an animation frame", () => {
    const requestAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);

    const svg = createStaticAvatarSvg("chief", 215);

    expect(svg.localName).toBe("svg");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.hasAttribute("role")).toBe(false);
    expect(svg.hasAttribute("aria-label")).toBe(false);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
