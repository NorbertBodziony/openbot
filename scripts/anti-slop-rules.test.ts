import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A GritQL pattern that matches nothing fails silently: the rule is registered,
// the check is green, and nothing is enforced. Twice already a rule has been
// blind to a whole spelling of what it claims to reject - `new Promise<void>`
// for the sleep rule, `querySelector<HTMLElement>` for the class-selector rule.
// So every rule owns a fixture that proves both halves: the lines it must
// reject, marked `// flag`, and the neighbouring correct code it must not.

const repositoryRoot = resolve(import.meta.dirname, "..");
const rulesDirectory = join(repositoryRoot, "tools/biome/anti-slop/rules");
const fixturesDirectory = join(repositoryRoot, "tools/biome/anti-slop/fixtures");
const biomeBinary = join(repositoryRoot, "node_modules/.bin/biome");

const ruleNames = readdirSync(rulesDirectory)
  .filter((entry) => entry.endsWith(".grit"))
  .map((entry) => entry.replace(/\.grit$/, ""))
  .sort();

interface BiomeConfig {
  readonly plugins?: readonly string[];
  readonly overrides?: readonly { readonly plugins?: readonly string[] }[];
}

const biomeConfig: BiomeConfig = JSON.parse(readFileSync(join(repositoryRoot, "biome.json"), "utf8"));

function ruleNamesIn(plugins: readonly string[] | undefined): readonly string[] {
  return (plugins ?? []).map((path) => path.replace(/^.*\//, "").replace(/\.grit$/, "")).sort();
}

const globalRules = ruleNamesIn(biomeConfig.plugins);
const testOnlyRules = ruleNamesIn(biomeConfig.overrides?.flatMap((override) => override.plugins ?? []));

function ruleSource(rule: string): string {
  return readFileSync(join(rulesDirectory, `${rule}.grit`), "utf8");
}

function declaredSeverity(rule: string): string {
  const declared = ruleSource(rule).match(/severity="([a-z]+)"/)?.[1];
  if (!declared) throw new Error(`${rule} declares no severity.`);
  return declared === "warn" ? "warning" : declared;
}

function fixtureLines(rule: string): { readonly source: string; readonly expected: readonly number[] } {
  const source = readFileSync(join(fixturesDirectory, `${rule}.fixture.ts`), "utf8");
  const expected = source
    .split("\n")
    .map((line, index) => (line.trimEnd().endsWith("// flag") ? index + 1 : 0))
    .filter((line) => line > 0);
  return { source, expected };
}

interface BiomeDiagnostic {
  readonly category: string;
  readonly severity: string;
  readonly message: string;
  readonly location?: { readonly start?: { readonly line?: number } };
}

function runRule(rule: string, source: string): readonly BiomeDiagnostic[] {
  const workspace = mkdtempSync(join(tmpdir(), "anti-slop-"));
  writeFileSync(
    join(workspace, "biome.json"),
    JSON.stringify({
      plugins: [join(rulesDirectory, `${rule}.grit`)],
      linter: { enabled: true, rules: { recommended: false } },
      formatter: { enabled: false },
      assist: { enabled: false },
    }),
  );
  const fixture = join(workspace, "fixture.ts");
  writeFileSync(fixture, source);
  const result = spawnSync(biomeBinary, ["check", fixture, `--config-path=${workspace}`, "--reporter=json"], {
    encoding: "utf8",
  });
  const report: { readonly diagnostics?: readonly BiomeDiagnostic[] } = JSON.parse(result.stdout);
  return (report.diagnostics ?? []).filter((diagnostic) => diagnostic.category === "plugin");
}

describe("anti-slop rules", () => {
  it("registers every rule on disk and nothing that is missing from it", () => {
    const registered = [...readFileSync(join(repositoryRoot, "biome.json"), "utf8").matchAll(/rules\/([a-z-]+)\.grit/g)]
      .map((match) => match[1])
      .sort();
    expect(registered).toEqual(ruleNames);
  });

  it("gives every rule a fixture", () => {
    const fixtures = readdirSync(fixturesDirectory)
      .filter((entry) => entry.endsWith(".fixture.ts"))
      .map((entry) => entry.replace(/\.fixture\.ts$/, ""))
      .sort();
    expect(fixtures).toEqual(ruleNames);
  });

  it("keeps the skill's bundled copy identical to the rules in this repository", () => {
    // The skill installs these into other repositories. A stale bundle would
    // ship deleted rules and a plugin list pointing at files that do not exist.
    const bundleDirectory = join(repositoryRoot, ".agents/skills/biome-anti-slop/assets/anti-slop");
    const bundled = (directory: string) => readdirSync(join(bundleDirectory, directory)).sort();

    expect(bundled("rules")).toEqual(readdirSync(rulesDirectory).sort());
    expect(bundled("fixtures")).toEqual(readdirSync(fixturesDirectory).sort());

    const drifted = bundled("rules").filter(
      (entry) =>
        readFileSync(join(bundleDirectory, "rules", entry), "utf8") !==
        readFileSync(join(rulesDirectory, entry), "utf8"),
    );
    expect(drifted).toEqual([]);
  });

  it("registers every rule in the list its own scope line names", () => {
    // The rule states where it belongs, so neither biome.json nor the skill has
    // to keep a second list that remembers it.
    const declaredScope = (rule: string) => /^\/\/ scope: (global|tests)$/m.exec(ruleSource(rule))?.[1];
    const misplaced = ruleNames.filter((rule) =>
      declaredScope(rule) === "tests" ? !testOnlyRules.includes(rule) : !globalRules.includes(rule),
    );

    expect(ruleNames.filter((rule) => declaredScope(rule) === undefined)).toEqual([]);
    expect(misplaced).toEqual([]);
  });

  it.each(ruleNames)("%s rejects the lines its fixture marks, and only those", (rule) => {
    const { source, expected } = fixtureLines(rule);
    expect(expected.length).toBeGreaterThan(0);

    const diagnostics = runRule(rule, source);

    // A malformed pattern is reported as a diagnostic rather than a failure, so
    // without this the rule reads as "matched nothing" instead of "is broken".
    expect(diagnostics.filter((diagnostic) => diagnostic.message.includes("errored"))).toEqual([]);
    const flagged = diagnostics.flatMap((diagnostic) => {
      const line = diagnostic.location?.start?.line;
      return line === undefined ? [] : [line];
    });
    expect([...new Set(flagged)].sort((first, second) => first - second)).toEqual(expected);
    expect([...new Set(diagnostics.map((diagnostic) => diagnostic.severity))]).toEqual([declaredSeverity(rule)]);
  });
});
