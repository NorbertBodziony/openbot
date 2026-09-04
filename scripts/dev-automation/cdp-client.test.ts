// Guardrails that keep automation on the intended dev instance: the wrong
// port must fail before any click or keystroke can reach another app.
import { describe, expect, it } from "vitest";
import { assertMutationAllowed, isOpenBotBrowser, pickMainPage, resolveAutomationPort } from "./cdp-client";

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

describe("resolveAutomationPort", () => {
  it("rejects values outside the dev port range", () => {
    expect(() => resolveAutomationPort("80", undefined)).toThrow();
  });

  it("marks defaulted ports as non-explicit so mutations refuse them", () => {
    expect(resolveAutomationPort(undefined, undefined)).toEqual({ port: 9_333, explicit: false });
    expect(resolveAutomationPort("", "  ")).toEqual({ port: 9_333, explicit: false });
  });

  it("marks flag and environment ports as explicit", () => {
    expect(resolveAutomationPort("9334", undefined)).toEqual({ port: 9334, explicit: true });
    expect(resolveAutomationPort(undefined, "9335")).toEqual({ port: 9335, explicit: true });
  });
});

describe("assertMutationAllowed", () => {
  it("refuses a mutation without the opt-in flag", () => {
    expect(() => assertMutationAllowed({ command: "click", allowMutations: false, portExplicit: true })).toThrow(
      /--allow-mutations/u,
    );
  });

  it("refuses a mutation that does not name the instance it drives", () => {
    expect(() => assertMutationAllowed({ command: "type", allowMutations: true, portExplicit: false })).toThrow(
      /--port=/u,
    );
  });

  it("allows a mutation that opts in and names its port", () => {
    expect(() => assertMutationAllowed({ command: "click", allowMutations: true, portExplicit: true })).not.toThrow();
  });
});
