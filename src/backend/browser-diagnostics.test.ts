import { describe, expect, it } from "vitest";
import { BrowserDiagnostics } from "./browser-diagnostics";

describe("BrowserDiagnostics", () => {
  it("keeps bounded sanitized summaries and recent action outcomes", () => {
    const diagnostics = new BrowserDiagnostics();
    for (let index = 0; index < 120; index++) {
      diagnostics.add({ kind: "network", level: index % 10 === 0 ? "error" : "info", message: `GET ${index}` });
      diagnostics.action({ action: "click", target: `ref ${index}`, outcome: index % 2 ? "success" : "error" });
    }

    const snapshot = diagnostics.snapshot();
    expect(snapshot.diagnostics).toHaveLength(50);
    expect(snapshot.actions).toHaveLength(50);
    expect(snapshot.diagnostics[0]?.message).toBe("GET 70");
    expect(snapshot.actions.at(-1)?.target).toBe("ref 119");
    expect(diagnostics.errorCount).toBe(10);

    diagnostics.clearDiagnostics();
    const cleared = diagnostics.snapshot();
    expect(cleared.diagnostics).toEqual([]);
    expect(cleared.actions).toHaveLength(50);
    expect(diagnostics.errorCount).toBe(0);
  });
});
