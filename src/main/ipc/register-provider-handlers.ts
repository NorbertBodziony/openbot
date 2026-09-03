// Signing in to Codex, Claude and Grok, and downloading the CLI runtimes they need.

import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { shell } from "electron";
import type { AgentService } from "../../backend/agent-service";
import type { ProviderRuntimeManager } from "../provider-runtime-manager";
import { handleTrusted } from "../trusted-ipc";
import { parseProviderId } from "./app-inputs";

export interface ProviderIpcDependencies {
  service: AgentService;
  providerRuntimes: ProviderRuntimeManager;
}

export function registerProviderIpcHandlers({ service, providerRuntimes }: ProviderIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.connectChatGPT, () =>
    service.connectChatGPT(async (value) => {
      const url = new URL(value);
      if (url.protocol !== "https:") throw new Error("Only HTTPS ChatGPT login links can open in the browser.");
      await shell.openExternal(url.toString());
    }),
  );
  handleTrusted(IPC_CHANNELS.connectClaude, () => service.connectClaude());
  handleTrusted(IPC_CHANNELS.connectGrok, () => service.connectGrok());
  handleTrusted(IPC_CHANNELS.refreshAgentProviders, () => service.refreshProviders());
  handleTrusted(IPC_CHANNELS.providerRuntimesGetStatus, () => providerRuntimes.getStatus());
  handleTrusted(IPC_CHANNELS.providerRuntimesDownload, parseProviderId, (parsed) => providerRuntimes.download(parsed));
  handleTrusted(IPC_CHANNELS.providerRuntimesCancel, parseProviderId, (parsed) => providerRuntimes.cancel(parsed));
}
