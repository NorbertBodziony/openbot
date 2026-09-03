import type { ComputerUseMacSetupState, ProviderRuntimeSnapshot } from "./ipc-app-auth";
import type { BrowserPreview } from "./ipc-browser";
import {
  type AccountUsage,
  type AgentModelOption,
  type AgentStatus,
  type BotMemory,
  type BotSummary,
  type ConversationMessage,
  type ConversationPage,
  type ConversationReadState,
  type ConversationSearchPage,
  type ConversationWithReadState,
  type DraftAttachment,
  type DuplicateBotResult,
  type FilePreview,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isBotMemory,
  isConversationMessage,
  isReasoningEffort,
  isRoutine,
  isRoutineRun,
  isRoutineSchedule,
  isSidebarLayoutSnapshot,
  type QueuedMessageReceipt,
  type QueueSnapshot,
  type Routine,
  type RoutineRun,
  type SidebarLayoutSnapshot,
} from "./ipc-conversation";
import {
  type DynamicIslandAction,
  type DynamicIslandGeometry,
  type DynamicIslandPreference,
  type DynamicIslandPresentation,
  isDynamicIslandAction,
  isDynamicIslandNotchSize,
  isDynamicIslandPreference,
  isDynamicIslandPresentation,
} from "./ipc-dynamic-island";
import type { HostedSiteSummary } from "./ipc-hosted-sites";
import type {
  AgentPublicationPreview,
  AgentSubmission,
  MarketplaceAgentDetail,
  MarketplaceAgentPage,
  MarketplaceAgentSummary,
} from "./ipc-marketplace-agents";
import {
  type InstalledSkill,
  isSkillCategory,
  type MarketplaceSkillDetail,
  type MarketplaceSkillPage,
  type SkillPackagePreview,
  type SkillSubmission,
} from "./ipc-skills";
import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

export function decodeComputerUseMacSetupState(value: unknown): ComputerUseMacSetupState {
  if (
    !isDynamicRecord(value) ||
    !isOneOf(["available", "unavailable", "unsupported"] as const, value.status) ||
    !isString(value.helperName) ||
    (value.helperIconDataUrl !== null && !isString(value.helperIconDataUrl)) ||
    (value.message !== null && !isString(value.message))
  ) {
    throw new Error("Invalid Computer Use macOS setup state.");
  }
  return {
    status: value.status,
    helperName: value.helperName,
    helperIconDataUrl: value.helperIconDataUrl,
    message: value.message,
  };
}

export function record(value: unknown, label: string): DynamicRecord {
  if (!isDynamicRecord(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

export function decodeBrowserPreview(value: unknown): BrowserPreview {
  const preview = record(value, "browser preview");
  const dataUrl = requiredString(preview, "dataUrl");
  const width = requiredNumber(preview, "width");
  const height = requiredNumber(preview, "height");
  if (
    dataUrl.length > 2_000_000 ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl) ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    width > 960 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    height > 600
  ) {
    throw new Error("Invalid browser preview.");
  }
  return { dataUrl, width, height };
}

export function nullableString(value: unknown, label: string): value is string | null {
  if (value !== null && !isString(value)) throw new Error(`Invalid ${label}.`);
  return true;
}

export function decodeVoid(value: unknown): undefined {
  if (value !== undefined && value !== null) throw new Error("IPC returned unexpected data.");
  return undefined;
}

export function decodeHostedSite(value: unknown): HostedSiteSummary {
  const site = record(value, "hosted site");
  if (
    !isString(site.id) ||
    !isString(site.hostname) ||
    !isString(site.url) ||
    !isString(site.title) ||
    !isString(site.description) ||
    (site.framework !== "vanilla" && site.framework !== "astro") ||
    (site.status !== "active" && site.status !== "deleted" && site.status !== "expired" && site.status !== "blocked") ||
    !isNumber(site.fileCount) ||
    !isNumber(site.size) ||
    (site.expiresAt !== null && !isString(site.expiresAt)) ||
    !isString(site.updatedAt)
  ) {
    throw new Error("Invalid hosted site response.");
  }
  return {
    id: site.id,
    hostname: site.hostname,
    url: site.url,
    title: site.title,
    description: site.description,
    framework: site.framework,
    status: decodeHostedSiteStatus(site.status),
    fileCount: site.fileCount,
    size: site.size,
    expiresAt: site.expiresAt,
    updatedAt: site.updatedAt,
  };
}

export function decodeHostedSiteStatus(value: unknown): HostedSiteSummary["status"] {
  if (value === "active" || value === "deleted" || value === "expired" || value === "blocked") return value;
  throw new Error("Invalid hosted site status.");
}

export function decodeHostedSites(value: unknown): HostedSiteSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid hosted site list response.");
  return value.map(decodeHostedSite);
}

export function decodeNullablePath(value: unknown): string | null {
  if (value !== null && !isString(value)) throw new Error("Invalid directory response.");
  return value;
}

export function decodeDynamicIslandPreference(value: unknown): DynamicIslandPreference {
  if (!isDynamicIslandPreference(value)) throw new Error("Invalid Dynamic Island preference response.");
  return value;
}

export function decodeDynamicIslandGeometry(value: unknown): DynamicIslandGeometry {
  if (value === null) return null;
  if (!isDynamicIslandNotchSize(value)) throw new Error("Invalid Dynamic Island geometry.");
  return value;
}

export function decodeDynamicIslandPresentation(value: unknown): DynamicIslandPresentation {
  if (!isDynamicIslandPresentation(value)) throw new Error("Invalid Dynamic Island presentation.");
  return value;
}

export function decodeDynamicIslandAction(value: unknown): DynamicIslandAction {
  if (isDynamicIslandAction(value)) return value;
  throw new Error("Invalid Dynamic Island action.");
}

export function decodeRoutine(value: unknown): Routine {
  if (!isRoutine(value)) throw new Error("Invalid routine response.");
  return value;
}

export function decodeRoutines(value: unknown): Routine[] {
  if (!Array.isArray(value) || !value.every(isRoutine)) throw new Error("Invalid routine list response.");
  return value;
}

export function decodeRoutineRun(value: unknown): RoutineRun {
  if (!isRoutineRun(value)) throw new Error("Invalid routine run response.");
  return value;
}

export function decodeRoutineRuns(value: unknown): RoutineRun[] {
  if (!Array.isArray(value) || !value.every(isRoutineRun)) throw new Error("Invalid routine history response.");
  return value;
}

export function decodeFilePreview(value: unknown): FilePreview {
  const preview = record(value, "file preview");
  if (
    !isString(preview.name) ||
    !isNumber(preview.size) ||
    !isString(preview.mimeType) ||
    (preview.previewKind !== "markdown" &&
      preview.previewKind !== "text" &&
      preview.previewKind !== "image" &&
      preview.previewKind !== "pdf" &&
      preview.previewKind !== "none") ||
    (preview.bytes !== null && !(preview.bytes instanceof Uint8Array))
  ) {
    throw new Error("Invalid file preview response.");
  }
  return {
    name: preview.name,
    size: preview.size,
    mimeType: preview.mimeType,
    previewKind: preview.previewKind,
    bytes: preview.bytes,
  };
}

export function decodeAgentStatus(value: unknown): AgentStatus {
  if (!isAgentStatusValue(value)) throw new Error("Invalid agent status response.");
  return value;
}

export function decodeProviderRuntimeSnapshot(value: unknown): ProviderRuntimeSnapshot {
  if (!isDynamicRecord(value) || !isNumber(value.revision) || !isDynamicRecord(value.providers)) {
    throw new Error("Invalid provider runtime response.");
  }
  const decoded: Partial<ProviderRuntimeSnapshot["providers"]> = {};
  for (const provider of ["codex", "claude", "grok"] as const) {
    const status = value.providers[provider];
    if (
      !isDynamicRecord(status) ||
      !isOneOf(["not-downloaded", "downloading", "finishing", "ready", "download-error"] as const, status.phase) ||
      (status.progress !== null && !isNumber(status.progress)) ||
      !nullableString(status.message, "provider runtime message") ||
      !nullableString(status.version, "provider runtime version")
    ) {
      throw new Error("Invalid provider runtime response.");
    }
    decoded[provider] = {
      phase: status.phase,
      progress: status.progress,
      message: status.message,
      version: status.version,
    };
  }
  const { codex, claude, grok } = decoded;
  if (!codex || !claude || !grok) throw new Error("Invalid provider runtime response.");
  return { revision: value.revision, providers: { codex, claude, grok } };
}

export function isAgentStatusValue(value: unknown): value is AgentStatus {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.auth)) return false;
  if (!isDynamicRecord(value.capabilities)) return false;
  return (
    isString(value.phase) &&
    (value.cliVersion === null || isString(value.cliVersion)) &&
    isString(value.auth.kind) &&
    isString(value.capabilities.chat) &&
    isString(value.capabilities.browser) &&
    isString(value.capabilities.computerUse) &&
    nullableString(value.message, "status message") &&
    value.fullAccess === true
  );
}

export function decodeAccountUsage(value: unknown): AccountUsage {
  if (!isAccountUsageValue(value)) throw new Error("Invalid agent usage response.");
  return value;
}

export function isAccountUsageValue(value: unknown): value is AccountUsage {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.limits) &&
    value.limits.every(
      (limit) =>
        isDynamicRecord(limit) &&
        isString(limit.id) &&
        (limit.primary === null || isDynamicRecord(limit.primary)) &&
        (limit.secondary === null || isDynamicRecord(limit.secondary)),
    )
  );
}

export function decodeAgentModels(value: unknown): AgentModelOption[] {
  if (!isAgentModelList(value)) throw new Error("Invalid agent model response.");
  return value;
}

export function isAgentModelList(value: unknown): value is AgentModelOption[] {
  return (
    Array.isArray(value) &&
    value.every(
      (model) =>
        isDynamicRecord(model) &&
        isAgentModel(model.id) &&
        isString(model.name) &&
        isString(model.description) &&
        isReasoningEffort(model.defaultReasoningEffort) &&
        Array.isArray(model.supportedReasoningEfforts) &&
        model.supportedReasoningEfforts.every(isReasoningEffort),
    )
  );
}

export function decodeBot(value: unknown): BotSummary {
  if (!isBotSummary(value)) throw new Error("Invalid agent response.");
  return value;
}

export function isBotSummary(value: unknown): value is BotSummary {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.title) &&
    isString(value.description) &&
    isBoolean(value.notifications) &&
    isAgentModel(value.model) &&
    isReasoningEffort(value.reasoningEffort) &&
    nullableString(value.threadId, "thread ID") &&
    isString(value.workspacePath) &&
    isString(value.preview) &&
    nullableString(value.updatedAt, "updated at") &&
    isString(value.avatarSeed) &&
    (value.avatarHue === null || isNumber(value.avatarHue)) &&
    nullableString(value.avatarUrl, "avatar URL") &&
    (value.marketplaceSource === undefined ||
      (isDynamicRecord(value.marketplaceSource) &&
        isString(value.marketplaceSource.agentId) &&
        isString(value.marketplaceSource.versionId) &&
        isNumber(value.marketplaceSource.version) &&
        Number.isInteger(value.marketplaceSource.version) &&
        Array.isArray(value.marketplaceSource.skillIds) &&
        value.marketplaceSource.skillIds.every(isString) &&
        Array.isArray(value.marketplaceSource.routineIds) &&
        value.marketplaceSource.routineIds.every(isString)))
  );
}

export function decodeBots(value: unknown): BotSummary[] {
  if (!Array.isArray(value) || !value.every(isBotSummary)) {
    throw new Error("Invalid agent list response.");
  }
  return value;
}

export function decodeMemory(value: unknown): BotMemory {
  if (!isBotMemory(value)) throw new Error("Invalid agent memory response.");
  return value;
}

export function decodeMemories(value: unknown): BotMemory[] {
  if (!Array.isArray(value) || !value.every(isBotMemory)) throw new Error("Invalid agent memories response.");
  return value;
}

export function decodeSidebarLayout(value: unknown): SidebarLayoutSnapshot {
  if (!isSidebarLayoutSnapshot(value)) throw new Error("Invalid sidebar layout response.");
  return value;
}

export function decodeDuplicateBotResult(value: unknown): DuplicateBotResult {
  const item = record(value, "agent duplication");
  return { bot: decodeBot(item.bot), layout: decodeSidebarLayout(item.layout) };
}

export function decodeConversation(value: unknown): ConversationWithReadState {
  if (!isConversationWithReadState(value)) throw new Error("Invalid conversation response.");
  return value;
}

export function decodeConversationPage(value: unknown): ConversationPage {
  if (!isDynamicRecord(value) || !isString(value.botId) || !Array.isArray(value.messages)) {
    throw new Error("Invalid conversation page response.");
  }
  const pageInfo = record(value.pageInfo, "conversation page info");
  return {
    botId: value.botId,
    threadId: requiredNullableString(value, "threadId"),
    activeTurnId: requiredNullableString(value, "activeTurnId"),
    revision: requiredNumber(value, "revision"),
    messages: decodeConversationMessages(value.messages),
    references: decodeConversationReferences(value.references),
    pageInfo: {
      hasOlder: requiredBoolean(pageInfo, "hasOlder"),
      olderCursor: requiredNullableString(pageInfo, "olderCursor"),
    },
    ...(value.readState === undefined ? {} : { readState: decodeReadState(value.readState) }),
  };
}

export function decodeConversationSearchPage(value: unknown): ConversationSearchPage {
  const item = record(value, "conversation search page");
  if (!Array.isArray(item.results)) throw new Error("Invalid conversation search results.");
  return {
    results: item.results.map((value) => {
      const result = record(value, "conversation search result");
      if (!isConversationMessage(result.message)) throw new Error("Invalid conversation search message.");
      return { botId: requiredString(result, "botId"), message: result.message };
    }),
    total: requiredNumber(item, "total"),
    nextCursor: requiredNullableString(item, "nextCursor"),
  };
}

export function decodeConversationMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value) || !value.every(isConversationMessage)) {
    throw new Error("Invalid conversation messages.");
  }
  return value;
}

export function decodeConversationReferences(value: unknown): Record<string, ConversationMessage> {
  const references = record(value, "conversation references");
  const decoded: Record<string, ConversationMessage> = {};
  for (const [messageId, message] of Object.entries(references)) {
    if (!isConversationMessage(message)) throw new Error("Invalid conversation reference.");
    decoded[messageId] = message;
  }
  return decoded;
}

export function isConversationWithReadState(value: unknown): value is ConversationWithReadState {
  return (
    isDynamicRecord(value) &&
    isString(value.botId) &&
    nullableString(value.threadId, "thread ID") &&
    nullableString(value.activeTurnId, "active turn ID") &&
    isNumber(value.revision) &&
    Array.isArray(value.messages) &&
    isDynamicRecord(value.readState)
  );
}

export function decodeReadState(value: unknown): ConversationReadState {
  const item = record(value, "conversation read state");
  return {
    unreadCount: requiredNumber(item, "unreadCount"),
    firstUnreadMessageId: requiredNullableString(item, "firstUnreadMessageId"),
    throughMessageId: requiredNullableString(item, "throughMessageId"),
  };
}

export function decodeReadStates(value: unknown): Record<string, ConversationReadState> {
  const item = record(value, "conversation reads");
  return Object.fromEntries(Object.entries(item).map(([botId, state]) => [botId, decodeReadState(state)]));
}

export function decodeAttachments(value: unknown): DraftAttachment[] {
  if (!Array.isArray(value) || !value.every(isDraftAttachment)) {
    throw new Error("Invalid attachment response.");
  }
  return value;
}

export function decodeDraftAttachments(value: unknown): DraftAttachment[] {
  return decodeAttachments(value);
}

export function isDraftAttachment(value: unknown): value is DraftAttachment {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isNumber(value.size) &&
    isString(value.kind) &&
    isString(value.mimeType) &&
    isString(value.previewKind) &&
    nullableString(value.previewUrl, "preview URL")
  );
}

export function decodeReceipt(value: unknown): QueuedMessageReceipt {
  if (!isQueuedMessageReceipt(value)) {
    throw new Error("Invalid queued message response.");
  }
  return value;
}

export function isQueuedMessageReceipt(value: unknown): value is QueuedMessageReceipt {
  return isDynamicRecord(value) && isString(value.messageId) && Array.isArray(value.deliveries);
}

export function decodeQueue(value: unknown): QueueSnapshot {
  if (!isQueueSnapshot(value)) {
    throw new Error("Invalid queue response.");
  }
  return value;
}

export function isQueueSnapshot(value: unknown): value is QueueSnapshot {
  return isDynamicRecord(value) && isString(value.botId) && Array.isArray(value.deliveries);
}

export function requiredNumber(value: DynamicRecord, field: string): number {
  if (!isNumber(value[field])) throw new Error(`Invalid ${field}.`);
  return value[field];
}

export function requiredString(value: DynamicRecord, field: string): string {
  const fieldValue = value[field];
  if (!isString(fieldValue)) throw new Error(`Invalid ${field}.`);
  return fieldValue;
}

export function requiredBoolean(value: DynamicRecord, field: string): boolean {
  if (!isBoolean(value[field])) throw new Error(`Invalid ${field}.`);
  return value[field];
}

export function requiredNullableString(value: DynamicRecord, field: string): string | null {
  const item = value[field];
  if (item !== null && !isString(item)) throw new Error(`Invalid ${field}.`);
  return item;
}

export function decodeSkillSummary(value: unknown) {
  const item = record(value, "marketplace skill");
  if (!isSkillCategory(item.category)) throw new Error("Invalid skill category.");
  return {
    id: requiredString(item, "id"),
    slug: requiredString(item, "slug"),
    name: requiredString(item, "name"),
    description: requiredString(item, "description"),
    category: item.category,
    creatorName: requiredString(item, "creatorName"),
    version: requiredNumber(item, "version"),
    installs: requiredNumber(item, "installs"),
    featured: requiredBoolean(item, "featured"),
    iconUrl: requiredNullableString(item, "iconUrl"),
    updatedAt: requiredString(item, "updatedAt"),
  };
}

export function decodeSkillPage(value: unknown): MarketplaceSkillPage {
  const page = record(value, "marketplace page");
  if (!Array.isArray(page.skills)) throw new Error("Invalid marketplace skills.");
  return { skills: page.skills.map(decodeSkillSummary), nextCursor: requiredNullableString(page, "nextCursor") };
}

export function decodeSkillDetail(value: unknown): MarketplaceSkillDetail {
  const item = record(value, "skill detail");
  const summary = decodeSkillSummary(item);
  if (!Array.isArray(item.files) || !item.files.every(isString)) throw new Error("Invalid skill files.");
  return {
    ...summary,
    versionId: requiredString(item, "versionId"),
    bundleSha256: requiredString(item, "bundleSha256"),
    files: item.files,
    instructions: requiredString(item, "instructions"),
  };
}

export function decodeSubmission(value: unknown): SkillSubmission {
  const item = record(value, "skill submission");
  const status = item.status;
  if (!isSkillCategory(item.category) || !isOneOf(["pending", "approved", "rejected"], status)) {
    throw new Error("Invalid skill submission state.");
  }
  return {
    id: requiredString(item, "id"),
    skillId: requiredString(item, "skillId"),
    slug: requiredString(item, "slug"),
    name: requiredString(item, "name"),
    description: requiredString(item, "description"),
    category: item.category,
    version: requiredNumber(item, "version"),
    status,
    rejectionNote: requiredNullableString(item, "rejectionNote"),
    iconUrl: requiredNullableString(item, "iconUrl"),
    createdAt: requiredString(item, "createdAt"),
  };
}

export function decodeSubmissions(value: unknown): SkillSubmission[] {
  if (!Array.isArray(value)) throw new Error("Invalid skill submissions.");
  return value.map(decodeSubmission);
}

export function decodeSkillPreview(value: unknown): SkillPackagePreview | null {
  if (value === null) return null;
  const item = record(value, "skill package preview");
  if (!Array.isArray(item.files) || !item.files.every(isString)) throw new Error("Invalid skill package files.");
  return {
    draftId: requiredString(item, "draftId"),
    name: requiredString(item, "name"),
    description: requiredString(item, "description"),
    slug: requiredString(item, "slug"),
    files: item.files,
    size: requiredNumber(item, "size"),
  };
}

export function decodeInstalledSkill(value: unknown): InstalledSkill {
  const item = record(value, "installed skill");
  const state = item.state;
  if (!isOneOf(["installed", "update-available", "modified", "needs-repair"], state)) {
    throw new Error("Invalid installed skill state.");
  }
  return {
    skillId: requiredString(item, "skillId"),
    slug: requiredString(item, "slug"),
    name: requiredString(item, "name"),
    installedVersion: requiredNumber(item, "installedVersion"),
    availableVersion: requiredNumber(item, "availableVersion"),
    state,
  };
}

export function decodeInstalledSkills(value: unknown): InstalledSkill[] {
  if (!Array.isArray(value)) throw new Error("Invalid installed skills.");
  return value.map(decodeInstalledSkill);
}

export function decodeMarketplaceAgentSummary(value: unknown): MarketplaceAgentSummary {
  const item = record(value, "marketplace agent");
  if (!isAvatarSeed(item.avatarSeed) || (item.avatarHue !== null && !isAvatarHue(item.avatarHue)))
    throw new Error("Invalid marketplace agent avatar.");
  return {
    id: requiredString(item, "id"),
    name: requiredString(item, "name"),
    title: requiredString(item, "title"),
    description: requiredString(item, "description"),
    creatorName: requiredString(item, "creatorName"),
    version: requiredNumber(item, "version"),
    installs: requiredNumber(item, "installs"),
    featured: requiredBoolean(item, "featured"),
    avatarSeed: item.avatarSeed,
    avatarHue: item.avatarHue,
    avatarUrl: requiredNullableString(item, "avatarUrl"),
    skillCount: requiredNumber(item, "skillCount"),
    routineCount: requiredNumber(item, "routineCount"),
    activeRoutineCount: requiredNumber(item, "activeRoutineCount"),
    updatedAt: requiredString(item, "updatedAt"),
  };
}

export function decodeMarketplaceAgentPage(value: unknown): MarketplaceAgentPage {
  const page = record(value, "marketplace agent page");
  if (!Array.isArray(page.agents)) throw new Error("Invalid marketplace agents.");
  return {
    agents: page.agents.map(decodeMarketplaceAgentSummary),
    nextCursor: requiredNullableString(page, "nextCursor"),
  };
}

export function decodeMarketplaceAgentDetail(value: unknown): MarketplaceAgentDetail {
  const item = record(value, "marketplace agent detail");
  const summary = decodeMarketplaceAgentSummary(item);
  if (
    !Array.isArray(item.skills) ||
    !item.skills.every((skill) => {
      if (!isDynamicRecord(skill)) return false;
      return [skill.skillId, skill.versionId, skill.slug, skill.name].every(isString) && isNumber(skill.version);
    })
  )
    throw new Error("Invalid marketplace agent skills.");
  if (
    !Array.isArray(item.routines) ||
    !item.routines.every(
      (routine) =>
        isDynamicRecord(routine) &&
        isString(routine.name) &&
        isString(routine.instruction) &&
        isBoolean(routine.active) &&
        isRoutineSchedule(routine.schedule),
    )
  )
    throw new Error("Invalid marketplace agent routines.");
  return { ...summary, versionId: requiredString(item, "versionId"), skills: item.skills, routines: item.routines };
}

export function decodeAgentSubmission(value: unknown): AgentSubmission {
  const item = record(value, "agent submission");
  if (
    !isOneOf(["pending", "approved", "rejected"], item.status) ||
    !isAvatarSeed(item.avatarSeed) ||
    (item.avatarHue !== null && !isAvatarHue(item.avatarHue))
  )
    throw new Error("Invalid agent submission.");
  return {
    id: requiredString(item, "id"),
    agentId: requiredString(item, "agentId"),
    name: requiredString(item, "name"),
    title: requiredString(item, "title"),
    description: requiredString(item, "description"),
    version: requiredNumber(item, "version"),
    status: item.status,
    rejectionNote: requiredNullableString(item, "rejectionNote"),
    avatarSeed: item.avatarSeed,
    avatarHue: item.avatarHue,
    avatarUrl: requiredNullableString(item, "avatarUrl"),
    skillCount: requiredNumber(item, "skillCount"),
    routineCount: requiredNumber(item, "routineCount"),
    activeRoutineCount: requiredNumber(item, "activeRoutineCount"),
    createdAt: requiredString(item, "createdAt"),
  };
}

export function decodeAgentSubmissions(value: unknown): AgentSubmission[] {
  if (!Array.isArray(value)) throw new Error("Invalid agent submissions.");
  return value.map(decodeAgentSubmission);
}

export function decodeAgentPublicationPreview(value: unknown): AgentPublicationPreview {
  const item = record(value, "agent publication preview");
  const detail = decodeMarketplaceAgentDetail({
    ...item,
    id: item.botId,
    creatorName: "",
    version: 1,
    installs: 0,
    featured: false,
    skillCount: Array.isArray(item.skills) ? item.skills.length : -1,
    routineCount: Array.isArray(item.routines) ? item.routines.length : -1,
    activeRoutineCount: Array.isArray(item.routines)
      ? item.routines.filter((routine) => isDynamicRecord(routine) && routine.active === true).length
      : -1,
    updatedAt: "",
    versionId: "preview",
  });
  return {
    botId: requiredString(item, "botId"),
    name: detail.name,
    title: detail.title,
    description: detail.description,
    avatarSeed: detail.avatarSeed,
    avatarHue: detail.avatarHue,
    avatarUrl: detail.avatarUrl,
    skills: detail.skills,
    routines: detail.routines,
  };
}
