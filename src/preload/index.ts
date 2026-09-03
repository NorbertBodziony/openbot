import {
  type AgentIpcRequest,
  type AttachmentImportEvent,
  type ImportAttachmentsInput,
  IPC_CHANNELS,
  type OpenBotDesktopApi,
  type ScopedAgentEvent,
  type ScopedDirectMessageEvent,
  type ScopedDirectTypingEvent,
  type ScopedTeamPresenceSnapshot,
  type UpdateStatus,
} from "@openbot/contracts/ipc";
import {
  decodeAccountUsage,
  decodeAgentModels,
  decodeAgentPublicationPreview,
  decodeAgentStatus,
  decodeAgentSubmission,
  decodeAgentSubmissions,
  decodeAttachments,
  decodeBot,
  decodeBots,
  decodeBrowserPreview,
  decodeComputerUseMacSetupState,
  decodeConversation,
  decodeConversationPage,
  decodeConversationSearchPage,
  decodeDraftAttachments,
  decodeDuplicateBotResult,
  decodeDynamicIslandAction,
  decodeDynamicIslandGeometry,
  decodeDynamicIslandPreference,
  decodeDynamicIslandPresentation,
  decodeFilePreview,
  decodeHostedSite,
  decodeHostedSites,
  decodeInstalledSkill,
  decodeInstalledSkills,
  decodeMarketplaceAgentDetail,
  decodeMarketplaceAgentPage,
  decodeMemories,
  decodeMemory,
  decodeNullablePath,
  decodeProviderRuntimeSnapshot,
  decodeQueue,
  decodeReadState,
  decodeReadStates,
  decodeReceipt,
  decodeRoutine,
  decodeRoutineRun,
  decodeRoutineRuns,
  decodeRoutines,
  decodeSidebarLayout,
  decodeSkillDetail,
  decodeSkillPage,
  decodeSkillPreview,
  decodeSubmission,
  decodeSubmissions,
  decodeVoid,
  record,
} from "@openbot/contracts/ipc-decoders";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { clipboardFiles } from "./clipboard-files";

const attachmentImportListeners = new Set<(event: AttachmentImportEvent) => void>();
let selectedServerId = "local";

function invokeAgent<TResult>(
  channel: string,
  payload: unknown = null,
  decoder: (value: unknown) => TResult,
): Promise<TResult> {
  return invokeAgentForServer(selectedServerId, channel, payload, decoder);
}

function invokeAgentForServer<TResult>(
  serverId: string,
  channel: string,
  payload: unknown,
  decoder: (value: unknown) => TResult,
): Promise<TResult> {
  const request: AgentIpcRequest = { serverId, payload };
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
  const serverId = selectedServerId;
  emitAttachmentImport({ type: "started", requestId, serverId });
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
    const attachments = await invokeAgentForServer(
      serverId,
      IPC_CHANNELS.agentImportAttachments,
      input,
      decodeDraftAttachments,
    );
    emitAttachmentImport({ type: "completed", requestId, serverId, attachments });
  } catch (error) {
    emitAttachmentImport({
      type: "error",
      requestId,
      serverId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
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
  const files = clipboardFiles(event.clipboardData);
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
  getAnalyticsPreference: () => ipcRenderer.invoke(IPC_CHANNELS.getAnalyticsPreference),
  setAnalyticsPreference: (input) => ipcRenderer.invoke(IPC_CHANNELS.setAnalyticsPreference, input),
  dynamicIsland: {
    getPreference: () =>
      ipcRenderer.invoke(IPC_CHANNELS.dynamicIslandGetPreference).then(decodeDynamicIslandPreference),
    setPreference: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.dynamicIslandSetPreference, input).then(decodeDynamicIslandPreference),
    publishPresentation: (presentation) =>
      ipcRenderer.invoke(IPC_CHANNELS.dynamicIslandPublishPresentation, presentation).then(decodeVoid),
    getPresentation: () =>
      ipcRenderer.invoke(IPC_CHANNELS.dynamicIslandGetPresentation).then(decodeDynamicIslandPresentation),
    onPreference: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, preference: unknown) =>
        listener(decodeDynamicIslandPreference(preference));
      ipcRenderer.on(IPC_CHANNELS.dynamicIslandPreference, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.dynamicIslandPreference, handler);
    },
    onPresentation: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, presentation: unknown) =>
        listener(decodeDynamicIslandPresentation(presentation));
      ipcRenderer.on(IPC_CHANNELS.dynamicIslandPresentation, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.dynamicIslandPresentation, handler);
    },
    onGeometry: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, geometry: unknown) =>
        listener(decodeDynamicIslandGeometry(geometry));
      ipcRenderer.on(IPC_CHANNELS.dynamicIslandGeometry, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.dynamicIslandGeometry, handler);
    },
    performAction: (action) => ipcRenderer.invoke(IPC_CHANNELS.dynamicIslandPerformAction, action).then(decodeVoid),
    performHaptic: () => ipcRenderer.invoke(IPC_CHANNELS.dynamicIslandPerformHaptic).then(decodeVoid),
    onAction: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, action: unknown) =>
        listener(decodeDynamicIslandAction(action));
      ipcRenderer.on(IPC_CHANNELS.dynamicIslandAction, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.dynamicIslandAction, handler);
    },
    setInteractive: (input) => ipcRenderer.invoke(IPC_CHANNELS.dynamicIslandSetInteractive, input).then(decodeVoid),
  },
  getComputerUseMacSetupState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.computerUseGetMacSetupState).then(decodeComputerUseMacSetupState),
  openComputerUsePermissionSetup: (permission) =>
    ipcRenderer.invoke(IPC_CHANNELS.computerUseOpenMacPermissionSetup, permission).then(decodeComputerUseMacSetupState),
  startComputerUseHelperDrag: () => ipcRenderer.invoke(IPC_CHANNELS.computerUseStartHelperDrag).then(decodeVoid),
  revealComputerUseHelper: () => ipcRenderer.invoke(IPC_CHANNELS.computerUseRevealHelper).then(decodeVoid),
  closeComputerUsePermissionSetup: () =>
    ipcRenderer.invoke(IPC_CHANNELS.computerUseCloseMacPermissionSetup).then(decodeVoid),
  openExternal: (destination) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, destination),
  connectChatGPT: () => ipcRenderer.invoke(IPC_CHANNELS.connectChatGPT),
  connectClaude: () => ipcRenderer.invoke(IPC_CHANNELS.connectClaude),
  connectGrok: () => ipcRenderer.invoke(IPC_CHANNELS.connectGrok),
  refreshAgentProviders: () => ipcRenderer.invoke(IPC_CHANNELS.refreshAgentProviders),
  providerRuntimes: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.providerRuntimesGetStatus).then(decodeProviderRuntimeSnapshot),
    download: (provider) =>
      ipcRenderer.invoke(IPC_CHANNELS.providerRuntimesDownload, provider).then(decodeProviderRuntimeSnapshot),
    cancel: (provider) =>
      ipcRenderer.invoke(IPC_CHANNELS.providerRuntimesCancel, provider).then(decodeProviderRuntimeSnapshot),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown) =>
        listener(decodeProviderRuntimeSnapshot(snapshot));
      ipcRenderer.on(IPC_CHANNELS.providerRuntimesEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.providerRuntimesEvent, handler);
    },
  },
  openUrl: (url) => ipcRenderer.invoke(IPC_CHANNELS.openUrl, url),
  voice: {
    getModelStatus: () => ipcRenderer.invoke(IPC_CHANNELS.voiceGetModelStatus),
    prepareModel: () => ipcRenderer.invoke(IPC_CHANNELS.voicePrepareModel),
    transcribe: (input) => ipcRenderer.invoke(IPC_CHANNELS.voiceTranscribe, input),
    onModelStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) => listener(status);
      ipcRenderer.on(IPC_CHANNELS.voiceModelStatus, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.voiceModelStatus, handler);
    },
  },
  auth: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.authGetState),
    retry: () => ipcRenderer.invoke(IPC_CHANNELS.authRetry),
    requestEmailCode: (email) => ipcRenderer.invoke(IPC_CHANNELS.authRequestEmailCode, email),
    verifyEmailCode: (challengeId, code) => ipcRenderer.invoke(IPC_CHANNELS.authVerifyEmailCode, { challengeId, code }),
    updateName: (name) => ipcRenderer.invoke(IPC_CHANNELS.authUpdateName, name),
    updateAvatar: (image) => ipcRenderer.invoke(IPC_CHANNELS.authUpdateAvatar, image),
    createMobileConnect: () => ipcRenderer.invoke(IPC_CHANNELS.authCreateMobileConnect),
    listMobileConnectedDevices: () => ipcRenderer.invoke(IPC_CHANNELS.authListMobileConnectedDevices),
    revokeMobileConnectedDevice: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.authRevokeMobileConnectedDevice, sessionId),
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
  hostedSites: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.hostedSitesList).then(decodeHostedSites),
    chooseDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.hostedSitesChooseDirectory).then(decodeNullablePath),
    publish: (input) => ipcRenderer.invoke(IPC_CHANNELS.hostedSitesPublish, input).then(decodeHostedSite),
    replace: (input) => ipcRenderer.invoke(IPC_CHANNELS.hostedSitesReplace, input).then(decodeHostedSite),
    delete: (input) => ipcRenderer.invoke(IPC_CHANNELS.hostedSitesDelete, input).then(decodeVoid),
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
    listInstalledSkills: (botId) => invokeAgent(IPC_CHANNELS.agentListInstalledSkills, botId, decodeInstalledSkills),
    getSidebarLayout: () => invokeAgent(IPC_CHANNELS.agentGetSidebarLayout, null, decodeSidebarLayout),
    mutateSidebarLayout: (action) => invokeAgent(IPC_CHANNELS.agentMutateSidebarLayout, action, decodeSidebarLayout),
    createBot: (input) => invokeAgent(IPC_CHANNELS.agentCreateBot, input, decodeBot),
    duplicateBot: (botId) => invokeAgent(IPC_CHANNELS.agentDuplicateBot, botId, decodeDuplicateBotResult),
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
    readConversationPage: (input, serverId = selectedServerId) =>
      invokeAgentForServer(serverId, IPC_CHANNELS.agentReadConversationPage, input, decodeConversationPage),
    searchConversationMessages: (input) =>
      invokeAgent(IPC_CHANNELS.agentSearchConversationMessages, input, decodeConversationSearchPage),
    listConversationReads: () => invokeAgent(IPC_CHANNELS.agentListConversationReads, null, decodeReadStates),
    markConversationRead: (input, serverId = selectedServerId) =>
      invokeAgentForServer(serverId, IPC_CHANNELS.agentMarkConversationRead, input, decodeReadState),
    chooseAttachments: (input) => invokeAgent(IPC_CHANNELS.agentChooseAttachments, input, decodeAttachments),
    onAttachmentImport: (listener) => {
      attachmentImportListeners.add(listener);
      return () => attachmentImportListeners.delete(listener);
    },
    discardDraftAttachment: (attachmentId, serverId = selectedServerId) =>
      invokeAgentForServer(serverId, IPC_CHANNELS.agentDiscardDraftAttachment, attachmentId, decodeVoid),
    openAttachment: (input) => invokeAgent(IPC_CHANNELS.agentOpenAttachment, input, decodeVoid),
    openSharedFile: (input) => invokeAgent(IPC_CHANNELS.agentOpenSharedFile, input, decodeVoid),
    openWorkspaceFile: (input) => invokeAgent(IPC_CHANNELS.agentOpenWorkspaceFile, input, decodeVoid),
    previewSharedFile: (input) => invokeAgent(IPC_CHANNELS.agentPreviewSharedFile, input, decodeFilePreview),
    previewWorkspaceFile: (input) => invokeAgent(IPC_CHANNELS.agentPreviewWorkspaceFile, input, decodeFilePreview),
    sendMessage: (input, serverId = selectedServerId) =>
      invokeAgentForServer(serverId, IPC_CHANNELS.agentSendMessage, input, decodeReceipt),
    setMessageReaction: (input) => invokeAgent(IPC_CHANNELS.agentSetMessageReaction, input, decodeVoid),
    listQueue: (botId) => invokeAgent(IPC_CHANNELS.agentListQueue, botId, decodeQueue),
    acknowledgeFailedTurn: (input) => invokeAgent(IPC_CHANNELS.agentAcknowledgeFailedTurn, input, decodeVoid),
    cancelQueuedMessage: (input) => invokeAgent(IPC_CHANNELS.agentCancelQueuedMessage, input, decodeVoid),
    steerQueuedMessage: (input) => invokeAgent(IPC_CHANNELS.agentSteerQueuedMessage, input, decodeVoid),
    updateQueuedMessage: (input, serverId = selectedServerId) =>
      invokeAgentForServer(serverId, IPC_CHANNELS.agentUpdateQueuedMessage, input, decodeVoid),
    reorderQueue: (input) => invokeAgent(IPC_CHANNELS.agentReorderQueue, input, decodeVoid),
    interrupt: (input) => invokeAgent(IPC_CHANNELS.agentInterrupt, input, decodeVoid),
    respondToPrompt: (input) => invokeAgent(IPC_CHANNELS.agentRespondToPrompt, input, decodeVoid),
    respondToApproval: (input) => invokeAgent(IPC_CHANNELS.agentRespondToApproval, input, decodeVoid),
    respondToBrowserTakeover: (input) => invokeAgent(IPC_CHANNELS.agentRespondToBrowserTakeover, input, decodeVoid),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ScopedAgentEvent) => {
        if (payload.serverId === selectedServerId) listener(payload.event);
      };
      ipcRenderer.on(IPC_CHANNELS.agentEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, handler);
    },
    onScopedEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ScopedAgentEvent) => listener(payload);
      ipcRenderer.on(IPC_CHANNELS.agentEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, handler);
    },
  },
  browser: {
    open: (input) => ipcRenderer.invoke(IPC_CHANNELS.browserOpen, input),
    activate: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserActivate, tabId),
    navigate: (input) => ipcRenderer.invoke(IPC_CHANNELS.browserNavigate, input),
    reload: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserReload, tabId),
    close: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserClose, tabId),
    listTabs: () => ipcRenderer.invoke(IPC_CHANNELS.browserListTabs),
    getDisplayState: () => ipcRenderer.invoke(IPC_CHANNELS.browserGetDisplayState),
    getControlState: () => ipcRenderer.invoke(IPC_CHANNELS.browserGetControlState),
    capturePreview: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserCapturePreview, tabId).then(decodeBrowserPreview),
    setVisible: (input) => ipcRenderer.invoke(IPC_CHANNELS.browserSetVisible, input),
    onDisplayState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.browserDisplayStateEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.browserDisplayStateEvent, handler);
    },
    openPictureInPicture: (bounds) => ipcRenderer.invoke(IPC_CHANNELS.browserPictureInPictureOpen, bounds),
    closePictureInPicture: () => ipcRenderer.invoke(IPC_CHANNELS.browserPictureInPictureClose),
    dockPictureInPicture: () => ipcRenderer.invoke(IPC_CHANNELS.browserPictureInPictureDock),
    hidePictureInPicture: () => ipcRenderer.invoke(IPC_CHANNELS.browserPictureInPictureHide),
    onPictureInPictureEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, event: Parameters<typeof listener>[0]) => listener(event);
      ipcRenderer.on(IPC_CHANNELS.browserPictureInPictureEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.browserPictureInPictureEvent, handler);
    },
  },
  update: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.updateGetStatus),
    check: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
    download: () => ipcRenderer.invoke(IPC_CHANNELS.updateDownload),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
    getPreference: () => ipcRenderer.invoke(IPC_CHANNELS.updateGetPreference),
    setPreference: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateSetPreference, input),
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
    retryConnection: (serverId) => ipcRenderer.invoke(IPC_CHANNELS.serversRetryConnection, serverId),
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
