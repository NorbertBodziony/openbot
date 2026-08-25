import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillCategory } from "@openbot/contracts/ipc";
import { zipSync } from "fflate";

interface SeedSkill {
  slug: string;
  name: string;
  description: string;
  category: SkillCategory;
  creator: "ada" | "linus" | "grace" | "margaret" | "alan" | "katherine" | "donald" | "barbara";
  instructions: string;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const authApiRoot = join(projectRoot, "apps", "auth-api");
const wrangler = join(authApiRoot, "node_modules", ".bin", "wrangler");
const localSkillsBucket = "openbot-skills-test";
const encoder = new TextEncoder();
const seededAt = Date.parse("2026-08-25T10:00:00.000Z");

const creators = {
  ada: {
    id: "seed-skills-ada",
    subject: "seed-skills-ada",
    email: "ada.skills@openbot.local",
    name: "Ada",
  },
  linus: {
    id: "seed-skills-linus",
    subject: "seed-skills-linus",
    email: "linus.skills@openbot.local",
    name: "Linus",
  },
  grace: {
    id: "seed-skills-grace",
    subject: "seed-skills-grace",
    email: "grace.skills@openbot.local",
    name: "Grace",
  },
  margaret: {
    id: "seed-skills-margaret",
    subject: "seed-skills-margaret",
    email: "margaret.skills@openbot.local",
    name: "Margaret",
  },
  alan: {
    id: "seed-skills-alan",
    subject: "seed-skills-alan",
    email: "alan.skills@openbot.local",
    name: "Alan",
  },
  katherine: {
    id: "seed-skills-katherine",
    subject: "seed-skills-katherine",
    email: "katherine.skills@openbot.local",
    name: "Katherine",
  },
  donald: {
    id: "seed-skills-donald",
    subject: "seed-skills-donald",
    email: "donald.skills@openbot.local",
    name: "Donald",
  },
  barbara: {
    id: "seed-skills-barbara",
    subject: "seed-skills-barbara",
    email: "barbara.skills@openbot.local",
    name: "Barbara",
  },
} as const;

const skills: SeedSkill[] = [
  {
    slug: "release-notes",
    name: "Release Notes",
    description: "Turn merged work into concise, customer-ready release notes.",
    category: "documents",
    creator: "ada",
    instructions: "Summarize completed work by audience impact. Group related changes and avoid implementation jargon.",
  },
  {
    slug: "research-brief",
    name: "Research Brief",
    description: "Synthesize reliable sources into a decision-ready research brief.",
    category: "research",
    creator: "ada",
    instructions:
      "State the question, cite evidence, separate facts from inference, and finish with unresolved questions.",
  },
  {
    slug: "meeting-follow-up",
    name: "Meeting Follow-up",
    description: "Convert meeting notes into decisions, owners, and next actions.",
    category: "productivity",
    creator: "ada",
    instructions: "Extract decisions first, then list actions with one owner and a concrete due date when available.",
  },
  {
    slug: "design-critique",
    name: "Design Critique",
    description: "Review interface work for hierarchy, clarity, accessibility, and polish.",
    category: "design",
    creator: "ada",
    instructions: "Prioritize findings by user impact. Describe the observed issue, recommended change, and rationale.",
  },
  {
    slug: "document-summarizer",
    name: "Document Summarizer",
    description: "Create structured summaries of long documents without losing key caveats.",
    category: "documents",
    creator: "ada",
    instructions: "Preserve numbers, constraints, and dissenting views. Use headings and end with the main takeaways.",
  },
  {
    slug: "code-reviewer",
    name: "Code Reviewer",
    description: "Review code changes for correctness, regressions, security, and missing tests.",
    category: "coding",
    creator: "linus",
    instructions: "Inspect the diff and surrounding code. Report concrete findings with file locations and severity.",
  },
  {
    slug: "data-explorer",
    name: "Data Explorer",
    description: "Inspect datasets, test assumptions, and explain meaningful patterns.",
    category: "data-analytics",
    creator: "linus",
    instructions: "Validate types and missing values before analysis. Quantify findings and note uncertainty.",
  },
  {
    slug: "browser-automation",
    name: "Browser Automation",
    description: "Plan reliable browser workflows with explicit checks and recovery steps.",
    category: "automation",
    creator: "linus",
    instructions: "Describe each interaction, its success condition, and a safe fallback when the page differs.",
  },
  {
    slug: "sprint-planner",
    name: "Sprint Planner",
    description: "Turn product goals into scoped work with dependencies and acceptance criteria.",
    category: "productivity",
    creator: "linus",
    instructions:
      "Split work into independently verifiable tasks. Call out dependencies, risks, and acceptance criteria.",
  },
  {
    slug: "incident-analyst",
    name: "Incident Analyst",
    description: "Build evidence-based incident timelines and identify corrective actions.",
    category: "other",
    creator: "linus",
    instructions:
      "Separate observations from hypotheses. Build a timestamped timeline and link actions to root causes.",
  },
];

const supplementalSkills: Array<Omit<SeedSkill, "creator" | "instructions">> = [
  {
    slug: "test-writer",
    name: "Test Writer",
    description: "Generate focused tests from code behavior and risk.",
    category: "coding",
  },
  {
    slug: "api-designer",
    name: "API Designer",
    description: "Design consistent APIs with clear contracts and failure modes.",
    category: "coding",
  },
  {
    slug: "debugging-guide",
    name: "Debugging Guide",
    description: "Trace software failures from symptoms to verified root causes.",
    category: "coding",
  },
  {
    slug: "migration-planner",
    name: "Migration Planner",
    description: "Plan safe technical migrations with checkpoints and rollback paths.",
    category: "coding",
  },
  {
    slug: "accessibility-reviewer",
    name: "Accessibility Reviewer",
    description: "Audit interfaces for keyboard, screen reader, and contrast issues.",
    category: "design",
  },
  {
    slug: "design-system-guide",
    name: "Design System Guide",
    description: "Turn interface patterns into reusable design system guidance.",
    category: "design",
  },
  {
    slug: "ux-copy-editor",
    name: "UX Copy Editor",
    description: "Improve product copy for clarity, consistency, and actionability.",
    category: "design",
  },
  {
    slug: "layout-advisor",
    name: "Layout Advisor",
    description: "Evaluate responsive layouts, spacing, density, and visual hierarchy.",
    category: "design",
  },
  {
    slug: "sql-analyst",
    name: "SQL Analyst",
    description: "Draft and review SQL for accurate, explainable analysis.",
    category: "data-analytics",
  },
  {
    slug: "chart-critic",
    name: "Chart Critic",
    description: "Choose and critique charts based on the question and data shape.",
    category: "data-analytics",
  },
  {
    slug: "experiment-reader",
    name: "Experiment Reader",
    description: "Interpret product experiments without overstating their evidence.",
    category: "data-analytics",
  },
  {
    slug: "metric-designer",
    name: "Metric Designer",
    description: "Define useful product metrics with explicit assumptions and guardrails.",
    category: "data-analytics",
  },
  {
    slug: "proposal-writer",
    name: "Proposal Writer",
    description: "Structure persuasive proposals around outcomes, evidence, and scope.",
    category: "documents",
  },
  {
    slug: "policy-editor",
    name: "Policy Editor",
    description: "Rewrite policies into precise, readable, and testable requirements.",
    category: "documents",
  },
  {
    slug: "technical-writer",
    name: "Technical Writer",
    description: "Create practical technical documentation for a defined audience.",
    category: "documents",
  },
  {
    slug: "priority-planner",
    name: "Priority Planner",
    description: "Rank competing work using impact, urgency, effort, and risk.",
    category: "productivity",
  },
  {
    slug: "decision-log",
    name: "Decision Log",
    description: "Capture decisions, context, alternatives, and follow-up dates.",
    category: "productivity",
  },
  {
    slug: "weekly-review",
    name: "Weekly Review",
    description: "Turn an activity log into progress, blockers, and next priorities.",
    category: "productivity",
  },
  {
    slug: "source-evaluator",
    name: "Source Evaluator",
    description: "Assess source authority, recency, evidence quality, and conflicts.",
    category: "research",
  },
  {
    slug: "market-researcher",
    name: "Market Researcher",
    description: "Compare markets, competitors, and customer segments with evidence.",
    category: "research",
  },
  {
    slug: "literature-scout",
    name: "Literature Scout",
    description: "Map relevant research and identify consensus, gaps, and disputes.",
    category: "research",
  },
  {
    slug: "fact-checker",
    name: "Fact Checker",
    description: "Verify important claims against direct and authoritative sources.",
    category: "research",
  },
  {
    slug: "workflow-builder",
    name: "Workflow Builder",
    description: "Convert repeatable work into explicit automated workflows.",
    category: "automation",
  },
  {
    slug: "integration-planner",
    name: "Integration Planner",
    description: "Plan reliable data flows between tools, APIs, and services.",
    category: "automation",
  },
  {
    slug: "job-scheduler",
    name: "Job Scheduler",
    description: "Design recurring jobs with safe retries, alerts, and ownership.",
    category: "automation",
  },
  {
    slug: "automation-auditor",
    name: "Automation Auditor",
    description: "Review automations for unsafe actions and silent failure modes.",
    category: "automation",
  },
  {
    slug: "risk-register",
    name: "Risk Register",
    description: "Identify, rank, and track operational risks and mitigations.",
    category: "other",
  },
  {
    slug: "interview-coach",
    name: "Interview Coach",
    description: "Prepare structured interviews and actionable feedback.",
    category: "other",
  },
  {
    slug: "learning-plan",
    name: "Learning Plan",
    description: "Create measurable learning paths with practice and review loops.",
    category: "other",
  },
  {
    slug: "facilitation-guide",
    name: "Facilitation Guide",
    description: "Plan focused workshops with outcomes, activities, and timing.",
    category: "other",
  },
];

const supplementalCreators = ["grace", "margaret", "alan", "katherine", "donald", "barbara"] as const;
skills.push(
  ...supplementalSkills.map(
    (skill, index): SeedSkill => ({
      ...skill,
      creator: supplementalCreators[Math.floor(index / 5)] ?? "barbara",
      instructions: `Use ${skill.name} to produce a concise, verifiable result. State assumptions and check the output before finishing.`,
    }),
  ),
);

async function main(): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "openbot-skill-seed-"));
  try {
    const records = [];
    for (const [index, skill] of skills.entries()) {
      const archive = skillArchive(skill);
      const skillId = `seed-skill-${skill.slug}`;
      const versionId = `seed-version-${skill.slug}-v1`;
      const bundleKey = `skills/${skillId}/versions/${versionId}.zip`;
      const archivePath = join(staging, `${skill.slug}.zip`);
      await writeFile(archivePath, archive);
      await runWrangler([
        "r2",
        "object",
        "put",
        `${localSkillsBucket}/${bundleKey}`,
        "--local",
        "--file",
        archivePath,
        "--content-type",
        "application/zip",
        "--force",
      ]);
      records.push({
        ...skill,
        skillId,
        versionId,
        bundleKey,
        bundleSha256: createHash("sha256").update(archive).digest("hex"),
        installs: 180 + (skills.length - index) * 110,
        timestamp: seededAt + index * 1_000,
      });
    }

    const sqlPath = join(staging, "seed.sql");
    await writeFile(sqlPath, seedSql(records));
    await runWrangler(["d1", "execute", "openbot-auth", "--local", "--file", sqlPath, "--yes"]);
    process.stdout.write(
      `Seeded ${records.length} approved marketplace skills across ${Object.keys(creators).length} creators.\n`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function skillArchive(skill: SeedSkill): Uint8Array {
  const content = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\n${skill.instructions}\n`;
  return zipSync({ "SKILL.md": encoder.encode(content) }, { level: 6 });
}

function seedSql(records: Array<SeedSkill & SeedRecord>): string {
  const statements = ["PRAGMA foreign_keys = ON;"];
  for (const creator of Object.values(creators)) {
    statements.push(`
INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
VALUES (${sql(creator.id)}, ${sql(creator.subject)}, ${sql(creator.email)}, ${sql(creator.name)}, NULL, ${seededAt}, ${seededAt})
ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;`);
  }
  for (const record of records) {
    const creator = creators[record.creator];
    statements.push(`
INSERT INTO marketplace_skills(id, slug, owner_user_id, approved_version_id, installs, featured, created_at, updated_at)
VALUES (${sql(record.skillId)}, ${sql(record.slug)}, ${sql(creator.id)}, NULL, ${record.installs}, ${record.slug === "release-notes" || record.slug === "code-reviewer" ? 1 : 0}, ${record.timestamp}, ${record.timestamp})
ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, owner_user_id = excluded.owner_user_id, installs = excluded.installs, updated_at = excluded.updated_at;

INSERT INTO marketplace_skill_versions(
  id, skill_id, version, name, description, category, status, bundle_key,
  bundle_sha256, files_json, icon_key, created_at, reviewed_at
)
VALUES (
  ${sql(record.versionId)}, ${sql(record.skillId)}, 1, ${sql(record.name)}, ${sql(record.description)},
  ${sql(record.category)}, 'approved', ${sql(record.bundleKey)}, ${sql(record.bundleSha256)},
  '["SKILL.md"]', NULL, ${record.timestamp}, ${record.timestamp}
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  status = 'approved',
  bundle_key = excluded.bundle_key,
  bundle_sha256 = excluded.bundle_sha256,
  files_json = excluded.files_json,
  reviewed_at = excluded.reviewed_at;

UPDATE marketplace_skills
SET approved_version_id = ${sql(record.versionId)}, updated_at = ${record.timestamp}
WHERE id = ${sql(record.skillId)};`);
  }
  return `${statements.join("\n")}\n`;
}

interface SeedRecord {
  skillId: string;
  versionId: string;
  bundleKey: string;
  bundleSha256: string;
  installs: number;
  timestamp: number;
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function runWrangler(args: string[]): Promise<void> {
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(wrangler, args, { cwd: authApiRoot, stdio: "inherit" });
    child.once("error", rejectProcess);
    child.once("exit", (exitCode) => {
      if (exitCode === 0) resolveProcess();
      else rejectProcess(new Error(`Wrangler failed with exit code ${exitCode ?? 1}: ${args.join(" ")}`));
    });
  });
}

await main();
