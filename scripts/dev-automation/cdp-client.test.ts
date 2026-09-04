// Guardrails that keep automation on the intended dev instance: the wrong
// port must fail before any click or keystroke can reach another app.
import { describe, expect, it } from "vitest";
import { isOpenBotBrowser, pickMainPage, readAutomationPort } from "./cdp-client";

describe("isOpenBotBrowser", () => {
  it("accepts the Electron user agent", () => {
    expect(isOpenBotBrowser("Mozilla/5.0 OpenBot/44.0.0 Chrome/152 Electron/44.0.0")).toBe(true);
  });

  it("rejects foreign Chromium instances sharing the machine", () => {
    expect(isOpenBotBrowser("Mozilla/5.0 Chrome/152 Safari/537.36")).toBe(false);
    expect(isOpenBotBrowser("")).toBe(false);
  });
});

describe("pickMainPage", () => {
  it("prefers the bare app URL over helper surfaces in any order", () => {
    const island = { url: () => "http://localhost:5173/?surface=dynamic-island" };
    const main = { url: () => "http://localhost:5173/" };
    expect(pickMainPage([island, main])).toBe(main);
    expect(pickMainPage([main, island])).toBe(main);
  });

  it("falls back to the only page when every target is a helper", () => {
    const island = { url: () => "http://localhost:5173/?surface=dynamic-island" };
    expect(pickMainPage([island])).toBe(island);
    expect(pickMainPage([])).toBe(undefined);
  });
});

describe("readAutomationPort", () => {
  it("rejects values outside the dev port range", () => {
    expect(() => readAutomationPort("80")).toThrow();
    expect(readAutomationPort(undefined)).toBe(9_333);
  });
});
