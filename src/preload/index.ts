import {
  type AccountUsage,
  type AgentIpcRequest,
  type AgentModelOption,
  type AgentPublicationPreview,
  type AgentStatus,
  type AgentSubmission,
  type AttachmentImportEvent,
  type BotMemory,
  type BotSummary,
  type ConversationMessage,
  type ConversationPage,
  type ConversationReadState,
  type ConversationSearchPage,
  type ConversationWithReadState,
  type DraftAttachment,
  type FilePreview,
  type ImportAttachmentsInput,
  type InstalledSkill,
  IPC_CHANNELS,
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
  isSkillCategory,
  type MarketplaceAgentDetail,
  type MarketplaceAgentPage,
  type MarketplaceAgentSummary,
  type MarketplaceSkillDetail,
  type MarketplaceSkillPage,
  type OpenBotDesktopApi,
  type QueuedMessageReceipt,
  type QueueSnapshot,
  type Routine,
  type RoutineRun,
  type ScopedAgentEvent,
  type ScopedDirectMessageEvent,
  type ScopedDirectTypingEvent,
  type ScopedTeamPresenceSnapshot,
  type SidebarLayoutSnapshot,
  type SkillPackagePreview,
  type SkillSubmission,
  type UpdateStatus,
} from "@openbot/contracts/ipc";
import {
  type DynamicRecord,
  isBoolean,
  isDynamicRecord,
  isNumber,
  isOneOf,
  isString,
} from "@openbot/contracts/runtime-values";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const attachmentImportListeners = new Set<(event: AttachmentImportEvent) => void>();
let selectedServerId = "local";

function invokeAgent<TResult>(
  channel: string,
  payload: unknown = null,
  decoder: (value: unknown) => TResult,
): Promise<TResult> {
  const request: AgentIpcRequest = { serverId: selectedServerId, payload };
  return ipcRenderer.invoke(channel, request).then(decoder);
}

function rememberActiveServer<T extends { id: string; active: boolean }[]>(servers: T): T {
  selectedServerId = servers.find((server) => server.active)?.id ?? "local";
  return servers;
}

function emitAttachmentImport(event: AttachmentImportEvent): void {
  for (const listener of attachmentImportListeners) listener(event);
}

async function importFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  const requestId = crypto.randomUUID();
  emitAttachmentImport({ type: "started", requestId });
  try {
    const input: ImportAttachmentsInput = { paths: [], data: [] };
    for (const file of files) {
      const path = webUtils.getPathForFile(file);
      if (path) input.paths.push(path);
      else {
        input.data.push({
          name: file.name || `pasted-${Date.now()}.png`,
          mimeType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      }
    }
    const attachments = await invokeAgent(IPC_CHANNELS.agentImportAttachments, input, decodeDraftAttachments);
    emitAttachmentImport({ type: "completed", requestId, attachments });
  } catch (error) {
    emitAttachmentImport({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function record(value: unknown, label: string): DynamicRecord {
  if (!isDynamicRecord(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function nullableString(value: unknown, label: string): value is string | null {
  if (value !== null && !isString(value)) throw new Error(`Invalid ${label}.`);
  return true;
}

function decodeVoid(value: unknown): undefined {
  if (value !== undefined && value !== null) throw new Error("IPC returned unexpected data.");
  return undefined;
}

function decodeRoutine(value: unknown): Routine {
  if (!isRoutine(value)) throw new Error("Invalid routine response.");
  return value;
}

function decodeRoutines(value: unknown): Routine[] {
  if (!Array.isArray(value) || !value.every(isRoutine)) throw new Error("Invalid routine list response.");
  return value;
}

function decodeRoutineRun(value: unknown): RoutineRun {
  if (!isRoutineRun(value)) throw new Error("Invalid routine run response.");
  return value;
}

function decodeRoutineRuns(value: unknown): RoutineRun[] {
  if (!Array.isArray(value) || !value.every(isRoutineRun)) throw new Error("Invalid routine history response.");
  return value;
}

function decodeFilePreview(value: unknown): FilePreview {
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

function decodeAgentStatus(value: unknown): AgentStatus {
  if (!isAgentStatusValue(value)) throw new Error("Invalid agent status response.");
  return value;
}

function isAgentStatusValue(value: unknown): value is AgentStatus {
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

function decodeAccountUsage(value: unknown): AccountUsage {
  if (!isAccountUsageValue(value)) throw new Error("Invalid agent usage response.");
  return value;
}

function isAccountUsageValue(value: unknown): value is AccountUsage {
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

function decodeAgentModels(value: unknown): AgentModelOption[] {
  if (!isAgentModelList(value)) throw new Error("Invalid agent model response.");
  return value;
}

function isAgentModelList(value: unknown): value is AgentModelOption[] {
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

function decodeBot(value: unknown): BotSummary {
  if (!isBotSummary(value)) throw new Error("Invalid agent response.");
  return value;
}

function isBotSummary(value: unknown): value is BotSummary {
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

function decodeBots(value: unknown): BotSummary[] {
  if (!Array.isArray(value) || !value.every(isBotSummary)) {
    throw new Error("Invalid agent list response.");
  }
  return value;
}

function decodeMemory(value: unknown): BotMemory {
  if (!isBotMemory(value)) throw new Error("Invalid agent memory response.");
  return value;
}

function decodeMemories(value: unknown): BotMemory[] {
  if (!Array.isArray(value) || !value.every(isBotMemory)) throw new Error("Invalid agent memories response.");
  return value;
}

function decodeSidebarLayout(value: unknown): SidebarLayoutSnapshot {
  if (!isSidebarLayoutSnapshot(value)) throw new Error("Invalid sidebar layout response.");
  return value;
}

function decodeConversation(value: unknown): ConversationWithReadState {
  if (!isConversationWithReadState(value)) throw new Error("Invalid conversation response.");
  return value;
}

function decodeConversationPage(value: unknown): ConversationPage {
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

function decodeConversationSearchPage(value: unknown): ConversationSearchPage {
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

function decodeConversationMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value) || !value.every(isConversationMessage)) {
    throw new Error("Invalid conversation messages.");
  }
  return value;
}

function decodeConversationReferences(value: unknown): Record<string, ConversationMessage> {
  const references = record(value, "conversation references");
  const decoded: Record<string, ConversationMessage> = {};
  for (const [messageId, message] of Object.entries(references)) {
    if (!isConversationMessage(message)) throw new Error("Invalid conversation reference.");
    decoded[messageId] = message;
  }
  return decoded;
}

function isConversationWithReadState(value: unknown): value is ConversationWithReadState {
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

function decodeReadState(value: unknown): ConversationReadState {
  const item = record(value, "conversation read state");
  return {
    unreadCount: requiredNumber(item, "unreadCount"),
    firstUnreadMessageId: requiredNullableString(item, "firstUnreadMessageId"),
    throughMessageId: requiredNullableString(item, "throughMessageId"),
  };
}

function decodeReadStates(value: unknown): Record<string, ConversationReadState> {
  const item = record(value, "conversation reads");
  return Object.fromEntries(Object.entries(item).map(([botId, state]) => [botId, decodeReadState(state)]));
}

function decodeAttachments(value: unknown): DraftAttachment[] {
  if (!Array.isArray(value) || !value.every(isDraftAttachment)) {
    throw new Error("Invalid attachment response.");
  }
  return value;
}

function decodeDraftAttachments(value: unknown): DraftAttachment[] {
  return decodeAttachments(value);
}

function isDraftAttachment(value: unknown): value is DraftAttachment {
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

function decodeReceipt(value: unknown): QueuedMessageReceipt {
  if (!isQueuedMessageReceipt(value)) {
    throw new Error("Invalid queued message response.");
  }
  return value;
}

function isQueuedMessageReceipt(value: unknown): value is QueuedMessageReceipt {
  return isDynamicRecord(value) && isString(value.messageId) && Array.isArray(value.deliveries);
}

function decodeQueue(value: unknown): QueueSnapshot {
  if (!isQueueSnapshot(value)) {
    throw new Error("Invalid queue response.");
  }
  return value;
}

function isQueueSnapshot(value: unknown): value is QueueSnapshot {
  return isDynamicRecord(value) && isString(value.botId) && Array.isArray(value.deliveries);
}

function requiredNumber(value: DynamicRecord, field: string): number {
  if (!isNumber(value[field])) throw new Error(`Invalid ${field}.`);
  return value[field];
}

function requiredString(value: DynamicRecord, field: string): string {
  const fieldValue = value[field];
  if (!isString(fieldValue)) throw new Error(`Invalid ${field}.`);
  return fieldValue;
}

function requiredBoolean(value: DynamicRecord, field: string): boolean {
  if (!isBoolean(value[field])) throw new Error(`Invalid ${field}.`);
  return value[field];
}

function requiredNullableString(value: DynamicRecord, field: string): string | null {
  const item = value[field];
  if (item !== null && !isString(item)) throw new Error(`Invalid ${field}.`);
  return item;
}

function decodeSkillSummary(value: unknown) {
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

function decodeSkillPage(value: unknown): MarketplaceSkillPage {
  const page = record(value, "marketplace page");
  if (!Array.isArray(page.skills)) throw new Error("Invalid marketplace skills.");
  return { skills: page.skills.map(decodeSkillSummary), nextCursor: requiredNullableString(page, "nextCursor") };
}

function decodeSkillDetail(value: unknown): MarketplaceSkillDetail {
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

function decodeSubmission(value: unknown): SkillSubmission {
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

function decodeSubmissions(value: unknown): SkillSubmission[] {
  if (!Array.isArray(value)) throw new Error("Invalid skill submissions.");
  return value.map(decodeSubmission);
}

function decodeSkillPreview(value: unknown): SkillPackagePreview | null {
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

function decodeInstalledSkill(value: unknown): InstalledSkill {
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

function decodeInstalledSkills(value: unknown): InstalledSkill[] {
  if (!Array.isArray(value)) throw new Error("Invalid installed skills.");
  return value.map(decodeInstalledSkill);
}

function decodeMarketplaceAgentSummary(value: unknown): MarketplaceAgentSummary {
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

function decodeMarketplaceAgentPage(value: unknown): MarketplaceAgentPage {
  const page = record(value, "marketplace agent page");
  if (!Array.isArray(page.agents)) throw new Error("Invalid marketplace agents.");
  return {
    agents: page.agents.map(decodeMarketplaceAgentSummary),
    nextCursor: requiredNullableString(page, "nextCursor"),
  };
}

function decodeMarketplaceAgentDetail(value: unknown): MarketplaceAgentDetail {
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

function decodeAgentSubmission(value: unknown): AgentSubmission {
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

function decodeAgentSubmissions(value: unknown): AgentSubmission[] {
  if (!Array.isArray(value)) throw new Error("Invalid agent submissions.");
  return value.map(decodeAgentSubmission);
}

function decodeAgentPublicationPreview(value: unknown): AgentPublicationPreview {
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

function isConversationDropTarget(target: EventTarget | null): boolean {
  const conversation = document.querySelector(".conversation-panel");
  return target instanceof Node && Boolean(conversation?.contains(target));
}

window.addEventListener("dragover", (event) => {
  if (!isConversationDropTarget(event.target)) return;
  if ([...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file")) {
    event.preventDefault();
  }
});
window.addEventListener("drop", (event) => {
  if (!isConversationDropTarget(event.target)) return;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  void importFiles(files);
});
window.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length) {
    event.preventDefault();
    void importFiles(files);
  }
});
window.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.dataset.openbotAttachmentPicker !== "true") return;
  void importFiles([...(input.files ?? [])]);
});

const openbotApi: OpenBotDesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getSetupState: () => ipcRenderer.invoke(IPC_CHANNELS.getSetupState),
  saveSetup: (input) => ipcRenderer.invoke(IPC_CHANNELS.saveSetup, input),
  getMacPermissions: () => ipcRenderer.invoke(IPC_CHANNELS.getMacPermissions),
  requestMacPermission: (permission) => ipcRenderer.invoke(IPC_CHANNELS.requestMacPermission, permission),
  openExternal: (destination) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, destination),
  openUrl: (url) => ipcRenderer.invoke(IPC_CHANNELS.openUrl, url),
  voice: {
    transcribe: (input) => ipcRenderer.invoke(IPC_CHANNELS.voiceTranscribe, input),
  },
  auth: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.authGetState),
    retry: () => ipcRenderer.invoke(IPC_CHANNELS.authRetry),
    requestEmailCode: (email) => ipcRenderer.invoke(IPC_CHANNELS.authRequestEmailCode, email),
    verifyEmailCode: (challengeId, code) => ipcRenderer.invoke(IPC_CHANNELS.authVerifyEmailCode, { challengeId, code }),
    updateAvatar: (image) => ipcRenderer.invoke(IPC_CHANNELS.authUpdateAvatar, image),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.authLogout),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.authEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.authEvent, handler);
    },
  },
  skills: {
    list: (query) => ipcRenderer.invoke(IPC_CHANNELS.skillsList, query ?? null).then(decodeSkillPage),
    get: (skillId) => ipcRenderer.invoke(IPC_CHANNELS.skillsGet, skillId).then(decodeSkillDetail),
    listMine: () => ipcRenderer.invoke(IPC_CHANNELS.skillsListMine).then(decodeSubmissions),
    choosePackage: () => ipcRenderer.invoke(IPC_CHANNELS.skillsChoosePackage).then(decodeSkillPreview),
    submit: (input) => ipcRenderer.invoke(IPC_CHANNELS.skillsSubmit, input).then(decodeSubmission),
    listInstalled: (botId) => ipcRenderer.invoke(IPC_CHANNELS.skillsListInstalled, botId).then(decodeInstalledSkills),
    install: (input) => ipcRenderer.invoke(IPC_CHANNELS.skillsInstall, input).then(decodeInstalledSkill),
    uninstall: (input) => ipcRenderer.invoke(IPC_CHANNELS.skillsUninstall, input).then(decodeVoid),
  },
  marketplaceAgents: {
    list: (query) =>
      ipcRenderer.invoke(IPC_CHANNELS.marketplaceAgentsList, query ?? null).then(decodeMarketplaceAgentPage),
    get: (agentId) => ipcRenderer.invoke(IPC_CHANNELS.marketplaceAgentsGet, agentId).then(decodeMarketplaceAgentDetail),
    listMine: () => ipcRenderer.invoke(IPC_CHANNELS.marketplaceAgentsListMine).then(decodeAgentSubmissions),
    preview: (botId) =>
      ipcRenderer.invoke(IPC_CHANNELS.marketplaceAgentsPreview, botId).then(decodeAgentPublicationPreview),
    submit: (input) => ipcRenderer.invoke(IPC_CHANNELS.marketplaceAgentsSubmit, input).then(decodeAgentSubmission),
    install: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.marketplaceAgentsInstall, input).then((value) => {
        const item = record(value, "agent installation");
        return { bot: decodeBot(item.bot) };
      }),
  },
  agent: {
    getStatus: () => invokeAgent(IPC_CHANNELS.agentGetStatus, null, decodeAgentStatus),
    getUsage: () => invokeAgent(IPC_CHANNELS.agentGetUsage, null, decodeAccountUsage),
    listModels: () => invokeAgent(IPC_CHANNELS.agentListModels, null, decodeAgentModels),
    listBots: () => invokeAgent(IPC_CHANNELS.agentListBots, null, decodeBots),
    getSidebarLayout: () => invokeAgent(IPC_CHANNELS.agentGetSidebarLayout, null, decodeSidebarLayout),
    mutateSidebarLayout: (action) => invokeAgent(IPC_CHANNELS.agentMutateSidebarLayout, action, decodeSidebarLayout),
    createBot: (input) => invokeAgent(IPC_CHANNELS.agentCreateBot, input, decodeBot),
    updateBot: (input) => invokeAgent(IPC_CHANNELS.agentUpdateBot, input, decodeBot),
    setAvatar: (input) => invokeAgent(IPC_CHANNELS.agentSetAvatar, input, decodeBot),
    deleteBot: (botId) => invokeAgent(IPC_CHANNELS.agentDeleteBot, botId, decodeVoid),
    listMemories: (botId) => invokeAgent(IPC_CHANNELS.agentListMemories, botId, decodeMemories),
    createMemory: (input) => invokeAgent(IPC_CHANNELS.agentCreateMemory, input, decodeMemory),
    updateMemory: (input) => invokeAgent(IPC_CHANNELS.agentUpdateMemory, input, decodeMemory),
    deleteMemory: (input) => invokeAgent(IPC_CHANNELS.agentDeleteMemory, input, decodeVoid),
    clearMemories: (botId) => invokeAgent(IPC_CHANNELS.agentClearMemories, botId, decodeVoid),
    listRoutines: (botId) => invokeAgent(IPC_CHANNELS.agentListRoutines, botId, decodeRoutines),
    createRoutine: (input) => invokeAgent(IPC_CHANNELS.agentCreateRoutine, input, decodeRoutine),
    updateRoutine: (input) => invokeAgent(IPC_CHANNELS.agentUpdateRoutine, input, decodeRoutine),
    deleteRoutine: (input) => invokeAgent(IPC_CHANNELS.agentDeleteRoutine, input, decodeVoid),
    testRoutine: (input) => invokeAgent(IPC_CHANNELS.agentTestRoutine, input, decodeRoutineRun),
    listRoutineRuns: (input) => invokeAgent(IPC_CHANNELS.agentListRoutineRuns, input, decodeRoutineRuns),
    readConversation: (botId) => invokeAgent(IPC_CHANNELS.agentReadConversation, botId, decodeConversation),
    readConversationPage: (input) => invokeAgent(IPC_CHANNELS.agentReadConversationPage, input, decodeConversationPage),
    searchConversationMessages: (input) =>
      invokeAgent(IPC_CHANNELS.agentSearchConversationMessages, input, decodeConversationSearchPage),
    listConversationReads: () => invokeAgent(IPC_CHANNELS.agentListConversationReads, null, decodeReadStates),
    markConversationRead: (input) => invokeAgent(IPC_CHANNELS.agentMarkConversationRead, input, decodeReadState),
    chooseAttachments: (input) => invokeAgent(IPC_CHANNELS.agentChooseAttachments, input, decodeAttachments),
    onAttachmentImport: (listener) => {
      attachmentImportListeners.add(listener);
      return () => attachmentImportListeners.delete(listener);
    },
    discardDraftAttachment: (attachmentId) =>
      invokeAgent(IPC_CHANNELS.agentDiscardDraftAttachment, attachmentId, decodeVoid),
    openAttachment: (input) => invokeAgent(IPC_CHANNELS.agentOpenAttachment, input, decodeVoid),
    openSharedFile: (input) => invokeAgent(IPC_CHANNELS.agentOpenSharedFile, input, decodeVoid),
    openWorkspaceFile: (input) => invokeAgent(IPC_CHANNELS.agentOpenWorkspaceFile, input, decodeVoid),
    previewSharedFile: (input) => invokeAgent(IPC_CHANNELS.agentPreviewSharedFile, input, decodeFilePreview),
    previewWorkspaceFile: (input) => invokeAgent(IPC_CHANNELS.agentPreviewWorkspaceFile, input, decodeFilePreview),
    sendMessage: (input) => invokeAgent(IPC_CHANNELS.agentSendMessage, input, decodeReceipt),
    setMessageReaction: (input) => invokeAgent(IPC_CHANNELS.agentSetMessageReaction, input, decodeVoid),
    listQueue: (botId) => invokeAgent(IPC_CHANNELS.agentListQueue, botId, decodeQueue),
    cancelQueuedMessage: (input) => invokeAgent(IPC_CHANNELS.agentCancelQueuedMessage, input, decodeVoid),
    steerQueuedMessage: (input) => invokeAgent(IPC_CHANNELS.agentSteerQueuedMessage, input, decodeVoid),
    updateQueuedMessage: (input) => invokeAgent(IPC_CHANNELS.agentUpdateQueuedMessage, input, decodeVoid),
    reorderQueue: (input) => invokeAgent(IPC_CHANNELS.agentReorderQueue, input, decodeVoid),
    interrupt: (input) => invokeAgent(IPC_CHANNELS.agentInterrupt, input, decodeVoid),
    respondToPrompt: (input) => invokeAgent(IPC_CHANNELS.agentRespondToPrompt, input, decodeVoid),
    respondToApproval: (input) => invokeAgent(IPC_CHANNELS.agentRespondToApproval, input, decodeVoid),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ScopedAgentEvent) => {
        if (payload.serverId === selectedServerId) listener(payload.event);
      };
      ipcRenderer.on(IPC_CHANNELS.agentEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, handler);
    },
  },
  browser: {
    open: (input) => ipcRenderer.invoke(IPC_CHANNELS.browserOpen, input),
    activate: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserActivate, tabId),
    reload: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserReload, tabId),
    close: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserClose, tabId),
    listTabs: () => ipcRenderer.invoke(IPC_CHANNELS.browserListTabs),
    getControlState: () => ipcRenderer.invoke(IPC_CHANNELS.browserGetControlState),
    setVisible: (input) => ipcRenderer.invoke(IPC_CHANNELS.browserSetVisible, input),
  },
  update: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.updateGetStatus),
    check: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.updateDownload),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
      ipcRenderer.on(IPC_CHANNELS.updateEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.updateEvent, handler);
    },
  },
  maintenance: {
    exportData: () => ipcRenderer.invoke(IPC_CHANNELS.maintenanceExportData),
    exportDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.maintenanceExportDiagnostics),
  },
  servers: {
    list: async () => rememberActiveServer(await ipcRenderer.invoke(IPC_CHANNELS.serversList)),
    select: async (serverId) => rememberActiveServer(await ipcRenderer.invoke(IPC_CHANNELS.serversSelect, serverId)),
    reorder: async (input) => rememberActiveServer(await ipcRenderer.invoke(IPC_CHANNELS.serversReorder, input)),
    join: async (input) => {
      const server = await ipcRenderer.invoke(IPC_CHANNELS.serversJoin, input);
      selectedServerId = server.id;
      return server;
    },
    previewInvite: (input) => ipcRenderer.invoke(IPC_CHANNELS.serversPreviewInvite, input),
    takePendingInvite: () => ipcRenderer.invoke(IPC_CHANNELS.serversTakePendingInvite),
    login: async (input) => {
      const server = await ipcRenderer.invoke(IPC_CHANNELS.serversLogin, input);
      selectedServerId = server.id;
      return server;
    },
    remove: (serverId) => ipcRenderer.invoke(IPC_CHANNELS.serversRemove, serverId),
    getPresence: () => ipcRenderer.invoke(IPC_CHANNELS.serversGetPresence),
    getPresenceFor: (serverId) => ipcRenderer.invoke(IPC_CHANNELS.serversGetPresenceFor, serverId),
    refreshIdentity: (serverId) => ipcRenderer.invoke(IPC_CHANNELS.serversRefreshIdentity, serverId),
    listMembers: (serverId) => ipcRenderer.invoke(IPC_CHANNELS.serversListMembers, serverId),
    updateMember: (serverId, input) => ipcRenderer.invoke(IPC_CHANNELS.serversUpdateMember, serverId, input),
    removeMember: (serverId, memberId) => ipcRenderer.invoke(IPC_CHANNELS.serversRemoveMember, serverId, memberId),
    listInvites: (serverId) => ipcRenderer.invoke(IPC_CHANNELS.serversListInvites, serverId),
    revokeInvite: (serverId, inviteId) => ipcRenderer.invoke(IPC_CHANNELS.serversRevokeInvite, serverId, inviteId),
    createInvite: (serverId, input) => ipcRenderer.invoke(IPC_CHANNELS.serversCreateInvite, serverId, input),
    setTyping: (input) => ipcRenderer.invoke(IPC_CHANNELS.serversSetTyping, input),
    onPresence: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ScopedTeamPresenceSnapshot) => {
        if (payload.serverId === selectedServerId) listener(payload.snapshot);
      };
      ipcRenderer.on(IPC_CHANNELS.serversPresence, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.serversPresence, handler);
    },
    listDirectThreads: () => ipcRenderer.invoke(IPC_CHANNELS.serversListDirectThreads),
    readDirectConversation: (memberId) => ipcRenderer.invoke(IPC_CHANNELS.serversReadDirectConversation, memberId),
    readDirectConversationPage: (input) => ipcRenderer.invoke(IPC_CHANNELS.serversReadDirectConversationPage, input),
    sendDirectMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.serversSendDirectMessage, input),
    markDirectRead: (input) => ipcRenderer.invoke(IPC_CHANNELS.serversMarkDirectRead, input),
    setDirectTyping: (input) => ipcRenderer.invoke(IPC_CHANNELS.serversSetDirectTyping, input),
    onDirectMessage: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ScopedDirectMessageEvent) => {
        if (payload.serverId === selectedServerId) listener(payload.event);
      };
      ipcRenderer.on(IPC_CHANNELS.serversDirectMessage, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.serversDirectMessage, handler);
    },
    onDirectTyping: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ScopedDirectTypingEvent) => {
        if (payload.serverId === selectedServerId) listener(payload.event);
      };
      ipcRenderer.on(IPC_CHANNELS.serversDirectTyping, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.serversDirectTyping, handler);
    },
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, servers: Parameters<typeof listener>[0]) =>
        listener(rememberActiveServer(servers));
      ipcRenderer.on(IPC_CHANNELS.serversEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.serversEvent, handler);
    },
    onInvite: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, inviteUrl: string) => listener(inviteUrl);
      ipcRenderer.on(IPC_CHANNELS.serversInvite, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.serversInvite, handler);
    },
  },
  host: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.hostGetStatus),
    configure: (input) => ipcRenderer.invoke(IPC_CHANNELS.hostConfigure, input),
    updateIdentity: (input) => ipcRenderer.invoke(IPC_CHANNELS.hostUpdateIdentity, input),
    getPresence: () => ipcRenderer.invoke(IPC_CHANNELS.hostGetPresence),
    start: () => ipcRenderer.invoke(IPC_CHANNELS.hostStart),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.hostStop),
    listMembers: () => ipcRenderer.invoke(IPC_CHANNELS.hostListMembers),
    updateMember: (input) => ipcRenderer.invoke(IPC_CHANNELS.hostUpdateMember, input),
    removeMember: (memberId) => ipcRenderer.invoke(IPC_CHANNELS.hostRemoveMember, memberId),
    listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.hostListSessions),
    revokeSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.hostRevokeSession, sessionId),
    listInvites: () => ipcRenderer.invoke(IPC_CHANNELS.hostListInvites),
    revokeInvite: (inviteId) => ipcRenderer.invoke(IPC_CHANNELS.hostRevokeInvite, inviteId),
    createInvite: (input) => ipcRenderer.invoke(IPC_CHANNELS.hostCreateInvite, input),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status);
      ipcRenderer.on(IPC_CHANNELS.hostEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.hostEvent, handler);
    },
  },
  remoteDesktop: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.remoteDesktopList),
    connect: (input) => ipcRenderer.invoke(IPC_CHANNELS.remoteDesktopConnect, input),
    selectDisplay: (input) => ipcRenderer.invoke(IPC_CHANNELS.remoteDesktopSelectDisplay, input),
    disconnect: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.remoteDesktopDisconnect, sessionId),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, sessions: Parameters<typeof listener>[0]) =>
        listener(sessions);
      ipcRenderer.on(IPC_CHANNELS.remoteDesktopEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.remoteDesktopEvent, handler);
    },
  },
};

contextBridge.exposeInMainWorld("openbot", openbotApi);
