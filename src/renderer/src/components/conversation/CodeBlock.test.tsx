import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlock, codeLanguage, codeLanguageLabel } from "./CodeBlock";

describe("CodeBlock", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("copies the raw code and confirms the action", async () => {
    render(() => <CodeBlock block={{ type: "code", code: "const answer = 42;", language: "js" }} />);

    await fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    await waitFor(() => expect(screen.getByRole("button", { name: "Code copied" })).toBeInTheDocument());
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("normalizes language aliases and keeps unknown labels useful", () => {
    expect(codeLanguage("typescript")).toBe("ts");
    expect(codeLanguage("tsx")).toBe("ts");
    expect(codeLanguage("unknown-lang")).toBe("plain");
    expect(codeLanguageLabel("tsx")).toBe("TypeScript");
    expect(codeLanguageLabel("unknown-lang")).toBe("UNKNOWN-LANG");
  });
});
