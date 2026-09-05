import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenBotLogger } from "@openbot/logging";

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function matches(source: string, expression: RegExp): number {
  return source.match(expression)?.length ?? 0;
}

export interface UiFoundationReport {
  /** One human-readable line per violation, in the order the tree was walked. */
  readonly failures: readonly string[];
  /** Composite ARIA roles hand-rolled outside `components/ui`. Ratchets down, never up. */
  readonly manualCompositeCount: number;
}

/**
 * Reads a renderer tree and reports every design-system violation in it. Paths in
 * `failures` are relative to `labelRoot`, which the CLI sets to the repository root
 * so a message can be pasted straight into an editor.
 *
 * Takes its roots as arguments rather than resolving them, so the fixture tree in
 * `tools/ui-foundation/fixtures` can prove each check still matches something. Two
 * of these checks silently matched nothing for months.
 */
export function checkUiFoundation(rendererRoot: string, labelRoot: string): UiFoundationReport {
  const uiRoot = resolve(rendererRoot, "components/ui");
  const failures: string[] = [];

  for (const file of filesUnder(rendererRoot).filter((path) => /\.(?:ts|tsx)$/.test(path))) {
    if (file.startsWith(uiRoot) || /\.test\.tsx?$/u.test(file)) continue;
    const source = readFileSync(file, "utf8");
    const label = relative(labelRoot, file);

    if (/<(?:button|input|textarea|select)\b/u.test(source)) {
      failures.push(`${label}: użyj komponentu z components/ui zamiast natywnej kontrolki`);
    }
    if (/from\s+["'](?:@kobalte\/core|lucide-solid)(?:\/[^"']*)?["']/u.test(source)) {
      failures.push(`${label}: import Kobalte/Lucide jest dozwolony wyłącznie w components/ui`);
    }
    if (/role=["']switch["']/u.test(source)) {
      failures.push(`${label}: ręczny switch jest zabroniony; użyj components/ui/Switch`);
    }
    if (file.endsWith(".tsx")) {
      const inlineColor =
        /(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|fill|stroke)\s*:\s*["'](?:#[\da-f]{3,8}|rgba?\(|hsla?\(|(?:white|black|red|blue|green|yellow|purple|orange|gray|grey|pink)\b)/iu;
      if (inlineColor.test(source)) {
        failures.push(`${label}: literał koloru w inline style jest zabroniony; użyj tokenu palety`);
      }
      const inlineFoundationValue =
        /["']?(?:font-size|border-radius|transition(?:-duration)?)["']?\s*:\s*["'](?!var\()[^"']+["']/iu;
      if (inlineFoundationValue.test(source)) {
        failures.push(`${label}: font-size, radius i transition w inline style muszą używać tokenów`);
      }
    }
  }

  const complexApi = readFileSync(resolve(uiRoot, "complex.tsx"), "utf8");
  if (/export const \w+\s*=\s*\w+Primitive\s*;/u.test(complexApi)) {
    failures.push("components/ui/complex.tsx: namespace Kobalte musi przechodzić przez adapter, nie bezpośredni alias");
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

  // The palette moved to @openbot/brand, which is now the only file allowed to hold
  // a colour literal, so every stylesheet the renderer owns is scanned whole. This
  // used to slice styles.css after its :root block to spare the palette, which also
  // spared everything else declared in there. It then named styles.css and styles/
  // explicitly, which spared a stylesheet placed anywhere else - preview/preview.css
  // was outside the scan and nothing said so. The whole renderer tree is the scope,
  // so a new stylesheet is covered by existing there rather than by being listed.
  const legacyStyles = filesUnder(rendererRoot)
    .filter((path) => path.endsWith(".css"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const colorLiteralCount =
    matches(legacyStyles, /#[\da-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/giu) +
    matches(legacyStyles, /(?<![-\w])(?:white|black|red|blue|green|yellow|purple|orange|gray|grey|pink)(?![-\w])/giu);
  const debtBudgets = [
    ["ręczne złożone role ARIA", manualCompositeCount, 0],
    ["literały kolorów poza paletą", colorLiteralCount, 0],
    ["nietokenizowane font-size", matches(legacyStyles, /font-size:(?!\s*(?:var\(|inherit\b))\s*[^;]+/gu), 0],
    [
      "nietokenizowane border-radius",
      matches(legacyStyles, /border-radius:(?!\s*(?:var\(|0(?:\s|;)|inherit\b))\s*[^;]+/gu),
      0,
    ],
    [
      "nietokenizowane czasy transition",
      matches(legacyStyles, /transition(?:-duration)?:(?![^;]*var\()(?!\s*(?:none|0\.01ms))[^;]*\b\d+m?s\b[^;]*/gu),
      0,
    ],
  ] as const;

  for (const [label, actual, maximum] of debtBudgets) {
    if (actual > maximum) failures.push(`${label}: ${actual} (budżet migracyjny: ${maximum}; liczba może tylko maleć)`);
  }

  return { failures, manualCompositeCount };
}

if (import.meta.main) {
  const logger = createOpenBotLogger("ui-foundation-check");
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const { failures, manualCompositeCount } = checkUiFoundation(resolve(projectRoot, "src/renderer/src"), projectRoot);

  if (failures.length > 0) {
    logger.error(`UI foundation check failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }

  logger.info(`UI foundation check passed. Legacy composite debt: ${manualCompositeCount}/0.`);
}
