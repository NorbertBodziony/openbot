import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  type AgentEvent,
  type AttachmentImportEvent,
  type ImportAttachmentsInput,
  type InfeldDesktopApi,
  IPC_CHANNELS,
} from "../shared/ipc";

const attachmentImportListeners = new Set<(event: AttachmentImportEvent) => void>();

function emitAttachmentImport(event: AttachmentImportEvent): void {
  for (const listener of attachmentImportListeners) listener(event);
}

async function importFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  emitAttachmentImport({ type: "started" });
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
    const attachments = await ipcRenderer.invoke(IPC_CHANNELS.agentImportAttachments, input);
    emitAttachmentImport({ type: "completed", attachments });
  } catch (error) {
    emitAttachmentImport({
      type: "error",
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
  if (files.length) void importFiles(files);
});

const infeldApi: InfeldDesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  agent: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.agentGetStatus),
    listModels: () => ipcRenderer.invoke(IPC_CHANNELS.agentListModels),
    listBots: () => ipcRenderer.invoke(IPC_CHANNELS.agentListBots),
    createBot: () => ipcRenderer.invoke(IPC_CHANNELS.agentCreateBot),
    updateBot: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentUpdateBot, input),
    deleteBot: (botId) => ipcRenderer.invoke(IPC_CHANNELS.agentDeleteBot, botId),
    readConversation: (botId) => ipcRenderer.invoke(IPC_CHANNELS.agentReadConversation, botId),
    chooseAttachments: () => ipcRenderer.invoke(IPC_CHANNELS.agentChooseAttachments),
    onAttachmentImport: (listener) => {
      attachmentImportListeners.add(listener);
      return () => attachmentImportListeners.delete(listener);
    },
    discardDraftAttachment: (attachmentId) =>
      ipcRenderer.invoke(IPC_CHANNELS.agentDiscardDraftAttachment, attachmentId),
    openAttachment: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentOpenAttachment, input),
    sendMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentSendMessage, input),
    listQueue: (botId) => ipcRenderer.invoke(IPC_CHANNELS.agentListQueue, botId),
    cancelQueuedMessage: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.agentCancelQueuedMessage, input),
    setQueuePaused: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentSetQueuePaused, input),
    interrupt: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentInterrupt, input),
    respondToPrompt: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentRespondToPrompt, input),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
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
};

contextBridge.exposeInMainWorld("infeld", infeldApi);
