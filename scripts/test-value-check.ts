import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Enforces the "Test value policy" in AGENTS.md for patterns that grit cannot
 * express, because they also appear legitimately in product code.
 *
 * Three tiers:
 *   - forbidden: a single occurrence in a test fails the check.
 *   - budgets:   a per-file record of today's debt. A file may keep exactly the
 *                occurrences listed for it and no more; a file that is absent
 *                may not use the pattern at all. The numbers may only decrease,
 *                so debt stays where it is instead of being traded between
 *                files, and the map shows who owes what.
 *   - cases:     the App*.test.tsx family is closed. Its case counts may only
 *                decrease and a new file in the family is refused.
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
  {
    expression: /\b(?:next|previous)ElementSibling\b|\bparentElement\b|\bfirstElementChild\b/gu,
    reason: "chodzenie po rodzeństwie i rodzicu; zapytaj o element przez rolę i dostępną nazwę",
  },
] as const;

interface Budget {
  label: string;
  expression: RegExp;
  files: Record<string, number>;
}

/**
 * Today's debt, per file. Lower an entry when a test stops needing the pattern
 * and delete it when it reaches zero; never raise one, and never add a file.
 * Moving a test to another file means moving its row, not copying it.
 */
const budgets: Budget[] = [
  {
    label: "uchwyty po klasie CSS",
    expression: /querySelector(?:All)?(?:<[^>]*>)?\(\s*["'`]\./gu,
    files: {
      "src/renderer/src/components/Sidebar.test.tsx": 14,
      "src/renderer/src/components/conversation/QueuePanel.test.tsx": 5,
      "src/renderer/src/components/conversation/MessageRendering.test.tsx": 4,
      "src/renderer/src/components/ComposerEditor.test.tsx": 2,
      "src/renderer/src/App.servers.test.tsx": 1,
      "src/renderer/src/DynamicIslandSurface.test.tsx": 1,
      "src/renderer/src/components/OtpInput.test.tsx": 1,
      "src/renderer/src/components/conversation/AgentMemoriesModal.test.tsx": 1,
      "src/renderer/src/components/conversation/RichMessageText.test.tsx": 1,
    },
  },
  {
    label: "sięganie po data-testid",
    expression: /By(?:All)?TestId\(/gu,
    files: {
      "src/renderer/src/components/Conversation.hmr.test.tsx": 9,
      "src/renderer/src/App.test.tsx": 4,
      "src/renderer/src/App.read-state.test.tsx": 3,
      "src/renderer/src/components/conversation/createChatVirtualizer.test.tsx": 2,
    },
  },
  {
    label: "wspinanie się po drzewie przez closest()",
    expression: /\.closest\(/gu,
    files: {
      "src/renderer/src/components/conversation/MessageRendering.test.tsx": 3,
      "src/renderer/src/App.queue.test.tsx": 2,
      "src/renderer/src/components/OpenBotDynamicIsland.test.tsx": 2,
      "src/renderer/src/components/conversation/RichMessageText.test.tsx": 2,
      "src/renderer/src/App.browser.test.tsx": 1,
      "src/renderer/src/components/ComputerUseMacSetup.test.tsx": 1,
      "src/renderer/src/components/conversation/SelectionActions.test.tsx": 1,
      "src/renderer/src/components/ui/dynamic-island.test.tsx": 1,
      "src/renderer/src/components/ui/ui.test.tsx": 1,
    },
  },
  {
    label: "asercje na nazwie znacznika",
    expression: /\.tagName\b/gu,
    files: {
      "src/renderer/src/components/conversation/MessageRendering.test.tsx": 7,
      "src/renderer/src/App.browser.test.tsx": 1,
    },
  },
  {
    label: "liczenie elementów o roli strukturalnej",
    expression: /getAll(?:By)?Role\(\s*["'](?:columnheader|cell|row|list|listitem|group)["']/gu,
    files: {
      "src/renderer/src/components/conversation/MessageRendering.test.tsx": 3,
      "src/renderer/src/components/conversation/ComparisonTable.test.tsx": 2,
      "src/renderer/src/components/conversation/DataTable.test.tsx": 2,
    },
  },
];

/**
 * The App*.test.tsx family is closed to new cases: it is a third of the renderer
 * suite and most of its time, and every rule it protects has a lower boundary.
 * These counts may only decrease, and a new file in the family is refused.
 */
const closedFamily = /^src\/renderer\/src\/App[^/]*\.test\.tsx$/u;
const caseCeilings: Record<string, number> = {
  "src/renderer/src/App.browser.test.tsx": 20,
  "src/renderer/src/App.onboarding.test.tsx": 15,
  "src/renderer/src/App.queue.test.tsx": 21,
  "src/renderer/src/App.read-state.test.tsx": 31,
  "src/renderer/src/App.servers.test.tsx": 20,
  "src/renderer/src/App.settings.test.tsx": 20,
  "src/renderer/src/App.test.tsx": 24,
  "src/renderer/src/App.voice.test.tsx": 9,
};
const caseDeclaration = /^[ \t]*(?:it|test)(?:\.each|\.skip|\.only|\.todo|\.concurrent)?\s*[(<`]/gmu;

const testFiles = searchRoots
  .flatMap((root) => filesUnder(resolve(projectRoot, root)))
  .filter((path) => /\.test\.tsx?$/.test(path))
  .map((path) => relative(projectRoot, path));

const seen = new Set(testFiles);
const counted = new Map<string, Map<string, number>>();

for (const file of testFiles) {
  const source = readFileSync(resolve(projectRoot, file), "utf8");

  for (const { expression, reason } of forbidden) {
    const count = matches(source, expression);
    if (count > 0) failures.push(`${file}: ${count}× ${reason}`);
  }

  for (const { label, expression, files } of budgets) {
    const count = matches(source, expression);
    if (count === 0) continue;
    counted.set(label, (counted.get(label) ?? new Map()).set(file, count));
    const allowed = files[file] ?? 0;
    if (count > allowed) {
      failures.push(
        allowed === 0
          ? `${file}: ${count}× ${label}, a ten plik nie ma na to budżetu. Zapytaj o element przez rolę i dostępną nazwę; jeśli przenosisz istniejący test, przenieś też jego wiersz w scripts/test-value-check.ts (stary wiersz musi zniknąć).`
          : `${file}: ${count}× ${label} przy budżecie ${allowed}. Liczby w scripts/test-value-check.ts mogą tylko maleć.`,
      );
    }
  }

  if (closedFamily.test(file)) {
    const cases = matches(source, caseDeclaration);
    const allowed = caseCeilings[file];
    if (allowed === undefined) {
      failures.push(
        `${file}: rodzina App*.test.tsx jest zamknięta dla nowych plików. Nowe pokrycie idzie do modułu albo do testu komponentu na najniższej stabilnej granicy.`,
      );
    } else if (cases > allowed) {
      failures.push(
        `${file}: ${cases} przypadków przy sufycie ${allowed}. Rodzina App*.test.tsx jest zamknięta dla nowych przypadków - dodaj ten test na najniższej stabilnej granicy.`,
      );
    } else if (cases < allowed) {
      failures.push(
        `${file}: ${cases} przypadków przy sufycie ${allowed}. Obniż wpis w scripts/test-value-check.ts do ${cases}.`,
      );
    }
  }
}

for (const file of Object.keys(caseCeilings)) {
  if (!seen.has(file))
    failures.push(`${file} już nie istnieje; usuń jego sufit przypadków w scripts/test-value-check.ts.`);
}

for (const { label, files } of budgets) {
  const actual = counted.get(label) ?? new Map<string, number>();
  for (const [file, allowed] of Object.entries(files)) {
    const count = actual.get(file) ?? 0;
    if (count < allowed) {
      failures.push(
        count === 0 && !seen.has(file)
          ? `${file} już nie istnieje; usuń jego wiersz "${label}" w scripts/test-value-check.ts.`
          : `${file}: ${count}× ${label} przy budżecie ${allowed}. Obniż wiersz w scripts/test-value-check.ts do ${count === 0 ? "zera i usuń go" : count}.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(
    `Test value check failed (zobacz "Test value policy" w AGENTS.md):\n- ${failures.join("\n- ")}\n\nTesty mają sprawdzać zachowanie, dane i dostępne role oraz nazwy - nie znaczniki, klasy, layout ani fokus.`,
  );
  process.exit(1);
}

const debt = budgets
  .map(({ label, files }) => {
    const entries = Object.values(files);
    return `${label}: ${entries.reduce((sum, count) => sum + count, 0)} w ${entries.length} plikach`;
  })
  .join(", ");
const cases = Object.values(caseCeilings).reduce((sum, count) => sum + count, 0);
console.log(
  `Test value check passed across ${testFiles.length} test files. Dług: ${debt}. Rodzina App*.test.tsx: ${cases} przypadków w ${Object.keys(caseCeilings).length} plikach.`,
);
