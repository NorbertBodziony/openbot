import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { buildProductionCatalog, validateSkillMarkdown } from "./build-production-catalog";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production marketplace catalog", () => {
  it("builds deterministic, dependency-free skill bundles", async () => {
    const root = await temporaryRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    await buildProductionCatalog(first);
    await buildProductionCatalog(second);

    await expect(readFile(join(first, "SHA256SUMS"), "utf8")).resolves.toBe(
      await readFile(join(second, "SHA256SUMS"), "utf8"),
    );
    const catalog = await readCatalog(join(first, "catalog.json"));
    const skills = catalog.skills;
    expect(skills).toHaveLength(5);
    for (const value of skills) {
      const bytes = new Uint8Array(await readFile(join(first, value.bundle)));
      expect(Object.keys(unzipSync(bytes)).sort()).toEqual(["LICENSE.txt", "NOTICE.txt", "SKILL.md"]);
      await expect(readFile(join(first, value.bundle))).resolves.toEqual(await readFile(join(second, value.bundle)));
    }
  });

  it("emits agents whose skill references resolve and whose routines are empty", async () => {
    const root = await temporaryRoot();
    const output = join(root, "catalog");
    await buildProductionCatalog(output);
    const catalog = await readCatalog(join(output, "catalog.json"));
    const skillIds = new Set(catalog.skills.map((skill) => skill.id));
    const agents = await readAgents(join(output, "agents.json"));
    expect(agents).toHaveLength(3);
    for (const value of agents) {
      expect(value.routines).toEqual([]);
      for (const skill of value.skills) {
        expect(skillIds.has(skill.skillId)).toBe(true);
      }
    }
  });

  it("rejects instructions that require external dependencies", () => {
    expect(() =>
      validateSkillMarkdown("unsafe", "---\nname: unsafe\ndescription: Unsafe.\n---\nnpm install tool"),
    ).toThrow("forbidden external dependency");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-production-catalog-test-"));
  temporaryRoots.push(root);
  return root;
}

interface GeneratedSkill {
  id: string;
  versionId: string;
  bundle: string;
  slug: string;
}

interface GeneratedAgent {
  routines: [];
  skills: Array<{ skillId: string }>;
}

async function readCatalog(path: string): Promise<{ skills: GeneratedSkill[] }> {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!isDynamicRecord(value) || !Array.isArray(value.skills)) throw new Error("Expected generated skills.");
  return { skills: value.skills.map(parseGeneratedSkill) };
}

function parseGeneratedSkill(value: unknown): GeneratedSkill {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.versionId) ||
    !isString(value.bundle) ||
    !isString(value.slug)
  ) {
    throw new Error("Generated catalog contains an invalid skill.");
  }
  expect(value.versionId).toMatch(/^openbot-curated-version-.+-v1-[a-f0-9]{16}$/u);
  return { id: value.id, versionId: value.versionId, bundle: value.bundle, slug: value.slug };
}

async function readAgents(path: string): Promise<GeneratedAgent[]> {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!isDynamicRecord(value) || !Array.isArray(value.agents)) throw new Error("Expected generated agents.");
  return value.agents.map(parseGeneratedAgent);
}

function parseGeneratedAgent(value: unknown): GeneratedAgent {
  if (!isDynamicRecord(value) || !Array.isArray(value.routines) || value.routines.length !== 0) {
    throw new Error("Generated catalog contains an invalid agent routine list.");
  }
  if (!Array.isArray(value.skills)) throw new Error("Generated catalog contains invalid agent skills.");
  const skills = value.skills.map((skill) => {
    if (!isDynamicRecord(skill) || !isString(skill.skillId)) {
      throw new Error("Generated catalog contains an invalid agent skill.");
    }
    return { skillId: skill.skillId };
  });
  return { routines: [], skills };
}
