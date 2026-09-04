import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import type { AgentSummary, AttachmentSummary, ConversationMessage, Routine } from "@openbot/contracts/ipc";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { z } from "zod";
import { AgentMemoryStore } from "../src/backend/agent-memory-store";
import { AgentRoutineStore } from "../src/backend/agent-routine-store";
import { AgentStore } from "../src/backend/agent-store";
import { sortConversationMessages } from "../src/backend/conversation-snapshots";
import { MailboxStore } from "../src/backend/mailbox-store";
import { TeamChatStore } from "../src/backend/team-chat-store";
import { developmentUserDataName, readDevelopmentInstanceId } from "../src/main/development-profile";
import { writeSetupState } from "../src/main/setup-store";
import { TeamStore } from "../src/main/team-store";
import { resolveDevelopmentAppDataRoot } from "./development-state-paths";

export const DEVELOPMENT_SEED_MANIFEST_FILE = "openbot-dev-seed-v1.json";

const logger = createOpenBotLogger("seed-dev-state");

const TEAM_FILE = "openbot-team-server-v2.json";
/** Read only, exactly as the app reads it: the file a build without accounts owns. */
const LEGACY_TEAM_FILE = "openbot-team-server-v1.json";
const SETUP_FILE = "openbot-setup-v2.json";
const SEED_VERSION = 1;
const SEEDED_AT = "2026-08-21T10:00:00.000Z";
const SEED_AGENT_MODEL = "gpt-5.6-luna";
const SEED_AGENT_REASONING_EFFORT = "low";
const GENERATED_DIRECTORY_PATTERN =
  /^generated\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHOWCASE_IMAGE_PATH = resolve(process.cwd(), "src", "renderer", "src", "assets", "openbot-logo-dev.png");

interface DevelopmentSeedManifest {
  version: 1;
  createdAt: string;
  transferDirectories: string[];
}

const developmentSeedManifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  transferDirectories: z.array(z.string()),
});

export interface DevelopmentSeedOptions {
  appDataRoot?: string;
  homeDirectory?: string;
  dryRun?: boolean;
  instanceId?: string | null;
}

export interface DevelopmentSeedSummary {
  targetProfile: string;
  dryRun: boolean;
  profileActive: boolean;
  agents: number;
  conversations: number;
  attachments: number;
  teamMembers: number;
  activeInvites: number;
  sessions: number;
  directThreads: number;
  queuedDeliveries: number;
  memories: number;
  routines: number;
  routineRuns: number;
}

const SEED_SUMMARY = {
  agents: 4,
  conversations: 4,
  attachments: 4,
  teamMembers: 4,
  activeInvites: 1,
  sessions: 4,
  directThreads: 3,
  queuedDeliveries: 0,
  memories: 7,
  routines: 5,
  routineRuns: 3,
} as const;

const AGENTS = [
  {
    id: "chief",
    name: "Chief",
    title: "Chief of staff",
    description: "Coordinates priorities, decisions, and handoffs across the team.",
    model: SEED_AGENT_MODEL,
    reasoningEffort: SEED_AGENT_REASONING_EFFORT,
    avatarHue: 245,
    preview: "The launch plan is ready with owners, evidence, and next actions.",
  },
  {
    id: "research",
    name: "Research",
    title: "Research partner",
    description: "Finds reliable sources and turns them into concise briefs.",
    model: SEED_AGENT_MODEL,
    reasoningEffort: SEED_AGENT_REASONING_EFFORT,
    avatarHue: 185,
    preview: "The source review and evidence map are complete.",
  },
  {
    id: "builder",
    name: "Builder",
    title: "Product engineer",
    description: "Builds product changes and records clear technical decisions.",
    model: SEED_AGENT_MODEL,
    reasoningEffort: SEED_AGENT_REASONING_EFFORT,
    avatarHue: 30,
    preview: "The implementation checklist includes tests and rollback steps.",
  },
  {
    id: "launch",
    name: "Launch",
    title: "Go-to-market lead",
    description: "Prepares launch assets, messaging, and release checklists.",
    model: SEED_AGENT_MODEL,
    reasoningEffort: SEED_AGENT_REASONING_EFFORT,
    avatarHue: 320,
    preview: "The launch brief is ready for final review.",
  },
] as const;

export async function seedDevelopmentState(options: DevelopmentSeedOptions = {}): Promise<DevelopmentSeedSummary> {
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const appDataRoot = resolve(
    options.appDataRoot ?? resolveDevelopmentAppDataRoot(process.platform, process.env, homeDirectory),
  );
  assertSafeAppDataRoot(appDataRoot);
  const targetProfile = resolve(appDataRoot, developmentUserDataName("app", options.instanceId ?? null));
  if (dirname(targetProfile) !== appDataRoot) throw new Error(`Unsafe OpenBot dev profile path: ${targetProfile}`);

  const profileActive = await isDevelopmentProfileActive(targetProfile);
  const summary: DevelopmentSeedSummary = {
    targetProfile,
    dryRun: options.dryRun ?? false,
    profileActive,
    ...SEED_SUMMARY,
  };
  if (options.dryRun) return summary;
  if (profileActive) {
    throw new Error("Quit the OpenBot dev app before you seed its local state.");
  }

  await mkdir(appDataRoot, { recursive: true, mode: 0o700 });
  const stagingProfile = await mkdtemp(join(appDataRoot, ".openbot-dev-seed-"));
  const newTransferDirectories: string[] = [];
  try {
    await buildSeedProfile(stagingProfile, homeDirectory, newTransferDirectories);
    if (await isDevelopmentProfileActive(targetProfile)) {
      throw new Error("Quit the OpenBot dev app before you seed its local state.");
    }
    await replaceDevelopmentProfile(targetProfile, stagingProfile, homeDirectory);
  } catch (error) {
    await Promise.all([
      rm(stagingProfile, { recursive: true, force: true }),
      removeTransferDirectories(homeDirectory, newTransferDirectories),
    ]);
    throw error;
  }

  return summary;
}

export async function isDevelopmentProfileActive(profilePath: string): Promise<boolean> {
  const lockPath = join(profilePath, "SingletonLock");
  try {
    const lock = await lstat(lockPath);
    if (!lock.isSymbolicLink()) return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }

  let target: string;
  try {
    target = await readlink(lockPath);
  } catch {
    return true;
  }
  const processId = Number(target.match(/-(\d+)$/u)?.[1]);
  if (!Number.isSafeInteger(processId) || processId <= 0) return true;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export async function cleanupSeedOwnedTransfers(profilePath: string, homeDirectory = homedir()): Promise<string[]> {
  const directories = await readSeedTransferDirectories(profilePath);
  return removeTransferDirectories(homeDirectory, directories);
}

async function buildSeedProfile(
  profilePath: string,
  homeDirectory: string,
  transferDirectories: string[],
): Promise<void> {
  const agentStore = new AgentStore(profilePath, homeDirectory);
  await agentStore.initialize();
  const mailbox = new MailboxStore(profilePath, agentStore.sharedRoot, agentStore.database);
  await mailbox.initialize();

  try {
    const agents = await seedAgents(agentStore);
    const attachments = await seedAttachments(mailbox, agents, transferDirectories);
    seedMemories(agentStore);
    await seedRoutines(agentStore, mailbox);
    await seedAgentExchanges(mailbox);
    await seedConversations(agentStore, mailbox, agents, attachments);
    await seedTeam(profilePath, agentStore);
    await writeSetupState(join(profilePath, SETUP_FILE), "codex");
    await writeSeedManifest(profilePath, transferDirectories);
  } finally {
    agentStore.database.close();
  }
}

function seedMemories(agentStore: AgentStore): void {
  const memories = new AgentMemoryStore(agentStore.database);
  for (const fixture of [
    {
      agentId: "chief",
      text: "The user prefers concise status updates with clear owners and next steps.",
      origin: "manual" as const,
    },
    {
      agentId: "chief",
      text: "Use Europe/Warsaw when presenting launch dates and times.",
      origin: "manual" as const,
    },
    {
      agentId: "chief",
      text: "The current priority is a traceable OpenBot launch plan.",
      origin: "automatic" as const,
      sourceTurnId: "dev-seed-turn-chief-plan",
    },
    {
      agentId: "research",
      text: "Prioritize primary sources and call out claims that still need verification.",
      origin: "manual" as const,
    },
    {
      agentId: "research",
      text: "The launch evidence map contains one claim that still needs a primary source.",
      origin: "automatic" as const,
      sourceTurnId: "dev-seed-turn-research-evidence",
    },
    {
      agentId: "builder",
      text: "Implementation plans should include typecheck, tests, and a rollback step.",
      origin: "manual" as const,
    },
    {
      agentId: "launch",
      text: "Use calm, evidence-based release messaging and review final assets before publication.",
      origin: "manual" as const,
    },
  ]) {
    if (fixture.origin === "automatic") {
      memories.saveAutomatic({
        agentId: fixture.agentId,
        text: fixture.text,
        sourceTurnId: fixture.sourceTurnId,
      });
    } else {
      memories.createManual(fixture.agentId, fixture.text);
    }
  }
}

async function seedRoutines(agentStore: AgentStore, mailbox: MailboxStore): Promise<void> {
  const routines = new AgentRoutineStore(agentStore.database);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const now = new Date();
  const morningBrief = routines.create(
    {
      agentId: "chief",
      name: "Morning launch brief",
      instruction: "Summarize launch progress, blockers, owners, and the next decision in five bullets.",
      active: true,
      timezone,
      schedule: { kind: "weekdays", time: "09:00" },
    },
    now,
  );
  routines.create(
    {
      agentId: "chief",
      name: "Friday launch review",
      instruction: "Prepare the weekly launch review with decisions, risks, and unresolved ownership gaps.",
      active: true,
      timezone,
      schedule: { kind: "weekly", weekday: 5, time: "16:00" },
    },
    now,
  );
  const sourceCheck = routines.create(
    {
      agentId: "research",
      name: "Daily source check",
      instruction: "Recheck open launch claims against primary sources and report only material changes.",
      active: true,
      timezone,
      schedule: { kind: "daily", time: "08:30" },
    },
    now,
  );
  routines.create(
    {
      agentId: "builder",
      name: "Dependency health check",
      instruction: "Review dependency health and prepare a short risk report without changing the codebase.",
      active: false,
      timezone,
      schedule: { kind: "weekly", weekday: 1, time: "10:00" },
    },
    now,
  );
  routines.create(
    {
      agentId: "launch",
      name: "Release readiness pulse",
      instruction: "Check release assets, messaging, and approvals, then list anything blocking publication.",
      active: true,
      timezone,
      schedule: { kind: "weekdays", time: "15:30" },
    },
    now,
  );

  await seedRoutineRun(routines, mailbox, morningBrief, "scheduled", hoursBefore(now, 26), "succeeded");
  await seedRoutineRun(routines, mailbox, morningBrief, "manual", hoursBefore(now, 2), "succeeded");
  await seedRoutineRun(
    routines,
    mailbox,
    sourceCheck,
    "scheduled",
    hoursBefore(now, 25),
    "failed",
    "One source was temporarily unavailable.",
  );
}

async function seedRoutineRun(
  routines: AgentRoutineStore,
  mailbox: MailboxStore,
  routine: Routine,
  kind: "scheduled" | "manual",
  scheduledFor: string,
  status: "succeeded" | "failed",
  error: string | null = null,
): Promise<void> {
  const run = routines.createRun(routine, kind === "scheduled" ? routine.trigger.id : null, kind, scheduledFor);
  const receipt = await mailbox.enqueue({
    sender: {
      kind: "routine",
      routineId: routine.id,
      runId: run.id,
      routineName: routine.name,
      scheduledFor,
    },
    recipientAgentIds: [routine.agentId],
    text: routine.instruction,
    idempotencyKey: `dev-seed:routine-run:${run.id}`,
  });
  const delivery = receipt.deliveries[0];
  if (!delivery) throw new Error("The seeded routine run did not create a delivery.");
  routines.attachDelivery(run.id, delivery.id);
  await mailbox.markStarting(delivery.id);
  await mailbox.markRunning(delivery.id, `dev-seed-routine-turn-${run.id}`);
  await mailbox.markTerminal(delivery.id, status === "succeeded" ? "completed" : "failed", error);
  routines.updateRunStatus(run.id, status, error);
}

function hoursBefore(date: Date, hours: number): string {
  return new Date(date.getTime() - hours * 60 * 60 * 1_000).toISOString();
}

async function seedAgents(agentStore: AgentStore): Promise<Map<string, AgentSummary>> {
  const agents = new Map<string, AgentSummary>();
  for (const fixture of AGENTS) {
    await agentStore.getOrCreate(fixture.id, fixture.name, fixture.title);
    const agent = await agentStore.updateAgent({
      agentId: fixture.id,
      name: fixture.name,
      title: fixture.title,
      description: fixture.description,
      model: fixture.model,
      reasoningEffort: fixture.reasoningEffort,
      avatarSeed: fixture.id,
      avatarHue: fixture.avatarHue,
    });
    await agentStore.ensureThreadId(fixture.id);
    await agentStore.updatePreview(fixture.id, fixture.preview);
    agents.set(fixture.id, agentStore.list().find((candidate) => candidate.id === fixture.id) ?? agent);
  }
  return agents;
}

async function seedAttachments(
  mailbox: MailboxStore,
  agents: Map<string, AgentSummary>,
  transferDirectories: string[],
): Promise<Record<"brief" | "metrics" | "evidence" | "image", AttachmentSummary>> {
  const chief = requireAgent(agents, "chief");
  const research = requireAgent(agents, "research");
  const launch = requireAgent(agents, "launch");
  async function store(
    owner: AgentSummary,
    input:
      | { name: string; mimeType: string; bytes: Uint8Array }
      | { name: string; mimeType: string; sourcePath: string },
  ): Promise<AttachmentSummary> {
    const attachment = await mailbox.storeGeneratedAttachment({
      ...input,
      ownerAgentId: owner.id,
      ownerThreadId: owner.threadId,
    });
    transferDirectories.push(`generated/${attachment.id}`);
    return attachment;
  }

  return {
    brief: await store(chief, {
      name: "launch-brief.md",
      mimeType: "text/markdown",
      bytes: bytes("# Launch brief\n\n- Confirm owners\n- Verify evidence\n- Publish the release note\n"),
    }),
    metrics: await store(chief, {
      name: "launch-metrics.csv",
      mimeType: "text/csv",
      bytes: bytes("metric,baseline,target\nactivation,42%,55%\nretention,61%,68%\n"),
    }),
    evidence: await store(research, {
      name: "evidence-map.json",
      mimeType: "application/json",
      bytes: bytes(`${JSON.stringify({ sources: 8, verified: 7, needsReview: 1 }, null, 2)}\n`),
    }),
    image: await store(launch, {
      name: "openbot-launch-concept.png",
      mimeType: "image/png",
      sourcePath: SHOWCASE_IMAGE_PATH,
    }),
  };
}

async function seedConversations(
  agentStore: AgentStore,
  mailbox: MailboxStore,
  agents: Map<string, AgentSummary>,
  attachments: Record<"brief" | "metrics" | "evidence" | "image", AttachmentSummary>,
): Promise<void> {
  const conversations: Record<string, ConversationMessage[]> = {
    chief: [
      message(
        "chief-user-plan",
        "user",
        "Prepare the launch plan, tag @Research, and keep every decision traceable.",
        0,
      ),
      {
        ...message(
          "chief-assistant-plan",
          "assistant",
          [
            "## Launch plan",
            "",
            "I asked @Research to verify the evidence. The working documents are",
            `${serializeAttachmentReference(attachments.brief.name, attachments.brief.id)} and ${serializeAttachmentReference(attachments.metrics.name, attachments.metrics.id)}.`,
            "",
            "| Workstream | Owner | Status |",
            "| --- | --- | --- |",
            "| Product QA | @Builder | Ready |",
            "| Evidence | @Research | In review |",
            "| Release | @Launch | Ready |",
            "",
            "Next: review the [OpenBot documentation](https://openbot.run/docs), then run:",
            "",
            "```bash",
            "bun run check",
            "```",
          ].join("\n"),
          1,
        ),
        turnId: "dev-seed-turn-chief-plan",
        attachments: [attachments.brief, attachments.metrics],
      },
      {
        ...message("chief-user-reply", "user", "Looks good. Add a final rollback owner.", 2),
        replyToMessageId: "chief-assistant-plan",
      },
      {
        ...message("chief-assistant-failed", "assistant", "I could not load one external source.", 3),
        status: "failed",
      },
      {
        ...message("chief-assistant-interrupted", "assistant", "The long audit stopped when the app restarted.", 4),
        status: "interrupted",
      },
      {
        ...message("chief-image-completed", "assistant", "", 5),
        itemType: "image_generation",
        attachments: [attachments.image],
        imageGeneration: {
          prompt: "A calm OpenBot launch command center at blue hour",
          resolution: "1024 × 1024",
          aspectRatio: "square",
        },
      },
      {
        ...message("chief-image-failed", "assistant", "", 6),
        status: "failed",
        itemType: "image_generation",
        imageGeneration: {
          prompt: "A second launch concept",
          resolution: "1536 × 1024",
          aspectRatio: "landscape",
          error: "The image service was temporarily unavailable.",
        },
      },
    ],
    research: [
      message("research-user", "user", "Check the claims and return a compact evidence map.", 10),
      {
        ...message(
          "research-assistant",
          "assistant",
          `Seven of eight claims are verified. One claim still needs a primary source. See ${serializeAttachmentReference(attachments.evidence.name, attachments.evidence.id)}.`,
          11,
        ),
        turnId: "dev-seed-turn-research-evidence",
        attachments: [attachments.evidence],
      },
    ],
    builder: [
      message("builder-user", "user", "Turn the launch plan into a safe implementation checklist.", 20),
      message(
        "builder-assistant",
        "assistant",
        "### Implementation checklist\n\n1. Run typecheck.\n2. Run Biome.\n3. Test the dev app.\n4. Record the rollback step.\n\n```ts\nconst ready = checks.every(Boolean);\n```",
        21,
      ),
    ],
    launch: [
      message("launch-user", "user", "Prepare the final release message and asset review.", 30),
      {
        ...message(
          "launch-assistant",
          "assistant",
          `The release package is ready. Review ${serializeAttachmentReference(attachments.image.name, attachments.image.id)} before publication.`,
          31,
        ),
        attachments: [attachments.image],
      },
    ],
  };

  for (const [agentId, messages] of Object.entries(conversations)) {
    const agent = requireAgent(agents, agentId);
    const persistedMessages = [...messages, ...mailbox.conversationMessages(agentId)];
    sortConversationMessages(persistedMessages);
    agentStore.database.persistConversation(
      { agentId, threadId: agent.threadId, activeTurnId: null, revision: 0, messages: persistedMessages },
      "dev-seed.created",
      { seedVersion: SEED_VERSION },
      `dev-seed:conversation:${agentId}`,
    );
  }
  await mailbox.setReaction("chief", "chief-assistant-plan", { kind: "user" }, "🎉");
  await mailbox.setReaction("research", "research-assistant", { kind: "user" }, "✅");
}

async function seedAgentExchanges(mailbox: MailboxStore): Promise<void> {
  const completed = await mailbox.enqueue({
    sender: { kind: "agent", agentId: "chief" },
    recipientAgentIds: ["research", "builder"],
    text: "Please verify the launch evidence and implementation checklist.",
    replyToMessageId: "chief-assistant-plan",
    idempotencyKey: "dev-seed:exchange:completed",
  });
  for (const [index, delivery] of completed.deliveries.entries()) {
    await mailbox.markStarting(delivery.id);
    await mailbox.markRunning(delivery.id, `dev-seed-turn-completed-${index + 1}`);
    await mailbox.markTerminal(delivery.id, "completed");
  }

  const failed = await mailbox.enqueue({
    sender: { kind: "agent", agentId: "research" },
    recipientAgentIds: ["launch"],
    text: "I could not verify the final launch claim. Please keep it out of the release note.",
    idempotencyKey: "dev-seed:exchange:failed",
  });
  const failedDelivery = failed.deliveries[0];
  if (!failedDelivery) throw new Error("The failed seed exchange did not create a delivery.");
  await mailbox.markStarting(failedDelivery.id);
  await mailbox.markRunning(failedDelivery.id, "dev-seed-turn-failed");
  await mailbox.markTerminal(failedDelivery.id, "failed", "The primary source was not available.");
}

async function seedTeam(profilePath: string, agentStore: AgentStore): Promise<void> {
  const team = new TeamStore(join(profilePath, TEAM_FILE), join(profilePath, LEGACY_TEAM_FILE));
  await team.initialize();
  const owner = {
    id: "openbot-dev-owner",
    email: "openbot-dev-host@example.com",
    name: "Dev Owner",
    avatarUrl: null,
  };
  const teamIdentity = await team.configureWithAccount("OpenBot Dev Team", owner);
  const joined = [];
  for (const member of [
    { id: "openbot-dev-alice", email: "alice@example.com", name: "Alice Chen", role: "admin" as const },
    { id: "openbot-dev-jon", email: "jon@example.com", name: "Jon Bell", role: "member" as const },
    { id: "openbot-dev-maya", email: "maya@example.com", name: "Maya Singh", role: "member" as const },
  ]) {
    const invite = await team.createInvite(member.role, member.email);
    joined.push(
      await team.acceptInviteWithAccount(invite.token, {
        id: member.id,
        email: member.email,
        name: member.name,
        avatarUrl: null,
      }),
    );
  }
  await team.createInvite("member", "new-person@example.com");
  const ownerSession = await team.loginWithAccount(owner);
  await team.setEnabledOnLaunch(teamIdentity.serverId, true);

  const [alice, jon, maya] = joined;
  if (!alice || !jon || !maya) throw new Error("The development team members could not be created.");
  const chat = new TeamChatStore(agentStore.database);
  chat.sendMessage({
    clientMessageId: "dev-seed-dm-owner-alice-1",
    senderMemberId: ownerSession.member.id,
    recipientMemberId: alice.member.id,
    text: "I added the launch notes. Can you review the last section?",
    createdAt: timestamp(40),
  });
  chat.sendMessage({
    clientMessageId: "dev-seed-dm-alice-owner-1",
    senderMemberId: alice.member.id,
    recipientMemberId: ownerSession.member.id,
    text: "The notes look good. I left one comment on the rollout section.",
    createdAt: timestamp(41),
  });
  chat.sendMessage({
    clientMessageId: "dev-seed-dm-jon-owner-1",
    senderMemberId: jon.member.id,
    recipientMemberId: ownerSession.member.id,
    text: "The customer examples are ready for the release note.",
    createdAt: timestamp(42),
  });
  chat.sendMessage({
    clientMessageId: "dev-seed-dm-maya-owner-1",
    senderMemberId: maya.member.id,
    recipientMemberId: ownerSession.member.id,
    text: "I checked the final asset sizes. Everything is within the limits.",
    createdAt: timestamp(43),
  });
}

async function replaceDevelopmentProfile(target: string, staging: string, homeDirectory: string): Promise<void> {
  const backup = resolve(dirname(target), `.openbot-dev-backup-${randomUUID()}`);
  const targetExists = await pathExists(target);
  if (targetExists) await rename(target, backup);
  try {
    await rename(staging, target);
  } catch (error) {
    if (targetExists) await rename(backup, target);
    throw error;
  }
  if (!targetExists) return;
  try {
    await cleanupSeedOwnedTransfers(backup, homeDirectory);
  } catch (error) {
    logger.warn(`The new seed is ready, but old seed files could not be removed: ${errorMessage(error)}`);
  } finally {
    await rm(backup, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn(`The new seed is ready, but its temporary backup could not be removed: ${errorMessage(error)}`);
    });
  }
}

async function writeSeedManifest(profilePath: string, transferDirectories: string[]): Promise<void> {
  const manifest: DevelopmentSeedManifest = {
    version: 1,
    createdAt: SEEDED_AT,
    transferDirectories: [...transferDirectories],
  };
  await writeFile(join(profilePath, DEVELOPMENT_SEED_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readSeedTransferDirectories(profilePath: string): Promise<string[]> {
  try {
    const parsed = developmentSeedManifestSchema.safeParse(
      JSON.parse(await readFile(join(profilePath, DEVELOPMENT_SEED_MANIFEST_FILE), "utf8")),
    );
    if (!parsed.success) return [];
    return parsed.data.transferDirectories.filter((entry) => GENERATED_DIRECTORY_PATTERN.test(entry));
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function removeTransferDirectories(homeDirectory: string, directories: string[]): Promise<string[]> {
  const root = resolve(homeDirectory, "OpenBot", "Shared", "Transfers");
  const generatedRoot = resolve(root, "generated");
  const removed: string[] = [];
  for (const relativePath of directories) {
    if (!GENERATED_DIRECTORY_PATTERN.test(relativePath)) continue;
    const target = resolve(root, ...relativePath.split("/"));
    if (dirname(target) !== generatedRoot) continue;
    if (!(await pathExists(target))) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

function message(
  id: string,
  author: ConversationMessage["author"],
  text: string,
  minuteOffset: number,
): ConversationMessage {
  return {
    id,
    author,
    source: author === "assistant" ? "assistant" : author,
    text,
    createdAt: timestamp(minuteOffset),
    status: "completed",
  };
}

function timestamp(minuteOffset: number): string {
  return new Date(Date.parse(SEEDED_AT) + minuteOffset * 60_000).toISOString();
}

function requireAgent(agents: Map<string, AgentSummary>, agentId: string): AgentSummary {
  const agent = agents.get(agentId);
  if (!agent?.threadId) throw new Error(`Seed agent ${agentId} does not have a thread.`);
  return agent;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function assertSafeAppDataRoot(appDataRoot: string): void {
  if (appDataRoot === parse(appDataRoot).root) {
    throw new Error("The application data root cannot be a filesystem root.");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;
}

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const summary = await seedDevelopmentState({
    dryRun,
    instanceId: readDevelopmentInstanceId(process.env.OPENBOT_DEV_INSTANCE_ID),
  });
  logger.info(dryRun ? "OpenBot development seed dry run:" : "OpenBot development state seeded:");
  logger.info(`- profile: ${summary.targetProfile}`);
  logger.info(`- profile active: ${summary.profileActive ? "yes" : "no"}`);
  logger.info(`- agents: ${summary.agents}`);
  logger.info(`- conversations: ${summary.conversations}`);
  logger.info(`- managed attachments: ${summary.attachments}`);
  logger.info(`- team members: ${summary.teamMembers}`);
  logger.info(`- active invites: ${summary.activeInvites}`);
  logger.info(`- direct threads: ${summary.directThreads}`);
  logger.info(`- queued deliveries: ${summary.queuedDeliveries}`);
  logger.info(`- memories: ${summary.memories}`);
  logger.info(`- routines: ${summary.routines}`);
  logger.info(`- routine runs: ${summary.routineRuns}`);
  if (dryRun) logger.info("No files were changed.");
  else logger.info("Run `bun run dev` to open the seeded showcase.");
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    logger.error(toLogValue(error));
    process.exitCode = 1;
  });
}
