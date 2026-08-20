import { describe, expect, it } from "vitest";
import { isCloseBrowserTabShortcut, isGlobalSearchShortcut, isToggleDevToolsShortcut } from "./browser-shortcuts";

const input = (overrides: Partial<Parameters<typeof isCloseBrowserTabShortcut>[0]> = {}) => ({
  type: "keyDown",
  key: "w",
  control: false,
  meta: false,
  alt: false,
  shift: false,
  ...overrides,
});

describe("isGlobalSearchShortcut", () => {
  it("accepts Control+K and Command+K", () => {
    expect(isGlobalSearchShortcut(input({ control: true, key: "k" }))).toBe(true);
    expect(isGlobalSearchShortcut(input({ meta: true, key: "K" }))).toBe(true);
  });

  it("does not claim modified shortcuts or key-up events", () => {
    expect(isGlobalSearchShortcut(input({ key: "k" }))).toBe(false);
    expect(isGlobalSearchShortcut(input({ control: true, key: "k", shift: true }))).toBe(false);
    expect(isGlobalSearchShortcut(input({ meta: true, key: "k", alt: true }))).toBe(false);
    expect(isGlobalSearchShortcut(input({ control: true, key: "k", type: "keyUp" }))).toBe(false);
  });
});

describe("isCloseBrowserTabShortcut", () => {
  it("accepts Control+W and Command+W", () => {
    expect(isCloseBrowserTabShortcut(input({ control: true }))).toBe(true);
    expect(isCloseBrowserTabShortcut(input({ meta: true, key: "W" }))).toBe(true);
  });

  it("does not claim modified shortcuts or key-up events", () => {
    expect(isCloseBrowserTabShortcut(input())).toBe(false);
    expect(isCloseBrowserTabShortcut(input({ control: true, shift: true }))).toBe(false);
    expect(isCloseBrowserTabShortcut(input({ meta: true, alt: true }))).toBe(false);
    expect(isCloseBrowserTabShortcut(input({ control: true, type: "keyUp" }))).toBe(false);
  });
});

describe("isToggleDevToolsShortcut", () => {
  it("accepts F12 and the common platform shortcuts", () => {
    expect(isToggleDevToolsShortcut(input({ key: "F12" }))).toBe(true);
    expect(isToggleDevToolsShortcut(input({ control: true, shift: true, key: "i" }))).toBe(true);
    expect(isToggleDevToolsShortcut(input({ meta: true, alt: true, key: "I" }))).toBe(true);
  });

  it("does not claim incomplete shortcuts or key-up events", () => {
    expect(isToggleDevToolsShortcut(input({ key: "i", control: true }))).toBe(false);
    expect(isToggleDevToolsShortcut(input({ key: "i", meta: true, alt: true, shift: true }))).toBe(false);
    expect(isToggleDevToolsShortcut(input({ key: "F12", type: "keyUp" }))).toBe(false);
  });
});
