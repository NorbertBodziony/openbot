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

  it("renders the filename, language, line numbers, and streamed caret", () => {
    render(() => (
      <CodeBlock
        block={{
          type: "code",
          code: "const flavor = 'pistachio';\nreturn flavor;",
          language: "ts",
          filename: "churn.ts",
        }}
        streaming
      />
    ));

    expect(screen.getByRole("region", { name: "TypeScript code block" })).toBeInTheDocument();
    expect(screen.getByText("churn.ts")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(document.querySelectorAll(".message-code-line-number")).toHaveLength(2);
    expect(document.querySelector(".message-code-caret")).toBeInTheDocument();
    expect(document.querySelectorAll(".message-code-copy-icons svg")).toHaveLength(2);
    expect(document.querySelector('.message-code-copy-icons > span[data-visible="true"]')).toBeInTheDocument();
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
