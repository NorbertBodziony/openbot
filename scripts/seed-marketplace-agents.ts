import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AvatarHue, MarketplaceAgentRoutine, MarketplaceAgentSkill } from "@openbot/contracts/ipc";

interface SeedAgent {
  slug: string;
  name: string;
  title: string;
  description: string;
  avatarHue: AvatarHue;
  installs: number;
  featured: boolean;
  skills: MarketplaceAgentSkill[];
  routines: MarketplaceAgentRoutine[];
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const authApiRoot = join(projectRoot, "apps", "auth-api");
const wrangler = join(authApiRoot, "node_modules", ".bin", "wrangler");
const seededAt = Date.parse("2026-08-25T12:00:00.000Z");
const creator = {
  id: "seed-agents-openbot",
  subject: "seed-agents-openbot",
  email: "agents@openbot.local",
  name: "OpenBot",
};

const agents: SeedAgent[] = [
  {
    slug: "research-briefing-lead",
    name: "Research Briefing Lead",
    title: "Turns evidence into decision-ready briefs",
    description:
      "Researches important questions, checks source quality, verifies claims, and delivers concise cited recommendations.",
    avatarHue: 185,
    installs: 2_840,
    featured: true,
    skills: [
      skill("research-brief", "Research Brief"),
      skill("source-evaluator", "Source Evaluator"),
      skill("fact-checker", "Fact Checker"),
    ],
    routines: [
      routine(
        "Morning evidence brief",
        "Prepare a concise evidence brief for the highest-priority open question.",
        true,
        {
          kind: "weekdays",
          time: "09:00",
        },
      ),
      routine(
        "Friday source audit",
        "Review this week's sources for freshness, authority, and unresolved conflicts.",
        false,
        {
          kind: "weekly",
          weekday: 5,
          time: "16:00",
        },
      ),
    ],
  },
  {
    slug: "release-coordinator",
    name: "Release Coordinator",
    title: "Keeps launches clear, owned, and ready",
    description:
      "Coordinates release notes, meeting follow-ups, and decision records so every launch has clear owners and next steps.",
    avatarHue: 320,
    installs: 2_310,
    featured: true,
    skills: [
      skill("release-notes", "Release Notes"),
      skill("meeting-follow-up", "Meeting Follow-up"),
      skill("decision-log", "Decision Log"),
    ],
    routines: [
      routine(
        "Daily release pulse",
        "Summarize release progress, blockers, owners, and the next decision needed.",
        true,
        {
          kind: "weekdays",
          time: "16:30",
        },
      ),
      routine("Monday launch review", "Review launch readiness and produce the week's release priorities.", false, {
        kind: "weekly",
        weekday: 1,
        time: "09:30",
      }),
    ],
  },
  {
    slug: "incident-commander",
    name: "Incident Commander",
    title: "Builds timelines and drives corrective action",
    description:
      "Separates evidence from hypotheses, maintains an operational risk register, and turns incidents into verified follow-up work.",
    avatarHue: 30,
    installs: 1_760,
    featured: false,
    skills: [
      skill("incident-analyst", "Incident Analyst"),
      skill("risk-register", "Risk Register"),
      skill("code-reviewer", "Code Reviewer"),
    ],
    routines: [
      routine(
        "Risk register review",
        "Review open operational risks and identify overdue mitigations or missing owners.",
        true,
        {
          kind: "weekly",
          weekday: 3,
          time: "10:00",
        },
      ),
      routine(
        "Monthly incident themes",
        "Summarize recurring incident causes and recommend preventive investments.",
        false,
        {
          kind: "monthly",
          day: 1,
          time: "11:00",
        },
      ),
    ],
  },
  {
    slug: "automation-steward",
    name: "Automation Steward",
    title: "Designs reliable workflows with safe recovery",
    description:
      "Builds explicit automations, checks integrations and schedules, and audits workflows for unsafe actions and silent failures.",
    avatarHue: 245,
    installs: 1_420,
    featured: false,
    skills: [
      skill("browser-automation", "Browser Automation"),
      skill("workflow-builder", "Workflow Builder"),
      skill("automation-auditor", "Automation Auditor"),
    ],
    routines: [
      routine(
        "Automation health check",
        "Review active automations for recent failures, unsafe actions, and missing alerts.",
        true,
        {
          kind: "daily",
          time: "08:30",
        },
      ),
      routine(
        "Quarterly workflow audit",
        "Audit critical workflows for ownership, recovery steps, and validation coverage.",
        false,
        {
          kind: "monthly",
          day: 15,
          time: "13:00",
        },
      ),
    ],
  },
];

async function main(): Promise<void> {
  await runWrangler(["d1", "migrations", "apply", "openbot-auth", "--local"]);
  await import("./seed-marketplace-skills");
  const staging = await mkdtemp(join(tmpdir(), "openbot-agent-seed-"));
  try {
    const sqlPath = join(staging, "seed.sql");
    await writeFile(sqlPath, seedSql());
    await runWrangler(["d1", "execute", "openbot-auth", "--local", "--file", sqlPath, "--yes"]);
    process.stdout.write(`Seeded ${agents.length} approved marketplace agents with exact skills and routines.\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function skill(slug: string, name: string): MarketplaceAgentSkill {
  return {
    skillId: `seed-skill-${slug}`,
    versionId: `seed-version-${slug}-v1`,
    slug,
    name,
    version: 1,
  };
}

function routine(
  name: string,
  instruction: string,
  active: boolean,
  schedule: MarketplaceAgentRoutine["schedule"],
): MarketplaceAgentRoutine {
  return { name, instruction, active, schedule };
}

function seedSql(): string {
  const statements = [
    "PRAGMA foreign_keys = ON;",
    `INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
VALUES (${sql(creator.id)}, ${sql(creator.subject)}, ${sql(creator.email)}, ${sql(creator.name)}, NULL, ${seededAt}, ${seededAt})
ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;`,
  ];
  for (const [index, agent] of agents.entries()) {
    const agentId = `seed-agent-${agent.slug}`;
    const versionId = `seed-agent-version-${agent.slug}-v1`;
    const timestamp = seededAt + index * 1_000;
    statements.push(`
INSERT INTO marketplace_agents(id, owner_user_id, approved_version_id, installs, featured, created_at, updated_at)
VALUES (${sql(agentId)}, ${sql(creator.id)}, NULL, ${agent.installs}, ${agent.featured ? 1 : 0}, ${timestamp}, ${timestamp})
ON CONFLICT(id) DO UPDATE SET
  owner_user_id = excluded.owner_user_id,
  installs = excluded.installs,
  featured = excluded.featured,
  updated_at = excluded.updated_at;

INSERT INTO marketplace_agent_versions(
  id, agent_id, version, name, title, description, avatar_seed, avatar_hue, avatar_key,
  skills_json, routines_json, status, rejection_note, created_at, reviewed_at
)
VALUES (
  ${sql(versionId)}, ${sql(agentId)}, 1, ${sql(agent.name)}, ${sql(agent.title)}, ${sql(agent.description)},
  ${sql(agentId)}, ${agent.avatarHue}, NULL, ${sql(JSON.stringify(agent.skills))},
  ${sql(JSON.stringify(agent.routines))}, 'approved', NULL, ${timestamp}, ${timestamp}
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  title = excluded.title,
  description = excluded.description,
  avatar_seed = excluded.avatar_seed,
  avatar_hue = excluded.avatar_hue,
  skills_json = excluded.skills_json,
  routines_json = excluded.routines_json,
  status = 'approved',
  rejection_note = NULL,
  reviewed_at = excluded.reviewed_at;

UPDATE marketplace_agents
SET approved_version_id = ${sql(versionId)}, updated_at = ${timestamp}
WHERE id = ${sql(agentId)};`);
  }
  return `${statements.join("\n")}\n`;
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
