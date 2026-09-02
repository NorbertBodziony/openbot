import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Keeps the four places that hold the test policy from drifting apart.
 *
 * The policy deliberately lives in four forms: the prohibitions in AGENTS.md,
 * the positive map in docs/TESTING.md, the grit rules that reject a matcher at
 * commit time, and scripts/test-value-check.ts. Each has a different job, so
 * merging them would lose something - but nothing kept them consistent, and the
 * first thing that rotted was a counted claim ("12 GritQL rules" when there
 * were 17). This check verifies every claim the two documents make that can be
 * verified mechanically: counts, script names, file paths, and config globs.
 *
 * It reads no prose. A claim is checked only where it is a number, a name, or a
 * path, so rewording a document is free and miscounting it is not.
 */

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const failures: string[] = [];

function read(path: string): string {
  return readFileSync(resolve(projectRoot, path), "utf8");
}

const agents = read("AGENTS.md");
const testing = read("docs/TESTING.md");
const biome = read("biome.json");
const vitestConfig = read("vitest.config.ts");
const manifestSchema = z.object({ scripts: z.record(z.string(), z.string()) });
const packageScripts = Object.keys(manifestSchema.parse(JSON.parse(read("package.json"))).scripts);
const documents = [
  { path: "AGENTS.md", source: agents },
  { path: "docs/TESTING.md", source: testing },
] as const;

// 1. The grit rules exist, are registered, and are counted correctly.
const ruleDirectory = "tools/biome/anti-slop/rules";
const ruleFiles = readdirSync(resolve(projectRoot, ruleDirectory)).filter((entry) => entry.endsWith(".grit"));
const registered = [...biome.matchAll(/"\.\/tools\/biome\/anti-slop\/rules\/([a-z-]+\.grit)"/gu)].map(
  (match) => match[1],
);

for (const file of ruleFiles) {
  if (!registered.includes(file)) {
    failures.push(`${ruleDirectory}/${file} nie jest zarejestrowany w biome.json, więc nic nie egzekwuje.`);
  }
}
for (const entry of registered) {
  if (!ruleFiles.includes(entry)) failures.push(`biome.json rejestruje ${entry}, którego nie ma w ${ruleDirectory}.`);
}
if (new Set(registered).size !== registered.length) {
  failures.push("biome.json rejestruje tę samą regułę grit dwa razy.");
}

const citedRuleCount = testing.match(/(\d+) GritQL rules/u)?.[1];
if (citedRuleCount !== undefined && Number(citedRuleCount) !== ruleFiles.length) {
  failures.push(
    `docs/TESTING.md mówi "${citedRuleCount} GritQL rules", a w ${ruleDirectory} jest ${ruleFiles.length}. Popraw dokument, nie licznik.`,
  );
}

// 2. Matchers the policy claims are rejected at commit time really are.
const rejectedMatchers = ["toHaveFocus", "toHaveClass", "toHaveStyle", "toContainElement", "toHaveAttribute"];
const ruleSources = ruleFiles.map((file) => read(`${ruleDirectory}/${file}`)).join("\n");
for (const matcher of rejectedMatchers) {
  if (!agents.includes(matcher)) {
    failures.push(`AGENTS.md nie wymienia już ${matcher}, a reguła grit go odrzuca. Uspójnij listę.`);
  }
  if (!ruleSources.includes(matcher)) {
    failures.push(
      `AGENTS.md obiecuje odrzucanie ${matcher} w commicie, ale żadna reguła w ${ruleDirectory} go nie łapie.`,
    );
  }
}

// 3. Every script and script file the documents name exists.
for (const { path, source } of documents) {
  const named = new Set<string>();
  for (const match of source.matchAll(/bun run ([a-z][a-z0-9:.-]*)/gu)) named.add(match[1]);
  for (const match of source.matchAll(/`(test|check|typecheck|dev):([a-z0-9:.-]+)`/gu))
    named.add(`${match[1]}:${match[2]}`);
  for (const name of named) {
    if (!packageScripts.includes(name)) {
      failures.push(`${path} odsyła do "bun run ${name}", a package.json nie ma takiego skryptu.`);
    }
  }

  for (const match of source.matchAll(/scripts\/[a-z0-9-]+\.ts/gu)) {
    if (!existsSync(resolve(projectRoot, match[0]))) {
      failures.push(`${path} odsyła do ${match[0]}, który nie istnieje.`);
    }
  }
}

// 4. The routing the documents describe is the routing vitest actually uses.
for (const glob of ["src/renderer/**/*.test.ts", "src/renderer/**/*.test.tsx", "*.dom.test.ts"]) {
  if (!vitestConfig.includes(glob)) {
    failures.push(`vitest.config.ts nie zawiera już globu ${glob}, który opisują AGENTS.md i docs/TESTING.md.`);
  }
  for (const { path, source } of documents) {
    if (!source.includes(glob)) failures.push(`${path} nie opisuje globu ${glob} z vitest.config.ts.`);
  }
}

// 5. Counted claims about the typecheck fan-out.
const citedProjects = testing.match(/`bun run typecheck` \((\d+) projects\)/u)?.[1];
const typecheckProjects = packageScripts.filter((name) => name.startsWith("typecheck:")).length;
if (citedProjects !== undefined && Number(citedProjects) !== typecheckProjects) {
  failures.push(
    `docs/TESTING.md mówi o ${citedProjects} projektach typecheck, a package.json ma ${typecheckProjects}.`,
  );
}

if (failures.length > 0) {
  console.error(
    `Policy sync check failed:\n- ${failures.join("\n- ")}\n\nAGENTS.md, docs/TESTING.md, reguły grit i scripts/test-value-check.ts muszą mówić to samo.`,
  );
  process.exit(1);
}

console.log(
  `Policy sync check passed: ${ruleFiles.length} reguł grit zarejestrowanych i policzonych, ${typecheckProjects} projektów typecheck, wszystkie skrypty i globy z AGENTS.md oraz docs/TESTING.md istnieją.`,
);
