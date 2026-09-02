import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const designDoc = "design.md";
const agentsDoc = "AGENTS.md";
const paletteFile = "src/renderer/src/styles.css";
const barrelFile = "src/renderer/src/components/ui/index.ts";
const appFile = "src/renderer/src/App.tsx";
const shellFile = "src/renderer/src/styles/app-shell.css";
const primitivesFile = "src/renderer/src/styles/primitives.css";
const inventoryHeading = "### Inventory";

// design.md is a contract only while it still covers the areas the issue tracker and reviewers rely on.
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

// Directories whose CSS and TSX must only reference tokens the renderer palette actually declares.
const tokenConsumers = ["src/renderer", ".storybook", "packages/brand/src"];

const tokenPattern = /--openbot-[a-z0-9*-]+/gu;

// Table cells pair a token with the value the document claims for it, twice per row in the typography table.
const tokenRowPattern = /`(--openbot-[a-z0-9-]+)`\s*\|\s*([^|]+?)\s*\|/gu;

// Rows whose value cell is prose ("72% white", "16% / 34% accent") describe a role and cannot be compared.
const literalValuePattern = /^(?:#[0-9a-f]{3,8}|-?\d+(?:\.\d+)?(?:px|ms|em|rem)?|rgba?\([^)]*\)|oklch\([^)]*\))$/iu;

const exportPattern = /^export (?:const|function|class) ([A-Za-z][A-Za-z0-9_]*)/gmu;

/**
 * Numbers design.md states in prose while the code owns them as a named constant or declaration.
 * The expected wording is derived from the live value, so changing the constant fails the stale sentence.
 */
const pinnedClaims: { file: string; pattern: RegExp; phrase: (...values: string[]) => string }[] = [
  { file: appFile, pattern: /LEFT_PANEL_DEFAULT = (\d+)/u, phrase: (value) => `${value}px default` },
  { file: appFile, pattern: /LEFT_PANEL_MIN = (\d+)/u, phrase: (value) => `${value} min` },
  { file: appFile, pattern: /LEFT_PANEL_MAX = (\d+)/u, phrase: (value) => `${value} max` },
  { file: appFile, pattern: /LEFT_PANEL_COMPACT = (\d+)/u, phrase: (value) => `${value} compact` },
  { file: appFile, pattern: /LEFT_PANEL_COMPACT = (\d+)/u, phrase: (value) => `compact ${value}px rail` },
  {
    file: appFile,
    pattern: /LEFT_PANEL_COLLAPSE_THRESHOLD = (\d+)[\s\S]*?LEFT_PANEL_EXPAND_THRESHOLD = (\d+)/u,
    phrase: (collapse, expand) => `${collapse}/${expand} collapse-and-expand`,
  },
  { file: appFile, pattern: /LEFT_PANEL_COLLAPSE_THRESHOLD = (\d+)/u, phrase: (value) => `${value}px drag threshold` },
  { file: appFile, pattern: /LEFT_PANEL_EXPAND_THRESHOLD = (\d+)/u, phrase: (value) => `above ${value}px` },
  {
    file: shellFile,
    pattern: /--left-header-height:\s*(\d+px)/u,
    phrase: (value) => `\`--left-header-height: ${value}\``,
  },
  { file: shellFile, pattern: /^\s*--server-rail-width:\s*(\d+px)/mu, phrase: (value) => `is ${value}` },
  {
    file: shellFile,
    pattern: /\.app-frame-platform-darwin\s*\{\s*--server-rail-width:\s*(\d+px)/u,
    phrase: (value) => `${value} on macOS`,
  },
  {
    file: shellFile,
    pattern: /@media \(max-width: (\d+px)\) \{\s*\.app-frame-with-server-rail\s*\{\s*--server-rail-width:\s*(\d+px)/u,
    phrase: (breakpoint, width) => `narrows to ${width} below ${breakpoint}`,
  },
  {
    file: primitivesFile,
    pattern: /max-width:\s*(min\(80%,\s*\d+px\))/u,
    phrase: (value) => `\`max-width: ${value}\``,
  },
  {
    file: paletteFile,
    pattern: /--openbot-chat-marker-width:\s*([^;]+);/u,
    phrase: (value) => `\`${value.trim()}\``,
  },
];

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function tokensIn(source: string): string[] {
  // Wildcard mentions such as `--openbot-file-*` name a family, not a token, so they cannot be resolved.
  return (source.match(tokenPattern) ?? []).filter((token) => !token.includes("*") && !token.endsWith("-"));
}

function paletteBlock(palette: string): string {
  const start = palette.indexOf(":root");
  const end = palette.indexOf("\n}\n", start);
  return end === -1 ? palette.slice(start) : palette.slice(start, end);
}

function declaredPaletteTokens(palette: string): Set<string> {
  const declarations = paletteBlock(palette).match(/--openbot-[a-z0-9-]+(?=\s*:)/gu) ?? [];
  return new Set(declarations);
}

function declaredPaletteValues(palette: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of paletteBlock(palette).split("\n")) {
    const declaration = line.match(/(--openbot-[a-z0-9-]+)\s*:\s*([^;]+);/u);
    if (declaration) values.set(declaration[1], declaration[2].trim());
  }
  return values;
}

function inventorySection(design: string): string {
  const start = design.indexOf(inventoryHeading);
  if (start === -1) return "";
  const rest = design.slice(start + inventoryHeading.length);
  const nextHeading = rest.search(/^#{2,4} /mu);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function barrelModules(projectRoot: string, barrel: string): { file: string; exports: string[] }[] {
  const uiRoot = resolve(projectRoot, "src/renderer/src/components/ui");
  return (barrel.match(/^export \* from "\.\/([a-z0-9-]+)";$/gmu) ?? []).map((line) => {
    const name = line.replace(/^export \* from "\.\//u, "").replace(/";$/u, "");
    const tsx = resolve(uiRoot, `${name}.tsx`);
    const path = existsSync(tsx) ? tsx : resolve(uiRoot, `${name}.ts`);
    const source = existsSync(path) ? readFileSync(path, "utf8") : "";
    // Only declarations authored here are inventory material; `icons.ts` re-exports Lucide wholesale.
    const exports = [...source.matchAll(exportPattern)].map((match) => match[1]);
    return { file: relative(uiRoot, path), exports };
  });
}

function normalizeValue(value: string): string {
  return value.replace(/`/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function collectTokenValueFailures(design: string, palette: Map<string, string>): string[] {
  const failures: string[] = [];
  for (const line of design.split("\n")) {
    if (!line.startsWith("| `--openbot-")) continue;
    for (const [, token, cell] of line.matchAll(tokenRowPattern)) {
      const stated = normalizeValue(cell);
      if (!literalValuePattern.test(stated)) continue;
      const live = palette.get(token);
      if (live === undefined) continue;
      const declared = normalizeValue(live);
      if (declared === stated || declared === `${stated}px`) continue;
      failures.push(`${designDoc}: documents ${token} as ${stated}, but ${paletteFile} declares ${declared}`);
    }
  }
  return failures;
}

function collectPinnedClaimFailures(projectRoot: string, design: string): string[] {
  const failures: string[] = [];
  const sources = new Map<string, string>();

  for (const claim of pinnedClaims) {
    if (!sources.has(claim.file)) {
      const path = resolve(projectRoot, claim.file);
      sources.set(claim.file, existsSync(path) ? readFileSync(path, "utf8") : "");
    }

    const match = (sources.get(claim.file) ?? "").match(claim.pattern);
    if (!match) {
      failures.push(
        `${claim.file}: ${designDoc} quotes a value this file no longer declares (${claim.pattern.source})`,
      );
      continue;
    }

    const phrase = claim.phrase(...match.slice(1));
    if (!design.includes(phrase)) {
      failures.push(`${designDoc}: state "${phrase}" — the value ${claim.file} now declares`);
    }
  }

  return failures;
}

/**
 * Verifies that `design.md` exists, is discoverable, and still agrees with the code it describes.
 * Returns one message per violation so callers can merge them into a single report.
 */
export function collectDesignContractFailures(projectRoot: string): string[] {
  const failures: string[] = [];
  const designPath = resolve(projectRoot, designDoc);

  if (!existsSync(designPath)) {
    return [`${designDoc}: the design contract is missing from the repository root`];
  }

  const design = readFileSync(designPath, "utf8");

  for (const section of requiredSections) {
    const heading = new RegExp(`^#{2,3} ${section}$`, "mu");
    if (!heading.test(design)) failures.push(`${designDoc}: the "${section}" section is missing`);
  }

  const agentsPath = resolve(projectRoot, agentsDoc);
  if (!existsSync(agentsPath)) {
    failures.push(`${agentsDoc}: repository guidance is missing, so ${designDoc} cannot be discovered`);
  } else if (!readFileSync(agentsPath, "utf8").includes(designDoc)) {
    failures.push(`${agentsDoc}: link ${designDoc} so agents are told to read it before UI work`);
  }

  const palettePath = resolve(projectRoot, paletteFile);
  if (!existsSync(palettePath)) {
    failures.push(`${paletteFile}: the renderer palette is missing`);
    return failures;
  }

  const palette = readFileSync(palettePath, "utf8");
  const declared = declaredPaletteTokens(palette);

  for (const token of new Set(tokensIn(design))) {
    if (!declared.has(token)) failures.push(`${designDoc}: documents ${token}, which ${paletteFile} does not declare`);
  }

  failures.push(...collectTokenValueFailures(design, declaredPaletteValues(palette)));

  for (const consumer of tokenConsumers) {
    const directory = resolve(projectRoot, consumer);
    if (!existsSync(directory)) continue;
    for (const file of filesUnder(directory).filter((path) => /\.(?:css|ts|tsx)$/u.test(path))) {
      const label = relative(projectRoot, file);
      for (const token of new Set(tokensIn(readFileSync(file, "utf8")))) {
        if (!declared.has(token)) failures.push(`${label}: uses ${token}, which ${paletteFile} does not declare`);
      }
    }
  }

  failures.push(...collectPinnedClaimFailures(projectRoot, design));

  const barrelPath = resolve(projectRoot, barrelFile);
  if (!existsSync(barrelPath)) {
    failures.push(`${barrelFile}: the component barrel is missing`);
    return failures;
  }

  const inventory = inventorySection(design);
  if (inventory === "") {
    failures.push(`${designDoc}: restore the "${inventoryHeading}" table that lists every component module`);
    return failures;
  }

  for (const { file, exports } of barrelModules(projectRoot, readFileSync(barrelPath, "utf8"))) {
    const row = inventory.split("\n").find((line) => line.includes(`\`${file}\``));
    if (row === undefined) {
      failures.push(`${designDoc}: add \`${file}\` to the component inventory`);
      continue;
    }
    for (const name of exports) {
      if (!row.includes(`\`${name}\``)) {
        failures.push(`${designDoc}: document \`${name}\` in the \`${file}\` row of the component inventory`);
      }
    }
  }

  return failures;
}
