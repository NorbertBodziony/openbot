import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectDesignContractFailures } from "./design-contract";

const requiredSections = [
  "Tokens",
  "Motion",
  "Layout",
  "Components",
  "Interaction states",
  "Responsive behavior",
  "Accessibility",
  "Do and don't",
  "Platforms",
  "Verification",
  "Maintaining this document",
];

const roots: string[] = [];

function designDoc(): string {
  const inventory = ["| Module | Exports |", "| --- | --- |", "| `button.tsx` | `Button` |", "| `icons.ts` | icons |"];
  const body = ["# OpenBot design", "", "Focus uses `--openbot-accent` and the `--openbot-shadow-*` family.", ""];
  return [...body, ...inventory, "", ...requiredSections.map((section) => `## ${section}\n`)].join("\n");
}

function compliantRepository(): Map<string, string> {
  return new Map([
    ["design.md", designDoc()],
    ["AGENTS.md", "Read [`design.md`](design.md) before you change any UI.\n"],
    ["src/renderer/src/styles.css", ":root {\n  --openbot-accent: #6960f1;\n}\n"],
    ["src/renderer/src/components/ui/index.ts", 'export * from "./button";\nexport * from "./icons";\n'],
    ["src/renderer/src/components/ui/button.tsx", "export const Button = () => null;\n"],
    ["src/renderer/src/components/ui/icons.ts", "export const icons = {};\n"],
  ]);
}

function checkRepository(files: Map<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "design-contract-"));
  roots.push(root);
  for (const [path, content] of files) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return collectDesignContractFailures(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("design contract", () => {
  it("accepts a repository whose document, palette, and component barrel agree", () => {
    expect(checkRepository(compliantRepository())).toEqual([]);
  });

  it("reports a missing design document instead of checking anything else", () => {
    const files = compliantRepository();
    files.delete("design.md");

    const failures = checkRepository(files);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("missing from the repository root");
  });

  it("reports a design document that repository guidance never links", () => {
    const files = compliantRepository();
    files.set("AGENTS.md", "Use bun run dev for renderer work.\n");

    expect(checkRepository(files)).toEqual([expect.stringContaining("link design.md")]);
  });

  it("reports a required section that the document dropped", () => {
    const files = compliantRepository();
    files.set("design.md", designDoc().replace("## Accessibility\n", ""));

    expect(checkRepository(files)).toEqual([expect.stringContaining('"Accessibility" section is missing')]);
  });

  it("reports a token the document describes but the palette does not declare", () => {
    const files = compliantRepository();
    files.set("design.md", `${designDoc()}\nSurfaces use \`--openbot-bg-imaginary\`.\n`);

    expect(checkRepository(files)).toEqual([expect.stringContaining("documents --openbot-bg-imaginary")]);
  });

  it("reports a stylesheet that uses a token the palette does not declare", () => {
    const files = compliantRepository();
    files.set("src/renderer/src/styles/feature.css", ".feature {\n  gap: var(--openbot-space-5);\n}\n");

    const failures = checkRepository(files);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("uses --openbot-space-5");
  });

  it("reports a barrel module that the component inventory omits", () => {
    const files = compliantRepository();
    files.set("src/renderer/src/components/ui/index.ts", 'export * from "./button";\nexport * from "./tooltip";\n');
    files.set("src/renderer/src/components/ui/tooltip.tsx", "export const Tooltip = () => null;\n");

    expect(checkRepository(files)).toEqual([expect.stringContaining("add `tooltip.tsx` to the component inventory")]);
  });
});
