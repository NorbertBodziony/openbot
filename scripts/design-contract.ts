import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const designDoc = "design.md";
const agentsDoc = "AGENTS.md";
const paletteFile = "src/renderer/src/styles.css";
const barrelFile = "src/renderer/src/components/ui/index.ts";

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

function declaredPaletteTokens(palette: string): Set<string> {
  const start = palette.indexOf(":root");
  const end = palette.indexOf("\n}\n", start);
  const block = end === -1 ? palette.slice(start) : palette.slice(start, end);
  const declarations = block.match(/--openbot-[a-z0-9-]+(?=\s*:)/gu) ?? [];
  return new Set(declarations);
}

function barrelModules(projectRoot: string, barrel: string): string[] {
  const uiRoot = resolve(projectRoot, "src/renderer/src/components/ui");
  return (barrel.match(/^export \* from "\.\/([a-z0-9-]+)";$/gmu) ?? []).map((line) => {
    const name = line.replace(/^export \* from "\.\//u, "").replace(/";$/u, "");
    return existsSync(resolve(uiRoot, `${name}.tsx`)) ? `${name}.tsx` : `${name}.ts`;
  });
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

  const declared = declaredPaletteTokens(readFileSync(palettePath, "utf8"));

  for (const token of new Set(tokensIn(design))) {
    if (!declared.has(token)) failures.push(`${designDoc}: documents ${token}, which ${paletteFile} does not declare`);
  }

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

  const barrelPath = resolve(projectRoot, barrelFile);
  if (!existsSync(barrelPath)) {
    failures.push(`${barrelFile}: the component barrel is missing`);
    return failures;
  }

  for (const module of barrelModules(projectRoot, readFileSync(barrelPath, "utf8"))) {
    if (!design.includes(`\`${module}\``)) {
      failures.push(`${designDoc}: add \`${module}\` to the component inventory`);
    }
  }

  return failures;
}
