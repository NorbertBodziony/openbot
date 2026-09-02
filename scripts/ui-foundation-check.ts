import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectDesignContractFailures } from "./design-contract";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const rendererRoot = resolve(projectRoot, "src/renderer/src");
const uiRoot = resolve(rendererRoot, "components/ui");
const failures: string[] = collectDesignContractFailures(projectRoot);

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function matches(source: string, expression: RegExp): number {
  return source.match(expression)?.length ?? 0;
}

for (const file of filesUnder(rendererRoot).filter((path) => /\.(?:ts|tsx)$/.test(path))) {
  if (file.startsWith(uiRoot) || file.endsWith(".test.tsx")) continue;
  const source = readFileSync(file, "utf8");
  const label = relative(projectRoot, file);

  if (/<(?:button|input|textarea|select)\b/u.test(source)) {
    failures.push(`${label}: use a components/ui component instead of a native control`);
  }
  if (/from\s+["'](?:@kobalte\/core|lucide-solid)(?:\/[^"']*)?["']/u.test(source)) {
    failures.push(`${label}: Kobalte and Lucide may only be imported inside components/ui`);
  }
  if (/role=["']switch["']/u.test(source)) {
    failures.push(`${label}: a hand-built switch is forbidden; use components/ui/Switch`);
  }
  if (file.endsWith(".tsx")) {
    const inlineColor =
      /(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|fill|stroke)\s*:\s*["'](?:#[\da-f]{3,8}|rgba?\(|hsla?\(|(?:white|black|red|blue|green|yellow|purple|orange|gray|grey|pink)\b)/iu;
    if (inlineColor.test(source)) {
      failures.push(`${label}: a color literal in an inline style is forbidden; use a palette token`);
    }
    const inlineFoundationValue =
      /["']?(?:font-size|border-radius|transition(?:-duration)?)["']?\s*:\s*["'](?!var\()[^"']+["']/iu;
    if (inlineFoundationValue.test(source)) {
      failures.push(`${label}: font-size, border-radius and transition in an inline style must use tokens`);
    }
  }
}

const complexApiPath = resolve(uiRoot, "complex.tsx");
const complexApi = readFileSync(complexApiPath, "utf8");
if (/export const \w+\s*=\s*\w+Primitive\s*;/u.test(complexApi)) {
  failures.push("components/ui/complex.tsx: a Kobalte namespace must go through an adapter, not a direct alias");
}

const componentSource = filesUnder(resolve(rendererRoot, "components"))
  .filter((path) => path.endsWith(".tsx") && !path.startsWith(uiRoot))
  .filter((path) => !path.endsWith(".test.tsx"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const manualCompositeCount = matches(
  componentSource,
  /role=["'](?:dialog|alertdialog|menu|tablist|tab|tabpanel|listbox|option)["']/gu,
);

const stylesPath = resolve(rendererRoot, "styles.css");
const styles = readFileSync(stylesPath, "utf8");
const paletteEnd = styles.indexOf("\n}\n", styles.indexOf(":root"));
const featureStyles = filesUnder(resolve(rendererRoot, "styles"))
  .filter((path) => path.endsWith(".css"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const legacyStyles = `${styles.slice(paletteEnd + 3)}\n${featureStyles}`;
const colorLiteralCount =
  matches(legacyStyles, /#[\da-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/giu) +
  matches(legacyStyles, /(?<![-\w])(?:white|black|red|blue|green|yellow|purple|orange|gray|grey|pink)(?![-\w])/giu);
const debtBudgets = [
  ["hand-built composite ARIA roles", manualCompositeCount, 0],
  ["color literals outside the palette", colorLiteralCount, 0],
  ["untokenized font-size", matches(legacyStyles, /font-size:(?!\s*(?:var\(|inherit\b))\s*[^;]+/gu), 0],
  [
    "untokenized border-radius",
    matches(legacyStyles, /border-radius:(?!\s*(?:var\(|0(?:\s|;)|inherit\b))\s*[^;]+/gu),
    0,
  ],
  [
    "untokenized transition durations",
    matches(legacyStyles, /transition(?:-duration)?:(?![^;]*var\()(?!\s*(?:none|0\.01ms))[^;]*\b\d+m?s\b[^;]*/gu),
    0,
  ],
] as const;

for (const [label, actual, maximum] of debtBudgets) {
  if (actual > maximum) failures.push(`${label}: ${actual} (migration budget: ${maximum}; this count may only fall)`);
}

if (failures.length > 0) {
  console.error(`UI foundation check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(`UI foundation check passed. Legacy composite debt: ${manualCompositeCount}/0.`);
