import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { avatarFileExtension, isAvatarMimeType, isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  AGENT_PROVIDERS,
  type AgentModelId,
  type AgentProviderId,
  type AgentReasoningEffort,
  type AgentSummary,
  type AvatarImageInput,
  type CreateAgentInput,
  type DuplicateAgentResult,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isReasoningEffort,
  isSidebarLayoutSnapshot,
  providerForLegacyModel,
  type SidebarLayoutSnapshot,
  type UpdateAgentInput,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { isGeneratedAgentId, isUuidV4, legacyAgentId } from "@openbot/contracts/validation";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import { OpenBotDatabase, type ProviderSession, stableThreadId } from "./openbot-database";
import { isRecord } from "./protocol";

type StoredAgent = AgentSummary;
type PersistedStoredAgent = Omit<StoredAgent, "avatarUrl" | "provider"> & {
  avatarUrl?: string | null;
  provider?: AgentProviderId;
};
type StoredAgentBase = Omit<PersistedStoredAgent, "avatarSeed" | "avatarHue"> & DynamicRecord;

interface AgentDuplicationMarker {
  operationId: string;
  sourceAgentId: string;
}

interface StoredState {
  version: 2;
  examplesInitialized: boolean;
  agents: StoredAgent[];
}

type LegacyStoredAgent = Omit<PersistedStoredAgent, "avatarSeed" | "avatarHue"> & {
  avatarShape: string;
  avatarColor: string;
};

const LEGACY_AVATAR_VARIANTS = ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop"] as const;
const LEGACY_AVATAR_COLORS = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
] as const;

export const DEFAULT_AGENT_MODEL: AgentModelId = "gpt-5.6-luna";
export const DEFAULT_AGENT_PROVIDER: AgentProviderId = "codex";
export const DEFAULT_REASONING_EFFORT: AgentReasoningEffort = "medium";

// These three strings are history, not vocabulary. The first is the file a release before the move to
// SQLite wrote its state into, and is only ever read: renaming it means that file is never found and the
// data of anyone who has not yet run the importing release is lost. The second is the key that file's
// agent array is stored under, and reading a different one discards every agent in it just as
// silently. The third is a `command_id` already stamped into `orchestration_command_receipts` on
// every existing install, and is what stops the legacy import running a second time. None of the
// three follows the bot-to-agent rename.
const LEGACY_AGENTS_STATE_FILE = "bots.json";
const LEGACY_AGENTS_STATE_KEY = "bots";
const LEGACY_AGENTS_IMPORT_COMMAND_ID = "legacy-import:bots:v1";

const logger = createOpenBotLogger("agent-store");

export class AgentStore {
  readonly #statePath: string;
  readonly #agentsRoot: string;
  readonly #legacyAgentsRoot: string;
  readonly #sharedRoot: string;
  readonly #downloadsRoot: string;
  readonly #avatarsRoot: string;
  readonly #duplicationsRoot: string;
  readonly #database: OpenBotDatabase;
  #state: StoredState = { version: 2, examplesInitialized: false, agents: [] };
  #avatarUpdateQueue: Promise<void> = Promise.resolve();
  #creationQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, homePath: string, database = new OpenBotDatabase(userDataPath)) {
    const openbotRoot = join(homePath, "OpenBot");
    this.#statePath = join(userDataPath, LEGACY_AGENTS_STATE_FILE);
    this.#agentsRoot = join(openbotRoot, "Agents");
    this.#legacyAgentsRoot = join(openbotRoot, "Bots");
    this.#sharedRoot = join(openbotRoot, "Shared");
    this.#downloadsRoot = join(openbotRoot, "Downloads");
    this.#avatarsRoot = join(userDataPath, "avatars", "agents");
    this.#duplicationsRoot = join(userDataPath, "agent-duplications");
    this.#database = database;
  }

  get database(): OpenBotDatabase {
    return this.#database;
  }

  get sharedRoot(): string {
    return this.#sharedRoot;
  }

  get downloadsRoot(): string {
    return this.#downloadsRoot;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#agentsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#sharedRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#downloadsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#avatarsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#duplicationsRoot, { recursive: true, mode: 0o700 }),
      mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 }),
    ]);

    await this.#database.initialize();
    const persisted = this.#database.listAgents();
    if (persisted.length > 0 || this.#database.hasAggregateEvents("agents", "agents")) {
      if (!persisted.every(isStoredAgent)) {
        throw new Error("Stored agent profiles use the old role field; update the data before starting OpenBot.");
      }
      this.#state = {
        version: 2,
        examplesInitialized: true,
        agents: persisted.map(normalizeStoredAgent),
      };
    } else {
      const legacy = await this.#readState();
      await this.#database.backupLegacyFile(this.#statePath);
      const sessions: Array<{ agent: StoredAgent; externalSessionId: string }> = [];
      legacy.agents = legacy.agents.map((agent) => {
        if (!agent.threadId) return agent;
        sessions.push({ agent, externalSessionId: agent.threadId });
        return { ...agent, threadId: stableThreadId(agent.id) };
      });
      legacy.examplesInitialized = true;
      this.#state = legacy;
      this.#database.replaceAgents(LEGACY_AGENTS_IMPORT_COMMAND_ID, legacy.agents, "agents.legacy-imported");
      for (const { agent, externalSessionId } of sessions) {
        this.#database.bindProviderSession({
          threadId: stableThreadId(agent.id),
          provider: agent.provider,
          externalSessionId,
          model: agent.model,
          effort: agent.reasoningEffort,
        });
      }
    }
    await this.#reconcileLegacyDirectories();
    await this.#recoverPendingDuplications();
  }

  list(): AgentSummary[] {
    return this.#state.agents.map((agent) => ({ ...agent }));
  }

  createAgent(input: Omit<CreateAgentInput, "initialMessage">): Promise<AgentSummary> {
    return this.#enqueueCreation(() => this.#createAgent(input));
  }

  async #createAgent(input: Omit<CreateAgentInput, "initialMessage">): Promise<AgentSummary> {
    if (this.#state.agents.length >= INPUT_LIMITS.agents) {
      throw new Error(`A host can have up to ${INPUT_LIMITS.agents} agents.`);
    }
    const name = requiredText(input.name, "Agent name", INPUT_LIMITS.agentName);
    const description = requiredText(input.description, "Agent description", INPUT_LIMITS.agentDescription);
    if (!isAvatarSeed(input.avatarSeed)) throw new Error("Invalid avatar seed.");
    if (input.avatarHue !== null && !isAvatarHue(input.avatarHue)) throw new Error("Invalid avatar hue.");
    const record = this.#createRecord(`agent-${randomUUID()}`, name, "", description);
    record.avatarSeed = input.avatarSeed;
    record.avatarHue = input.avatarHue;
    await mkdir(record.workspacePath, { recursive: true, mode: 0o700 });
    this.#state.agents.unshift(record);
    try {
      this.#persist("agent.created");
    } catch (error) {
      this.#state.agents = this.#state.agents.filter((candidate) => candidate.id !== record.id);
      await rm(record.workspacePath, { recursive: true, force: true });
      throw error;
    }
    return { ...record };
  }

  duplicateAgent(sourceId: string, operationId: string = randomUUID()): Promise<AgentSummary> {
    if (!isUuidV4(operationId)) throw new Error("Invalid agent duplication operation id.");
    return this.#enqueueCreation(() => this.#duplicateAgent(sourceId, operationId));
  }

  #enqueueCreation<T>(create: () => Promise<T>): Promise<T> {
    const operation = this.#creationQueue.then(create);
    this.#creationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #duplicateAgent(sourceId: string, operationId: string): Promise<AgentSummary> {
    if (this.#database.commandResult(duplicationCommandId(operationId)) !== undefined) {
      throw new Error("This agent duplication operation is already committed.");
    }
    if (this.#state.agents.length >= INPUT_LIMITS.agents) {
      throw new Error(`A host can have up to ${INPUT_LIMITS.agents} agents.`);
    }
    const source = this.#requireAgent(sourceId);
    const sourceProfileSignature = duplicationProfileSignature(source);
    const sourceWorkspaceManifest = await workspaceMetadataFingerprint(source.workspacePath);
    const sourceAvatar = this.resolveAvatar(source.id);
    const sourceAvatarSignature = sourceAvatar ? await fileFingerprint(sourceAvatar.path) : null;
    const id = `agent-${randomUUID()}`;
    const record = this.#createRecord(
      id,
      duplicateAgentName(source.name, this.#state.agents),
      source.title,
      source.description,
    );
    record.notifications = source.notifications;
    record.provider = source.provider;
    record.model = source.model;
    record.reasoningEffort = source.reasoningEffort;
    record.avatarSeed = source.avatarSeed;
    record.avatarHue = source.avatarHue;

    const stagedWorkspace = `${record.workspacePath}.openbot-stage`;
    const avatarDirectory = join(this.#avatarsRoot, record.id);
    const stagedAvatarDirectory = `${avatarDirectory}.openbot-stage`;
    const duplicationMarker = this.#duplicationMarkerPath(record.id);
    let stagedAvatarPath: string | null = null;
    try {
      await writeFile(duplicationMarker, `${JSON.stringify({ operationId, sourceAgentId: sourceId })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await cp(source.workspacePath, stagedWorkspace, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
      if (sourceAvatar) {
        await mkdir(stagedAvatarDirectory, { recursive: true, mode: 0o700 });
        const extension = avatarFileExtension(sourceAvatar.mimeType);
        stagedAvatarPath = join(stagedAvatarDirectory, `${sourceAvatar.version}.${extension}`);
        await copyFile(sourceAvatar.path, stagedAvatarPath);
        record.avatarUrl = agentAvatarUrl(record.id, sourceAvatar.version, sourceAvatar.mimeType);
      }
      if (
        duplicationProfileSignature(source) !== sourceProfileSignature ||
        (await workspaceMetadataFingerprint(source.workspacePath)) !== sourceWorkspaceManifest ||
        (stagedAvatarPath ? await fileFingerprint(stagedAvatarPath) : null) !== sourceAvatarSignature ||
        (sourceAvatar ? await fileFingerprint(sourceAvatar.path) : null) !== sourceAvatarSignature
      ) {
        throw new Error("The agent changed while it was being duplicated. Try again.");
      }
      await rewriteInternalWorkspaceSymlinks(source.workspacePath, stagedWorkspace, record.workspacePath);
      if (this.#state.agents.length >= INPUT_LIMITS.agents) {
        throw new Error(`A host can have up to ${INPUT_LIMITS.agents} agents.`);
      }
      record.name = duplicateAgentName(source.name, this.#state.agents);
      await rename(stagedWorkspace, record.workspacePath);
      if (sourceAvatar) await rename(stagedAvatarDirectory, avatarDirectory);
      this.#state.agents.unshift(record);
      try {
        this.#persist("agent.duplicated");
      } catch (error) {
        this.#state.agents = this.#state.agents.filter((candidate) => candidate.id !== record.id);
        throw error;
      }
      return { ...record };
    } catch (error) {
      await Promise.all([
        rm(stagedWorkspace, { recursive: true, force: true }),
        rm(record.workspacePath, { recursive: true, force: true }),
        rm(stagedAvatarDirectory, { recursive: true, force: true }),
        rm(avatarDirectory, { recursive: true, force: true }),
        rm(duplicationMarker, { force: true }),
      ]);
      throw error;
    }
  }

  committedAgentDuplication(operationId: string, sourceAgentId: string): DuplicateAgentResult | null {
    if (!isUuidV4(operationId)) throw new Error("Invalid agent duplication operation id.");
    const value = this.#database.commandResult(duplicationCommandId(operationId));
    if (value === undefined) return null;
    const result = isRecord(value) ? value.result : null;
    // A receipt is a row a *released* build wrote, and that build spelled these two keys `sourceBotId`
    // and `bot`. Migration v13 rewrote id values everywhere, so the value beside the key already reads
    // `agent-<uuid>` and matches the caller; only the key name is from before the rename. Reading one
    // spelling would make a duplication that committed before the upgrade throw on its first retry
    // instead of returning the copy the user already has.
    const resultAgent = isRecord(result) ? (result.agent ?? result.bot) : null;
    const resultLayout = isRecord(result) ? result.layout : null;
    const receiptSourceId = isRecord(value) ? (value.sourceAgentId ?? value.sourceBotId) : null;
    if (
      !isRecord(value) ||
      receiptSourceId !== sourceAgentId ||
      !isRecord(result) ||
      !isStoredAgent(resultAgent) ||
      !isSidebarLayoutSnapshot(resultLayout)
    ) {
      throw new Error("The agent duplication receipt is invalid.");
    }
    const agent = this.#state.agents.find((candidate) => candidate.id === resultAgent.id);
    if (!agent) throw new Error("The duplicated agent no longer exists.");
    return {
      agent: { ...agent },
      layout: structuredClone(resultLayout),
    };
  }

  async commitAgentDuplication(
    id: string,
    operationId: string,
    sourceAgentId: string,
    layout: SidebarLayoutSnapshot,
  ): Promise<DuplicateAgentResult> {
    const agent = this.#requireAgent(id);
    const marker = await this.#readDuplicationMarker(id);
    if (!marker || marker.operationId !== operationId || marker.sourceAgentId !== sourceAgentId) {
      throw new Error("This agent duplication marker is invalid.");
    }
    const result = { agent: { ...agent }, layout: structuredClone(layout) };
    const receipt = this.#database.dispatch(
      duplicationCommandId(operationId),
      [
        {
          aggregateType: "agent-duplications",
          aggregateId: id,
          eventType: "agent-duplication.committed",
          payload: { sourceAgentId, duplicateAgentId: id },
        },
      ],
      () => ({ sourceAgentId, result }),
    );
    await rm(this.#duplicationMarkerPath(id), { force: true }).catch(() => undefined);
    if (
      !isRecord(receipt) ||
      !isRecord(receipt.result) ||
      !isStoredAgent(receipt.result.agent) ||
      !isSidebarLayoutSnapshot(receipt.result.layout)
    ) {
      throw new Error("The agent duplication receipt is invalid.");
    }
    return {
      agent: { ...normalizeStoredAgent(receipt.result.agent) },
      layout: structuredClone(receipt.result.layout),
    };
  }

  async updateAgent(input: UpdateAgentInput): Promise<AgentSummary> {
    const agent = this.#requireAgent(input.agentId);
    if (input.name !== undefined) {
      agent.name = requiredText(input.name, "Agent name", INPUT_LIMITS.agentName);
    }
    if (input.title !== undefined) {
      agent.title = limitedText(input.title, "Agent title", INPUT_LIMITS.agentTitle);
    }
    if (input.description !== undefined) {
      agent.description = limitedText(input.description, "Agent description", INPUT_LIMITS.agentDescription);
    }
    if (input.notifications !== undefined) agent.notifications = input.notifications;
    if (input.provider !== undefined) agent.provider = input.provider;
    if (input.model !== undefined) {
      agent.model = input.model;
    }
    if (input.reasoningEffort !== undefined) agent.reasoningEffort = input.reasoningEffort;
    if (input.avatarSeed !== undefined) agent.avatarSeed = input.avatarSeed;
    if (input.avatarHue !== undefined) agent.avatarHue = input.avatarHue;
    agent.updatedAt = new Date().toISOString();
    this.#persist("agent.updated");
    return { ...agent };
  }

  setMarketplaceSource(agentId: string, source: NonNullable<AgentSummary["marketplaceSource"]>): AgentSummary {
    const agent = this.#requireAgent(agentId);
    agent.marketplaceSource = structuredClone(source);
    agent.updatedAt = new Date().toISOString();
    this.#persist("agent.marketplace-source-updated");
    return { ...agent, marketplaceSource: structuredClone(source) };
  }

  async setAvatar(agentId: string, image: AvatarImageInput | null): Promise<AgentSummary> {
    const operation = this.#avatarUpdateQueue.then(() => this.#setAvatar(agentId, image));
    this.#avatarUpdateQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #setAvatar(agentId: string, image: AvatarImageInput | null): Promise<AgentSummary> {
    const agent = this.#requireAgent(agentId);
    const previous = this.resolveAvatar(agentId);
    const previousAvatarUrl = agent.avatarUrl;
    const previousUpdatedAt = agent.updatedAt;
    if (image === null) {
      agent.avatarUrl = null;
      agent.updatedAt = new Date().toISOString();
      try {
        this.#persist("agent.avatar-removed");
      } catch (error) {
        agent.avatarUrl = previousAvatarUrl;
        agent.updatedAt = previousUpdatedAt;
        throw error;
      }
      if (previous) await rm(previous.path, { force: true }).catch(() => undefined);
      return { ...agent };
    }
    if (!isValidAvatarImage(image.mimeType, image.bytes)) {
      throw new Error("Choose a valid PNG, JPEG, or WebP image up to 512 KB.");
    }
    const version = randomUUID();
    const extension = avatarFileExtension(image.mimeType);
    const directory = join(this.#avatarsRoot, agent.id);
    const target = join(directory, `${version}.${extension}`);
    const temporary = `${target}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, image.bytes, { mode: 0o600 });
    await rename(temporary, target);
    agent.avatarUrl = agentAvatarUrl(agent.id, version, image.mimeType);
    agent.updatedAt = new Date().toISOString();
    try {
      this.#persist("agent.avatar-updated");
    } catch (error) {
      agent.avatarUrl = previousAvatarUrl;
      agent.updatedAt = previousUpdatedAt;
      await rm(target, { force: true });
      throw error;
    }
    if (previous) await rm(previous.path, { force: true }).catch(() => undefined);
    return { ...agent };
  }

  resolveAvatar(agentId: string): { path: string; mimeType: AvatarImageInput["mimeType"]; version: string } | null {
    const agent = this.#requireAgent(agentId);
    if (!agent.avatarUrl) return null;
    const parsed = parseAgentAvatarUrl(agent.avatarUrl, agent.id);
    if (!parsed) return null;
    const extension = avatarFileExtension(parsed.mimeType);
    return {
      path: join(this.#avatarsRoot, agent.id, `${parsed.version}.${extension}`),
      mimeType: parsed.mimeType,
      version: parsed.version,
    };
  }

  async deleteAgent(id: string): Promise<AgentSummary> {
    const agent = this.#requireAgent(id);
    this.#state.agents = this.#state.agents.filter((candidate) => candidate.id !== id);
    this.#database.hardDeleteAgent(`agents:hard-delete:${randomUUID()}`, id, agent.threadId, this.#state.agents);
    await Promise.all([
      rm(join(this.#avatarsRoot, id), { recursive: true, force: true }),
      rm(`${join(this.#avatarsRoot, id)}.openbot-stage`, { recursive: true, force: true }),
      rm(join(this.#agentsRoot, id), { recursive: true, force: true }),
      rm(`${join(this.#agentsRoot, id)}.openbot-stage`, { recursive: true, force: true }),
      rm(this.#duplicationMarkerPath(id), { force: true }),
    ]);
    // A workspace that could not follow the rename legitimately sits under the pre-rename root, and deleting
    // only the derived path would leave that agent's files behind. Every path here is derived rather than
    // read from `workspacePath`, because that column comes out of the user's own database file and a
    // recursive delete must never follow a string this code did not build.
    //
    // The agent's own id is always safe to clear under the old root: nobody else can be stored under it.
    // Migration v13 leaves a `bot-` id alone unless the application minted it, and a legacy `bots.json`
    // import runs afterwards and keeps both the id and the `~/OpenBot/Bots/<id>` workspace it read, so an
    // agent whose workspace is only ever there is a state the user can reach.
    const legacyPaths = [join(this.#legacyAgentsRoot, id)];
    const legacyId = this.#unclaimedLegacyId(id);
    if (legacyId !== null) {
      legacyPaths.push(join(this.#avatarsRoot, legacyId), join(this.#legacyAgentsRoot, legacyId));
    }
    await Promise.all(legacyPaths.map((path) => rm(path, { recursive: true, force: true })));
    return { ...agent };
  }

  async getOrCreate(id: string, name?: string, title?: string): Promise<AgentSummary> {
    validateAgentId(id);
    const existing = this.#state.agents.find((agent) => agent.id === id);
    if (existing) {
      await mkdir(existing.workspacePath, { recursive: true, mode: 0o700 });
      return { ...existing };
    }
    return this.#enqueueCreation(() => this.#getOrCreate(id, name, title));
  }

  async #getOrCreate(id: string, name?: string, title?: string): Promise<AgentSummary> {
    validateAgentId(id);
    const existing = this.#state.agents.find((agent) => agent.id === id);
    if (existing) {
      await mkdir(existing.workspacePath, { recursive: true, mode: 0o700 });
      return { ...existing };
    }
    if (this.#state.agents.length >= INPUT_LIMITS.agents) {
      throw new Error(`A host can have up to ${INPUT_LIMITS.agents} agents.`);
    }

    const record = this.#createRecord(id, name ?? titleFromId(id), title ?? "Local teammate");
    this.#state.agents.push(record);
    await mkdir(record.workspacePath, { recursive: true, mode: 0o700 });
    this.#persist("agent.created");
    return { ...record };
  }

  /**
   * The file half of migration v13: `~/OpenBot/Bots/bot-<uuid>` becomes `~/OpenBot/Agents/agent-<uuid>`,
   * and the uploaded avatar directory follows the id the same way. It cannot run inside that migration,
   * because `runMigration` rolls its transaction back on a throw and a directory that has already moved
   * cannot be rolled back.
   *
   * Resumable rather than atomic. On one volume `rename` is a single syscall, so no directory is ever
   * half-moved, and what an interrupted run already did is read from whether the target directory exists
   * -- never from a marker file, which can disagree with the disk. Nothing in here may stop the app: the
   * database has already migrated by this point, so refusing to start over a directory name would leave
   * the user with no way back in.
   */
  async #reconcileLegacyDirectories(): Promise<void> {
    let relocated = false;
    for (const agent of this.#state.agents) {
      relocated = (await this.#reconcileWorkspaceDirectory(agent)) || relocated;
      await this.#reconcileAvatarDirectory(agent);
    }
    if (relocated) this.#persist("agent.workspace-relocated");
    await this.#removeLegacyWorkspaceRoot();
  }

  /**
   * The name a pre-rename build would have given this agent, or `null` when another agent in the store is
   * living under it right now. `legacyAgentId` reads syntax, and syntax is not ownership: `bot-<uuid>` is
   * a valid id in its own right, so migration v13 leaving one in place beside an `agent-<uuid>` that shares
   * its UUID is a state the user can reach. Every caller here either deletes a directory recursively or
   * moves one, so a derived name that belongs to somebody else is the difference between tidying up after
   * the rename and destroying an agent nobody touched.
   *
   * An id the application never minted -- `chief`, or one the user chose -- keeps its spelling, and that is
   * not the same as having nothing to do: the *root* moved as well, so its workspace is still sitting in
   * `OpenBot/Bots` under exactly this name. Nobody else can hold it, because ids are unique.
   */
  #unclaimedLegacyId(id: string): string | null {
    const legacyId = legacyAgentId(id);
    if (legacyId === id) return id;
    return this.#state.agents.some((candidate) => candidate.id === legacyId) ? null : legacyId;
  }

  /**
   * Answers whether the agent's stored workspace path had to change, which is what has to be persisted.
   *
   * The destination is derived from the root and the id, never read from the stored path. An agent the
   * user named themselves came out of the upgrade still recorded under `OpenBot/Bots/<id>`, because
   * migration v13 rewrites id values and that id did not change -- so trusting the stored path would find
   * the workspace already "at" its destination and leave it in the old root forever.
   */
  async #reconcileWorkspaceDirectory(agent: StoredAgent): Promise<boolean> {
    const legacyId = this.#unclaimedLegacyId(agent.id);
    if (legacyId === null) return false;
    const targetPath = join(this.#agentsRoot, agent.id);
    const legacyPath = join(this.#legacyAgentsRoot, legacyId);
    if (legacyPath === targetPath) return false;
    // A probe that cannot answer is not permission to guess. `EACCES` on either directory, or a Windows
    // lock, leaves this run unable to tell a moved workspace from a missing one -- so it does nothing and
    // the next launch tries again, rather than moving a directory on a false negative.
    const current = await probeDirectory(targetPath);
    const legacy = await probeDirectory(legacyPath);
    if (current !== false || legacy !== true) {
      // A previous run moved the files but was interrupted before it could persist where they went -- and
      // only then. Two directories at once is not that story: the move is a single atomic `rename`, so it
      // never leaves both behind, and what this run is looking at is a destination that was never this
      // agent's. Repointing the record at it would hand the agent somebody else's files and put its own
      // out of reach, so an ambiguous pair leaves the path the agent has actually been reading alone.
      if (current === true && legacy === false && agent.workspacePath !== targetPath) {
        agent.workspacePath = targetPath;
        return true;
      }
      return false;
    }
    try {
      await rename(legacyPath, targetPath);
      if (agent.workspacePath === targetPath) return false;
      agent.workspacePath = targetPath;
      return true;
    } catch (error) {
      // Only the move failed; the workspace itself is still there and still readable. `EXDEV` means
      // `~/OpenBot/Bots` is a link onto another volume, so the move would be a copy, and a copy of a
      // workspace interrupted halfway is lost data. A permission error, a Windows lock or an open handle
      // leave exactly the same situation, so they get the same answer: the files stay where they are and
      // the stored path is pointed back at them. An out-of-date directory name is cosmetic.
      logger.warn("Could not move an agent workspace to its new directory.", toLogValue(error));
      if (agent.workspacePath === legacyPath) return false;
      agent.workspacePath = legacyPath;
      return true;
    }
  }

  /**
   * An uploaded avatar lives under the agent id, and `avatarUrl` derives that directory from the id
   * migration v13 has just rewritten. Without this the file is still on disk under the old name and the
   * app looks for it under the new one, so every uploaded avatar silently falls back to a drawn face.
   */
  async #reconcileAvatarDirectory(agent: StoredAgent): Promise<void> {
    const legacyId = this.#unclaimedLegacyId(agent.id);
    // An avatar directory is named after the id alone, so an id the rename left untouched has nowhere to
    // move from. Only the workspace root changed for those.
    if (legacyId === null || legacyId === agent.id) return;
    const currentPath = join(this.#avatarsRoot, agent.id);
    const legacyPath = join(this.#avatarsRoot, legacyId);
    if ((await probeDirectory(legacyPath)) !== true) return;
    const current = await probeDirectory(currentPath);
    if (current === true) {
      await this.#adoptLegacyAvatarFile(agent, legacyPath, currentPath);
      return;
    }
    if (current !== false) return;
    try {
      await rename(legacyPath, currentPath);
    } catch (error) {
      logger.warn("Could not move an uploaded agent avatar to its new directory.", toLogValue(error));
    }
  }

  /**
   * Both directories exist, so neither can be moved onto the other -- but abandoning the old one strands the
   * avatar the user actually uploaded, because `avatarUrl` resolves only under the new id and the app would
   * fall back to a drawn face. What that URL names is one file, and one file is what gets carried across.
   * Nothing is overwritten: a name already answering in the new directory is the newer upload.
   */
  async #adoptLegacyAvatarFile(agent: StoredAgent, legacyPath: string, currentPath: string): Promise<void> {
    if (!agent.avatarUrl) return;
    const parsed = parseAgentAvatarUrl(agent.avatarUrl, agent.id);
    if (!parsed) return;
    const name = `${parsed.version}.${avatarFileExtension(parsed.mimeType)}`;
    try {
      if (await fileExists(join(currentPath, name))) return;
      await rename(join(legacyPath, name), join(currentPath, name));
    } catch (error) {
      logger.warn("Could not move an uploaded agent avatar to its new directory.", toLogValue(error));
    }
  }

  async #removeLegacyWorkspaceRoot(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#legacyAgentsRoot);
    } catch (error) {
      // A legacy root that cannot even be listed is one this run leaves alone.
      if (!isRecord(error) || error.code !== "ENOENT") {
        logger.warn("Could not read the legacy workspace root.", toLogValue(error));
      }
      return;
    }
    // Unfinished copies from a duplication that crashed. Nothing committed ever points at one, so they
    // are deleted rather than moved.
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".openbot-stage"))
        .map((entry) =>
          rm(join(this.#legacyAgentsRoot, entry), { recursive: true, force: true }).catch((error: unknown) => {
            logger.warn("Could not remove an unfinished copy under the legacy workspace root.", toLogValue(error));
          }),
        ),
    );
    if (!entries.every((entry) => entry.endsWith(".openbot-stage"))) return;
    try {
      await rmdir(this.#legacyAgentsRoot);
    } catch (error) {
      // Something arrived between the listing and the removal, or the root is not ours to delete. An
      // empty directory left behind costs nothing.
      logger.warn("Could not remove the legacy workspace root.", toLogValue(error));
    }
  }

  async #recoverPendingDuplications(): Promise<void> {
    const entries = await readdir(this.#duplicationsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".pending")) continue;
      const id = entry.name.slice(0, -".pending".length);
      if (!isGeneratedAgentId(id)) continue;
      const agent = this.#agentByEitherSpelling(id);
      const marker = await this.#readDuplicationMarker(id);
      // Everything below addresses the agent by the id it has *now*, which the marker name only equals
      // when the same build wrote both. Using the file name would filter nothing out of the roster and
      // hard-delete an id no row carries, leaving the half-made duplicate visible in the sidebar.
      const agentId = agent?.id ?? id;
      if (agent && marker) {
        const committed = this.committedAgentDuplication(marker.operationId, marker.sourceAgentId);
        if (committed?.agent.id === agentId) {
          await rm(join(this.#duplicationsRoot, entry.name), { force: true });
          continue;
        }
      }
      if (agent) {
        this.#state.agents = this.#state.agents.filter((candidate) => candidate.id !== agentId);
        this.#database.hardDeleteAgent(
          `agents:duplicate-recovery:${randomUUID()}`,
          agentId,
          agent.threadId,
          this.#state.agents,
        );
      }
      // The copy this marker was tracking was made by whichever build crashed, so it can be sitting
      // under either root, under either spelling of the id. Removing only the current one reports a
      // clean recovery and leaves the half-written workspace on disk forever.
      const names = agentId === id ? [id] : [id, agentId];
      const roots = [this.#agentsRoot, this.#legacyAgentsRoot, this.#avatarsRoot];
      await Promise.all([
        ...roots.flatMap((root) =>
          names.flatMap((name) => [
            rm(join(root, name), { recursive: true, force: true }),
            rm(`${join(root, name)}.openbot-stage`, { recursive: true, force: true }),
          ]),
        ),
        rm(join(this.#duplicationsRoot, entry.name), { force: true }),
      ]);
    }
  }

  /**
   * The agent an id names, whether it is spelled the way this build writes ids or the way the build that
   * wrote the file on disk did. The exact spelling is tried first, because migration v13 leaves a `bot-`
   * id alone when the `agent-` spelling is already taken and both agents can then exist at once.
   */
  #agentByEitherSpelling(id: string): StoredAgent | undefined {
    return (
      this.#state.agents.find((candidate) => candidate.id === id) ??
      this.#state.agents.find((candidate) => legacyAgentId(candidate.id) === id)
    );
  }

  #duplicationMarkerPath(id: string): string {
    return join(this.#duplicationsRoot, `${id}.pending`);
  }

  async #readDuplicationMarker(id: string): Promise<AgentDuplicationMarker | null> {
    try {
      const value = JSON.parse(await readFile(this.#duplicationMarkerPath(id), "utf8"));
      // A marker on disk was written by whichever build crashed, and a released one spells this
      // `sourceBotId`. Failing to read it drops the file on the floor: recovery cannot then tell a
      // duplication that finished from one that died mid-copy, so it deletes the agent the user kept
      // along with its workspace.
      const storedSource = isRecord(value) ? (value.sourceAgentId ?? value.sourceBotId) : null;
      if (
        !isRecord(value) ||
        !isString(value.operationId) ||
        !isUuidV4(value.operationId) ||
        !isString(storedSource) ||
        !storedSource
      ) {
        return null;
      }
      // The value beside that key names the source agent as it was spelled when the marker was written,
      // and migration v13 has renamed it since. Nothing rewrites a file outside the database, so the
      // receipt this is about to be compared against already says `agent-<uuid>` while the marker still
      // says `bot-<uuid>`: comparing them raw throws "The agent duplication receipt is invalid." out of
      // recovery, and the app never finishes starting.
      const sourceAgentId = this.#agentByEitherSpelling(storedSource)?.id ?? storedSource;
      return { operationId: value.operationId, sourceAgentId };
    } catch {
      return null;
    }
  }

  async ensureThreadId(id: string): Promise<string> {
    return this.ensureThreadIdNow(id);
  }

  ensureThreadIdNow(id: string): string {
    const agent = this.#requireAgent(id);
    if (agent.threadId) return agent.threadId;
    agent.threadId = `openbot-thread-${randomUUID()}`;
    agent.updatedAt = new Date().toISOString();
    this.#persist("thread.created");
    return agent.threadId;
  }

  restoreThreadIdentity(id: string, threadId: string | null, updatedAt: string | null): void {
    const agent = this.#requireAgent(id);
    agent.threadId = threadId;
    agent.updatedAt = updatedAt;
  }

  activeProviderSession(id: string): ProviderSession | null {
    const agent = this.#requireAgent(id);
    if (!agent.threadId) return null;
    return this.#database.activeProviderSession(agent.threadId, agent.provider);
  }

  bindProviderSession(id: string, externalSessionId: string): ProviderSession {
    const agent = this.#requireAgent(id);
    if (!agent.threadId) throw new Error(`Agent ${id} does not have an OpenBot thread.`);
    return this.#database.bindProviderSession({
      threadId: agent.threadId,
      provider: agent.provider,
      externalSessionId,
      model: agent.model,
      effort: agent.reasoningEffort,
    });
  }

  async updatePreview(id: string, preview: string): Promise<void> {
    const agent = this.#requireAgent(id);
    agent.preview = preview.slice(0, 180);
    agent.updatedAt = new Date().toISOString();
    this.#persist("agent.preview-updated");
  }

  async #readState(): Promise<StoredState> {
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8"));
      const stored = isRecord(parsed) ? parsed[LEGACY_AGENTS_STATE_KEY] : null;
      if (!isRecord(parsed) || !isBoolean(parsed.examplesInitialized) || !Array.isArray(stored)) {
        throw new Error("Agent state is corrupt or from a newer OpenBot version; refusing to overwrite it.");
      }
      if (stored.some((agent) => isRecord(agent) && "role" in agent)) {
        throw new Error("Stored agent profiles use the old role field; update the data before starting OpenBot.");
      }

      let agents: StoredAgent[];
      if (parsed.version === 1 && stored.every(isLegacyStoredAgent)) {
        agents = stored.map(migrateLegacyAgent);
      } else if (parsed.version === 2 && stored.every(isStoredAgent)) {
        agents = stored.map(normalizeStoredAgent);
      } else {
        throw new Error("Agent state is corrupt or from a newer OpenBot version; refusing to overwrite it.");
      }
      if (new Set(agents.map((agent) => agent.id)).size !== agents.length) {
        throw new Error("Agent state contains duplicate agent ids; refusing to overwrite it.");
      }
      return { version: 2, examplesInitialized: parsed.examplesInitialized, agents };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return { version: 2, examplesInitialized: false, agents: [] };
      }
      throw error;
    }
  }

  #persist(eventType: string): void {
    this.#database.replaceAgents(`agents:${eventType}:${randomUUID()}`, this.#state.agents, eventType);
  }

  #createRecord(id: string, name: string, title: string, description = ""): StoredAgent {
    validateAgentId(id);
    return {
      id,
      name,
      title,
      description,
      notifications: true,
      provider: DEFAULT_AGENT_PROVIDER,
      model: DEFAULT_AGENT_MODEL,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      threadId: null,
      workspacePath: join(this.#agentsRoot, id),
      preview: "No messages yet",
      updatedAt: null,
      avatarSeed: id,
      avatarHue: null,
      avatarUrl: null,
    };
  }

  #requireAgent(id: string): StoredAgent {
    const agent = this.#state.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new Error(`Unknown agent: ${id}`);
    return agent;
  }
}

function requiredText(value: string, label: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  if (trimmed.length > maxLength) throw new Error(`${label} is too long.`);
  return trimmed;
}

function limitedText(value: string, label: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${label} is too long.`);
  return trimmed;
}

function duplicateAgentName(sourceName: string, agents: readonly StoredAgent[]): string {
  const match = /^(.*?)(?: copy(?: (\d+))?)$/iu.exec(sourceName);
  const base = match?.[1]?.trim() || sourceName.trim();
  const existing = new Set(agents.map((agent) => agent.name.toLocaleLowerCase()));
  for (let index = 1; index <= INPUT_LIMITS.agents + 1; index += 1) {
    const suffix = index === 1 ? " copy" : ` copy ${index}`;
    const candidate = `${base.slice(0, Math.max(1, INPUT_LIMITS.agentName - suffix.length)).trimEnd()}${suffix}`;
    if (!existing.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error("OpenBot could not create a unique agent copy name.");
}

/**
 * The part of an agent a copy is actually built from, which is what "the agent changed" has to mean.
 *
 * `preview`, `updatedAt` and `threadId` move on their own the moment a message lands, and a
 * duplicate takes none of the three — it gets a fresh thread and its own empty preview. Signing them
 * aborted duplications that were never incoherent, and copying a large workspace takes long enough
 * for an incoming message to land inside the window. Everything else is signed by omission, so a new
 * `AgentSummary` field is guarded until someone decides otherwise here.
 */
export function duplicationProfileSignature(agent: AgentSummary): string {
  const { preview, updatedAt, threadId, ...copied } = agent;
  return JSON.stringify(copied);
}

function duplicationCommandId(operationId: string): string {
  return `agent-duplication:${operationId}`;
}

async function rewriteInternalWorkspaceSymlinks(
  sourceRoot: string,
  stagedRoot: string,
  finalRoot: string,
): Promise<void> {
  const canonicalSourceRoot = await realpath(sourceRoot);
  const visit = async (stagedDirectory: string, sourceDirectory: string, finalDirectory: string): Promise<void> => {
    const entries = await readdir(stagedDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const stagedPath = join(stagedDirectory, entry.name);
      const sourcePath = join(sourceDirectory, entry.name);
      const finalPath = join(finalDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(stagedPath);
        const resolvedSourceTarget = resolve(dirname(sourcePath), target);
        let sourceRelativePath: string;
        try {
          const canonicalTarget = await realpath(resolvedSourceTarget);
          if (!isPathWithin(canonicalSourceRoot, canonicalTarget)) continue;
          sourceRelativePath = relative(canonicalSourceRoot, canonicalTarget);
        } catch {
          if (!isPathWithin(sourceRoot, resolvedSourceTarget)) continue;
          sourceRelativePath = relative(sourceRoot, resolvedSourceTarget);
        }
        const finalTarget = join(finalRoot, sourceRelativePath);
        const rewrittenTarget = isAbsolute(target) ? finalTarget : relative(dirname(finalPath), finalTarget) || ".";
        await rm(stagedPath);
        await symlink(rewrittenTarget, stagedPath);
      } else if (entry.isDirectory()) {
        await visit(stagedPath, sourcePath, finalPath);
      }
    }
  };
  await visit(stagedRoot, sourceRoot, finalRoot);
}

function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function workspaceMetadataFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stats = await lstat(path, { bigint: true });
      hash.update(`${relativePath}\0${stats.mode}\0${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}\0`);
      if (stats.isSymbolicLink()) {
        hash.update(`link\0${await readlink(path)}\0`);
      } else if (stats.isDirectory()) {
        hash.update("directory\0");
        await visit(path, relativePath);
      } else if (stats.isFile()) {
        hash.update("file\0");
      } else {
        hash.update("other\0");
      }
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

async function fileFingerprint(path: string): Promise<string> {
  const stats = await lstat(path);
  const hash = createHash("sha256");
  hash.update(`${stats.mode}\0`);
  await updateHashFromFile(hash, path);
  return hash.digest("hex");
}

async function updateHashFromFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk);
}

function validateAgentId(id: string): void {
  if (!isValidAgentId(id)) {
    throw new Error("Invalid agent id.");
  }
}

function isValidAgentId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && basename(id) === id;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * {@link directoryExists}, but for the startup reconciliation, which runs after the database has already
 * migrated and so must never be the reason the app refuses to open. `null` is "could not tell" -- an
 * `EACCES`, an `EPERM`, a Windows lock -- and every caller treats it as "leave this alone".
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function probeDirectory(path: string): Promise<boolean | null> {
  try {
    return await directoryExists(path);
  } catch (error) {
    logger.warn("Could not check an agent directory during startup reconciliation.", toLogValue(error));
    return null;
  }
}

function titleFromId(id: string): string {
  return id
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function isStoredAgentBase(value: unknown): value is StoredAgentBase {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isValidAgentId(value.id) &&
    isString(value.name) &&
    isString(value.title) &&
    isString(value.description) &&
    isBoolean(value.notifications) &&
    isAgentModel(value.model) &&
    isReasoningEffort(value.reasoningEffort) &&
    (isString(value.threadId) || value.threadId === null) &&
    isString(value.workspacePath) &&
    isString(value.preview) &&
    (isString(value.updatedAt) || value.updatedAt === null)
  );
}

function isStoredAgent(value: unknown): value is PersistedStoredAgent {
  if (!isRecord(value) || !isStoredAgentBase(value)) return false;
  const record = value;
  return (
    (record.provider === undefined || isOneOf(AGENT_PROVIDERS, record.provider)) &&
    isAvatarSeed(record.avatarSeed) &&
    (record.avatarHue === null || isAvatarHue(record.avatarHue)) &&
    isMarketplaceSource(record.marketplaceSource)
  );
}

function isMarketplaceSource(value: unknown): boolean {
  if (value === undefined) return true;
  // Agents installed before the marketplace listing id was renamed spell it `agentId`, which now
  // means the local agent everywhere else. Both spellings are accepted here; `normalizeStoredAgent`
  // writes only the new one back.
  return (
    isRecord(value) &&
    (isString(value.listingId) || isString(value.agentId)) &&
    isString(value.versionId) &&
    isNumber(value.version) &&
    Number.isInteger(value.version) &&
    value.version > 0 &&
    Array.isArray(value.skillIds) &&
    value.skillIds.every(isString) &&
    Array.isArray(value.routineIds) &&
    value.routineIds.every(isString)
  );
}

function isLegacyStoredAgent(value: unknown): value is LegacyStoredAgent {
  if (!isRecord(value) || !isStoredAgentBase(value)) return false;
  const record = value;
  return (
    isString(record.avatarShape) &&
    isOneOf(LEGACY_AVATAR_VARIANTS, record.avatarShape) &&
    isString(record.avatarColor) &&
    isOneOf(LEGACY_AVATAR_COLORS, record.avatarColor)
  );
}

function migrateLegacyAgent(agent: LegacyStoredAgent): StoredAgent {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    description: agent.description,
    notifications: agent.notifications,
    provider: providerForLegacyModel(agent.model),
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    threadId: agent.threadId,
    workspacePath: agent.workspacePath,
    preview: agent.preview,
    updatedAt: agent.updatedAt,
    avatarSeed: agent.id,
    avatarHue: null,
    avatarUrl: null,
  };
}

function normalizeStoredAgent(agent: PersistedStoredAgent): StoredAgent {
  return {
    ...agent,
    provider: agent.provider ?? providerForLegacyModel(agent.model),
    avatarUrl: isString(agent.avatarUrl) && parseAgentAvatarUrl(agent.avatarUrl, agent.id) ? agent.avatarUrl : null,
    ...(agent.marketplaceSource === undefined
      ? {}
      : { marketplaceSource: normalizeMarketplaceSource(agent.marketplaceSource) }),
  };
}

/**
 * Agents installed before the marketplace listing id was renamed spell it `agentId`, which now means
 * the local agent everywhere else. `isMarketplaceSource` accepts either spelling; this writes only
 * the new one back, so a stored agent converts the first time it is read.
 */
function normalizeMarketplaceSource(value: unknown): NonNullable<StoredAgent["marketplaceSource"]> {
  if (!isRecord(value)) throw new Error("The stored marketplace source is invalid.");
  const listingId = isString(value.listingId) ? value.listingId : value.agentId;
  if (!isString(listingId) || !isString(value.versionId) || !isNumber(value.version)) {
    throw new Error("The stored marketplace source has no listing id.");
  }
  return {
    listingId,
    versionId: value.versionId,
    version: value.version,
    skillIds: stringList(value.skillIds),
    routineIds: stringList(value.routineIds),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(isString)) throw new Error("The stored marketplace source is invalid.");
  return [...value];
}

function agentAvatarUrl(agentId: string, version: string, mimeType: string): string {
  const url = new URL(`openbot-avatar://agent/${encodeURIComponent(agentId)}`);
  url.searchParams.set("v", version);
  url.searchParams.set("type", mimeType);
  return url.toString();
}

function parseAgentAvatarUrl(
  value: string,
  expectedAgentId: string,
): { version: string; mimeType: AvatarImageInput["mimeType"] } | null {
  try {
    const url = new URL(value);
    const agentId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
    const version = url.searchParams.get("v") ?? "";
    const mimeType = url.searchParams.get("type") ?? "";
    if (
      url.protocol !== "openbot-avatar:" ||
      url.hostname !== "agent" ||
      agentId !== expectedAgentId ||
      !isUuidV4(version) ||
      !isAvatarMimeType(mimeType)
    ) {
      return null;
    }
    return { version, mimeType };
  } catch {
    return null;
  }
}
