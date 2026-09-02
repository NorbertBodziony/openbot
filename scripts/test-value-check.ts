import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Enforces the "Test value policy" in AGENTS.md for patterns that grit cannot
 * express, because they also appear legitimately in product code.
 *
 * Two tiers:
 *   - forbidden: a single occurrence in a test fails the check.
 *   - budgets:   today's count is the ceiling, so existing debt keeps working
 *                but nothing new can be added. The numbers may only decrease.
 *
 * Matcher-shaped patterns (toHaveFocus, toHaveClass, toHaveStyle,
 * toContainElement, toHaveAttribute("title", ...)) are blocked earlier, at
 * commit time, by the grit rules in tools/biome/anti-slop/rules.
 */

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const searchRoots = ["src", "apps", "packages", "scripts"];
const skipped = new Set(["node_modules", ".git", "dist", "build", ".openbot-build"]);
const failures: string[] = [];

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (skipped.has(entry)) return [];
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function matches(source: string, expression: RegExp): number {
  return source.match(expression)?.length ?? 0;
}

const forbidden = [
  {
    expression: /document\.activeElement/gu,
    reason: "asercja umiejscowienia fokusu; sprawdź dostępną rolę i nazwę, a fokus pokaż w Storybooku",
  },
  {
    expression: /querySelector(?:All)?(?:<[^>]*>)?\(\s*["'](?:svg|img)["']\s*\)/gu,
    reason: "asercja obecności ikony; sprawdź dostępną nazwę kontrolki, która ikonę zawiera",
  },
  {
    // Only reads: assigning innerHTML to build a DOM fixture is legitimate input.
    expression: /expect\([^)]*\.(?:inner|outer)HTML/gu,
    reason: "asercja na surowym HTML; sprawdź zachowanie albo widoczny tekst",
  },
  {
    expression: /getComputedStyle\(/gu,
    reason: "asercja na wyliczonym stylu; styl i layout należą do Storybooka",
  },
] as const;

/** Today's counts. Lower them when a test stops needing the pattern; never raise them. */
const budgets = [
  { label: "uchwyty po klasie CSS", expression: /querySelector(?:All)?(?:<[^>]*>)?\(\s*["'`]\./gu, maximum: 54 },
  { label: "sięganie po data-testid", expression: /By(?:All)?TestId\(/gu, maximum: 20 },
  { label: "wspinanie się po drzewie przez closest()", expression: /\.closest\(/gu, maximum: 14 },
  { label: "asercje na nazwie znacznika", expression: /\.tagName\b/gu, maximum: 8 },
  {
    label: "liczenie elementów o roli strukturalnej",
    expression: /getAll(?:By)?Role\(\s*["'](?:columnheader|cell|row|list|listitem|group)["']/gu,
    maximum: 7,
  },
  {
    label: "chodzenie po rodzeństwie i rodzicu",
    expression: /\b(?:next|previous)ElementSibling\b|\bparentElement\b|\bfirstElementChild\b/gu,
    maximum: 5,
  },
] as const;

const testFiles = searchRoots
  .flatMap((root) => filesUnder(resolve(projectRoot, root)))
  .filter((path) => /\.test\.tsx?$/.test(path));

const totals = new Map<string, number>(budgets.map((budget) => [budget.label, 0]));

for (const file of testFiles) {
  const source = readFileSync(file, "utf8");
  const label = relative(projectRoot, file);

  for (const { expression, reason } of forbidden) {
    const count = matches(source, expression);
    if (count > 0) failures.push(`${label}: ${count}× ${reason}`);
  }
  for (const { label: budgetLabel, expression } of budgets) {
    totals.set(budgetLabel, (totals.get(budgetLabel) ?? 0) + matches(source, expression));
  }
}

for (const { label, maximum } of budgets) {
  const actual = totals.get(label) ?? 0;
  if (actual > maximum) {
    failures.push(
      `${label}: ${actual} (budżet ${maximum}; liczba może tylko maleć - przepisz test na rolę i dostępną nazwę zamiast dokładać kolejne wystąpienie)`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    `Test value check failed (zobacz "Test value policy" w AGENTS.md):\n- ${failures.join("\n- ")}\n\nTesty mają sprawdzać zachowanie, dane i dostępne role oraz nazwy - nie znaczniki, klasy, layout ani fokus.`,
  );
  process.exit(1);
}

const debt = budgets.map(({ label, maximum }) => `${label}: ${totals.get(label) ?? 0}/${maximum}`).join(", ");
console.log(`Test value check passed across ${testFiles.length} test files. Dług: ${debt}.`);
