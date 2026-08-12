import { contextBridge, ipcRenderer } from "electron";
import { type AgentEvent, type InfeldDesktopApi, IPC_CHANNELS } from "../shared/ipc";

const infeldApi: InfeldDesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  agent: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.agentGetStatus),
    listBots: () => ipcRenderer.invoke(IPC_CHANNELS.agentListBots),
    createBot: () => ipcRenderer.invoke(IPC_CHANNELS.agentCreateBot),
    readConversation: (botId) => ipcRenderer.invoke(IPC_CHANNELS.agentReadConversation, botId),
    sendMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.agentSendMessage, input),
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
    setVisible: (input) => ipcRenderer.invoke(IPC_CHANNELS.browserSetVisible, input),
  },
};

contextBridge.exposeInMainWorld("infeld", infeldApi);
