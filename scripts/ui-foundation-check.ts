import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenBotLogger } from "@openbot/logging";

const logger = createOpenBotLogger("ui-foundation-check");

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const rendererRoot = resolve(projectRoot, "src/renderer/src");
const uiRoot = resolve(rendererRoot, "components/ui");
const failures: string[] = [];

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
  if (file.startsWith(uiRoot) || /\.test\.tsx?$/u.test(file)) continue;
  const source = readFileSync(file, "utf8");
  const label = relative(projectRoot, file);

  if (/<(?:button|input|textarea|select)\b/u.test(source)) {
    failures.push(`${label}: use a components/ui control instead of a native element`);
  }
  if (/from\s+["'](?:@kobalte\/core|lucide-solid)(?:\/[^"']*)?["']/u.test(source)) {
    failures.push(`${label}: Kobalte/Lucide imports are allowed only in components/ui`);
  }
  if (/role=["']switch["']/u.test(source)) {
    failures.push(`${label}: a hand-rolled switch is forbidden; use components/ui/Switch`);
  }
  if (file.endsWith(".tsx")) {
    const inlineColor =
      /(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|fill|stroke)\s*:\s*["'](?:#[\da-f]{3,8}|rgba?\(|hsla?\(|(?:white|black|red|blue|green|yellow|purple|orange|gray|grey|pink)\b)/iu;
    if (inlineColor.test(source)) {
      failures.push(`${label}: a colour literal in an inline style is forbidden; use a palette token`);
    }
    const inlineFoundationValue =
      /["']?(?:font-size|border-radius|transition(?:-duration)?)["']?\s*:\s*["'](?!var\()[^"']+["']/iu;
    if (inlineFoundationValue.test(source)) {
      failures.push(`${label}: font-size, radius and transition in an inline style must use tokens`);
    }
  }
}

const complexApiPath = resolve(uiRoot, "complex.tsx");
const complexApi = readFileSync(complexApiPath, "utf8");
if (/export const \w+\s*=\s*\w+Primitive\s*;/u.test(complexApi)) {
  failures.push("components/ui/complex.tsx: a Kobalte namespace must go through an adapter, not a direct alias");
}

// Every renderer component outside the shared layer, wherever it lives. This
// used to walk `components/` alone, which stopped seeing a component the moment
// it moved into `features/` - the budget stayed at zero by going blind, not by
// being met.
const componentSource = filesUnder(rendererRoot)
  .filter((path) => path.endsWith(".tsx") && !path.startsWith(uiRoot))
  .filter((path) => !path.endsWith(".test.tsx"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const manualCompositeCount = matches(
  componentSource,
  /role=["'](?:dialog|alertdialog|menu|tablist|tab|tabpanel|listbox|option)["']/gu,
);

// The palette moved to @openbot/brand, which is now the only file allowed to hold
// a colour literal, so every stylesheet the renderer owns is scanned whole. This
// used to slice styles.css after its :root block to spare the palette, which also
// spared everything else declared in there. It then named styles.css and styles/
// explicitly, which spared a stylesheet placed anywhere else: preview/preview.css
// was outside the scan and nothing said so, and a feature stylesheet moving next
// to the components it dresses would have left the budget the same silent way.
// The whole renderer tree is the scope, so a new stylesheet is covered by
// existing there rather than by being listed.
const legacyStyles = filesUnder(rendererRoot)
  .filter((path) => path.endsWith(".css"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const colorLiteralCount =
  matches(legacyStyles, /#[\da-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/giu) +
  matches(legacyStyles, /(?<![-\w])(?:white|black|red|blue|green|yellow|purple|orange|gray|grey|pink)(?![-\w])/giu);
const debtBudgets = [
  ["hand-rolled composite ARIA roles", manualCompositeCount, 0],
  ["colour literals outside the palette", colorLiteralCount, 0],
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
  if (actual > maximum) failures.push(`${label}: ${actual} (migration budget: ${maximum}; the count may only go down)`);
}

if (failures.length > 0) {
  logger.error(`UI foundation check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

logger.info(`UI foundation check passed. Legacy composite debt: ${manualCompositeCount}/0.`);
