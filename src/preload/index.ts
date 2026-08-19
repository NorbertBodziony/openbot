import {
  type AgentIpcRequest,
  type AttachmentImportEvent,
  type DraftAttachment,
  type ImportAttachmentsInput,
  IPC_CHANNELS,
  type OpenBotDesktopApi,
  type ScopedAgentEvent,
  type ScopedDirectMessageEvent,
  type ScopedDirectTypingEvent,
  type ScopedTeamPresenceSnapshot,
  type UpdateStatus,
} from "@openbot/contracts/ipc";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const attachmentImportListeners = new Set<(event: AttachmentImportEvent) => void>();
let selectedServerId = "local";

function invokeAgent<TResult>(channel: string, payload: unknown = null): Promise<TResult> {
  const request: AgentIpcRequest = { serverId: selectedServerId, payload };
  return ipcRenderer.invoke(channel, request) as Promise<TResult>;
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
    const attachments = (await invokeAgent(
      IPC_CHANNELS.agentImportAttachments,
      input,
    )) as DraftAttachment[];
    emitAttachmentImport({ type: "completed", requestId, attachments });
  } catch (error) {
    emitAttachmentImport({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

window.addEventListener("dragover", (event) => {
  if ([...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file")) {
    event.preventDefault();
  }
});
window.addEventListener("drop", (event) => {
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

const openbotApi: OpenBotDesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getSetupState: () => ipcRenderer.invoke(IPC_CHANNELS.getSetupState),
  saveSetup: (input) => ipcRenderer.invoke(IPC_CHANNELS.saveSetup, input),
  getMacPermissions: () => ipcRenderer.invoke(IPC_CHANNELS.getMacPermissions),
  requestMacPermission: (permission) =>
    ipcRenderer.invoke(IPC_CHANNELS.requestMacPermission, permission),
  openExternal: (destination) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, destination),
  openUrl: (url) => ipcRenderer.invoke(IPC_CHANNELS.openUrl, url),
  auth: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.authGetState),
    retry: () => ipcRenderer.invoke(IPC_CHANNELS.authRetry),
    requestEmailCode: (email) => ipcRenderer.invoke(IPC_CHANNELS.authRequestEmailCode, email),
    verifyEmailCode: (challengeId, code) =>
      ipcRenderer.invoke(IPC_CHANNELS.authVerifyEmailCode, { challengeId, code }),
    updateAvatar: (image) => ipcRenderer.invoke(IPC_CHANNELS.authUpdateAvatar, image),
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.authLogout),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) =>
        listener(state);
      ipcRenderer.on(IPC_CHANNELS.authEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.authEvent, handler);
    },
  },
  agent: {
    getStatus: () =>
      invokeAgent(IPC_CHANNELS.agentGetStatus) as ReturnType<
        OpenBotDesktopApi["agent"]["getStatus"]
      >,
    getUsage: () =>
      invokeAgent(IPC_CHANNELS.agentGetUsage) as ReturnType<OpenBotDesktopApi["agent"]["getUsage"]>,
    listModels: () =>
      invokeAgent(IPC_CHANNELS.agentListModels) as ReturnType<
        OpenBotDesktopApi["agent"]["listModels"]
      >,
    listBots: () =>
      invokeAgent(IPC_CHANNELS.agentListBots) as ReturnType<OpenBotDesktopApi["agent"]["listBots"]>,
    createBot: () =>
      invokeAgent(IPC_CHANNELS.agentCreateBot) as ReturnType<
        OpenBotDesktopApi["agent"]["createBot"]
      >,
    updateBot: (input) =>
      invokeAgent(IPC_CHANNELS.agentUpdateBot, input) as ReturnType<
        OpenBotDesktopApi["agent"]["updateBot"]
      >,
    setAvatar: (input) =>
      invokeAgent(IPC_CHANNELS.agentSetAvatar, input) as ReturnType<
        OpenBotDesktopApi["agent"]["setAvatar"]
      >,
    deleteBot: (botId) => invokeAgent(IPC_CHANNELS.agentDeleteBot, botId) as Promise<void>,
    readConversation: (botId) =>
      invokeAgent(IPC_CHANNELS.agentReadConversation, botId) as ReturnType<
        OpenBotDesktopApi["agent"]["readConversation"]
      >,
    chooseAttachments: () =>
      invokeAgent(IPC_CHANNELS.agentChooseAttachments) as ReturnType<
        OpenBotDesktopApi["agent"]["chooseAttachments"]
      >,
    onAttachmentImport: (listener) => {
      attachmentImportListeners.add(listener);
      return () => attachmentImportListeners.delete(listener);
    },
    discardDraftAttachment: (attachmentId) =>
      invokeAgent(IPC_CHANNELS.agentDiscardDraftAttachment, attachmentId) as Promise<void>,
    openAttachment: (input) =>
      invokeAgent(IPC_CHANNELS.agentOpenAttachment, input) as Promise<void>,
    sendMessage: (input) =>
      invokeAgent(IPC_CHANNELS.agentSendMessage, input) as ReturnType<
        OpenBotDesktopApi["agent"]["sendMessage"]
      >,
    setMessageReaction: (input) =>
      invokeAgent(IPC_CHANNELS.agentSetMessageReaction, input) as Promise<void>,
    listQueue: (botId) =>
      invokeAgent(IPC_CHANNELS.agentListQueue, botId) as ReturnType<
        OpenBotDesktopApi["agent"]["listQueue"]
      >,
    cancelQueuedMessage: (input) =>
      invokeAgent(IPC_CHANNELS.agentCancelQueuedMessage, input) as Promise<void>,
    setQueuePaused: (input) =>
      invokeAgent(IPC_CHANNELS.agentSetQueuePaused, input) as Promise<void>,
    steerQueuedMessage: (input) =>
      invokeAgent(IPC_CHANNELS.agentSteerQueuedMessage, input) as Promise<void>,
    updateQueuedMessage: (input) =>
      invokeAgent(IPC_CHANNELS.agentUpdateQueuedMessage, input) as Promise<void>,
    reorderQueue: (input) => invokeAgent(IPC_CHANNELS.agentReorderQueue, input) as Promise<void>,
    interrupt: (input) => invokeAgent(IPC_CHANNELS.agentInterrupt, input) as Promise<void>,
    respondToPrompt: (input) =>
      invokeAgent(IPC_CHANNELS.agentRespondToPrompt, input) as Promise<void>,
    respondToApproval: (input) =>
      invokeAgent(IPC_CHANNELS.agentRespondToApproval, input) as Promise<void>,
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
    select: async (serverId) =>
      rememberActiveServer(await ipcRenderer.invoke(IPC_CHANNELS.serversSelect, serverId)),
    join: async (input) => {
      const server = await ipcRenderer.invoke(IPC_CHANNELS.serversJoin, input);
      selectedServerId = server.id;
      return server;
    },
    login: async (input) => {
      const server = await ipcRenderer.invoke(IPC_CHANNELS.serversLogin, input);
      selectedServerId = server.id;
      return server;
    },
    updateAddress: (updateUrl) => ipcRenderer.invoke(IPC_CHANNELS.serversUpdateAddress, updateUrl),
    remove: (serverId) => ipcRenderer.invoke(IPC_CHANNELS.serversRemove, serverId),
    getPresence: () => ipcRenderer.invoke(IPC_CHANNELS.serversGetPresence),
    setTyping: (input) => ipcRenderer.invoke(IPC_CHANNELS.serversSetTyping, input),
    onPresence: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ScopedTeamPresenceSnapshot) => {
        if (payload.serverId === selectedServerId) listener(payload.snapshot);
      };
      ipcRenderer.on(IPC_CHANNELS.serversPresence, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.serversPresence, handler);
    },
    listDirectThreads: () => ipcRenderer.invoke(IPC_CHANNELS.serversListDirectThreads),
    readDirectConversation: (memberId) =>
      ipcRenderer.invoke(IPC_CHANNELS.serversReadDirectConversation, memberId),
    sendDirectMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.serversSendDirectMessage, input),
    markDirectRead: (memberId) => ipcRenderer.invoke(IPC_CHANNELS.serversMarkDirectRead, memberId),
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
      const handler = (
        _event: Electron.IpcRendererEvent,
        servers: Parameters<typeof listener>[0],
      ) => listener(rememberActiveServer(servers));
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
    configureRemoteDesktop: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.hostConfigureRemoteDesktop, input),
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
    createAddressUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.hostCreateAddressUpdate),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof listener>[0]) =>
        listener(status);
      ipcRenderer.on(IPC_CHANNELS.hostEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.hostEvent, handler);
    },
  },
  remoteMac: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.remoteMacList),
    connect: (input) => ipcRenderer.invoke(IPC_CHANNELS.remoteMacConnect, input),
    disconnect: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.remoteMacDisconnect, sessionId),
    getCredentials: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.remoteMacGetCredentials, sessionId),
    onEvent: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        sessions: Parameters<typeof listener>[0],
      ) => listener(sessions);
      ipcRenderer.on(IPC_CHANNELS.remoteMacEvent, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.remoteMacEvent, handler);
    },
  },
};

contextBridge.exposeInMainWorld("openbot", openbotApi);
