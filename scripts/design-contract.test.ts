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

const layoutSection = [
  "## Layout",
  "",
  "`--left-header-height: 38px`, and `--server-rail-width` is 64px, and 72px on macOS.",
  "The rail narrows to 56px below 800px of window width.",
  "The left panel is 280px default, 240 min, 400 max, 88 compact, with 210/220 collapse-and-expand hysteresis.",
  "It collapses to its compact 88px rail below the 210px drag threshold and expands again above 220px.",
  "A bubble is `max-width: min(80%, 720px)` and the marker rail is `min(680px, 100%)`.",
  "",
];

const componentsSection = [
  "## Components",
  "",
  "### Inventory",
  "",
  "| Module | Exports |",
  "| --- | --- |",
  "| `button.tsx` | `Button` |",
  "| `icons.ts` | The curated Lucide re-exports |",
  "",
];

const appSource = [
  "const LEFT_PANEL_DEFAULT = 280;",
  "const LEFT_PANEL_MIN = 240;",
  "const LEFT_PANEL_MAX = 400;",
  "const LEFT_PANEL_COMPACT = 88;",
  "const LEFT_PANEL_COLLAPSE_THRESHOLD = 210;",
  "const LEFT_PANEL_EXPAND_THRESHOLD = 220;",
  "",
].join("\n");

const shellSource = [
  ".app-frame {",
  "  --left-header-height: 38px;",
  "  --server-rail-width: 64px;",
  "}",
  "",
  ".app-frame-platform-darwin {",
  "  --server-rail-width: 72px;",
  "}",
  "",
  "@media (max-width: 800px) {",
  "  .app-frame-with-server-rail {",
  "    --server-rail-width: 56px;",
  "  }",
  "}",
  "",
].join("\n");

const paletteSource = [
  ":root {",
  "  --openbot-accent: #6960f1;",
  "  --openbot-radius-md: 8px;",
  "  --openbot-chat-marker-width: min(680px, 100%);",
  "}",
  "",
].join("\n");

const roots: string[] = [];

function designDoc(): string {
  const head = [
    "# OpenBot design",
    "",
    "Focus uses `--openbot-accent` and the `--openbot-shadow-*` family.",
    "",
    "| Token | Value | Use |",
    "| --- | --- | --- |",
    "| `--openbot-radius-md` | `8px` | Default radius |",
    "",
  ];
  const sections = requiredSections.flatMap((section) => {
    if (section === "Layout") return layoutSection;
    if (section === "Components") return componentsSection;
    return [`## ${section}`, ""];
  });
  return [...head, ...sections].join("\n");
}

function compliantRepository(): Map<string, string> {
  return new Map([
    ["design.md", designDoc()],
    ["AGENTS.md", "Read [`design.md`](design.md) before you change any UI.\n"],
    ["src/renderer/src/styles.css", paletteSource],
    ["src/renderer/src/App.tsx", appSource],
    ["src/renderer/src/styles/app-shell.css", shellSource],
    ["src/renderer/src/styles/primitives.css", ".bubble {\n  max-width: min(80%, 720px);\n}\n"],
    ["src/renderer/src/components/ui/index.ts", 'export * from "./button";\nexport * from "./icons";\n'],
    ["src/renderer/src/components/ui/button.tsx", "export const Button = () => null;\n"],
    ["src/renderer/src/components/ui/icons.ts", 'export { default as Check } from "lucide-solid/icons/check";\n'],
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

  it("reports a token whose documented value drifted from the palette", () => {
    const files = compliantRepository();
    files.set(
      "src/renderer/src/styles.css",
      paletteSource.replace("--openbot-radius-md: 8px", "--openbot-radius-md: 10px"),
    );

    expect(checkRepository(files)).toEqual([
      expect.stringContaining("documents --openbot-radius-md as 8px, but src/renderer/src/styles.css declares 10px"),
    ]);
  });

  it("reports a layout number the document still states with its old value", () => {
    const files = compliantRepository();
    files.set("src/renderer/src/App.tsx", appSource.replace("LEFT_PANEL_MAX = 400", "LEFT_PANEL_MAX = 420"));

    expect(checkRepository(files)).toEqual([expect.stringContaining('state "420 max"')]);
  });

  it("reports a pinned value whose source no longer declares it", () => {
    const files = compliantRepository();
    files.set("src/renderer/src/App.tsx", appSource.replace("const LEFT_PANEL_MAX = 400;\n", ""));

    expect(checkRepository(files)).toEqual([expect.stringContaining("no longer declares")]);
  });

  it("reports a barrel module that the component inventory omits", () => {
    const files = compliantRepository();
    files.set("src/renderer/src/components/ui/index.ts", 'export * from "./button";\nexport * from "./tooltip";\n');
    files.set("src/renderer/src/components/ui/tooltip.tsx", "export const Tooltip = () => null;\n");

    expect(checkRepository(files)).toEqual([expect.stringContaining("add `tooltip.tsx` to the component inventory")]);
  });

  it("reports an export that the module's inventory row omits", () => {
    const files = compliantRepository();
    files.set(
      "src/renderer/src/components/ui/button.tsx",
      "export const Button = () => null;\nexport const Toggle = () => null;\n",
    );

    expect(checkRepository(files)).toEqual([
      expect.stringContaining("document `Toggle` in the `button.tsx` row of the component inventory"),
    ]);
  });

  it("reports a local re-export the inventory row omits", () => {
    const files = compliantRepository();
    files.set(
      "src/renderer/src/components/ui/button.tsx",
      "const Button = () => null;\nexport { Button };\nconst press = () => null;\nexport { press };\n",
    );

    expect(checkRepository(files)).toEqual([
      expect.stringContaining("document `press` in the `button.tsx` row of the component inventory"),
    ]);
  });

  it("ignores a bulk re-export module such as the icon barrel", () => {
    const files = compliantRepository();
    files.set(
      "src/renderer/src/components/ui/icons.ts",
      'export { default as Check } from "lucide-solid/icons/check";\nexport { default as X } from "lucide-solid/icons/x";\n',
    );

    expect(checkRepository(files)).toEqual([]);
  });

  it("reports an inventory table the document no longer has", () => {
    const files = compliantRepository();
    files.set("design.md", designDoc().replace("### Inventory", "### Component inventory"));

    expect(checkRepository(files)).toEqual([expect.stringContaining('restore the "### Inventory" table')]);
  });
});
