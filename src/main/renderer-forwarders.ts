/**
 * The eleven service events the main process relays to the renderer. They live here rather than in
 * the entry point because every one of them is the same three lines around a different channel, and
 * because they are the part of the entry point most likely to be edited by two agents at once.
 *
 * Every dependency is a **function**, never a nullable value. Most of these are subscribed before
 * the service they read exists, so `getHostService()` and `hostService` behave differently at run
 * time - and `() => HostService | null` and `HostService | null` both type-check at every call site,
 * so `tsc` cannot tell you which one you passed. A function-typed field makes the wrong one an error.
 *
 * `showMainWindow` is injected for a second reason: importing it from the entry point would be an
 * import cycle, which Biome rejects, and is forbidden by `src/main/AGENTS.md`.
 */

import {
  type AgentEvent,
  type BrowserDisplayState,
  IPC_CHANNELS,
  LOCAL_SERVER_ID,
  type VoiceModelStatus,
} from "@openbot/contracts/ipc";
import { BrowserWindow, Notification } from "electron";
import type { AgentService } from "../backend/agent-service";
import { notificationForAgentEvent } from "./agent-notifications";
import type { HostAnalytics } from "./analytics";
import type { HostService } from "./host-service";
import { withLocalHostSummary } from "./ipc/register-team-handlers";
import type { RemoteServerManager } from "./remote-server-manager";
import { sendToRenderer } from "./renderer-ipc";

export interface RendererForwarderDependencies {
  getMainWindow: () => BrowserWindow | null;
  getAgentService: () => AgentService | null;
  getHostService: () => HostService | null;
  getHostAnalytics: () => HostAnalytics | null;
  getRemoteServerManager: () => RemoteServerManager | null;
  showMainWindow: (window: BrowserWindow) => void;
}

/**
 * Returns the forwarders as an object so the entry point can destructure it and keep every
 * `service.on("event", forwardX)` registration exactly as it was.
 */
export function createRendererForwarders({
  getMainWindow,
  getAgentService,
  getHostService,
  getHostAnalytics,
  getRemoteServerManager,
  showMainWindow,
}: RendererForwarderDependencies) {
  function forwardAgentEvent(serverId: string, event: AgentEvent, bufferedLive = false): void {
    if (serverId === LOCAL_SERVER_ID) getHostAnalytics()?.handleAgentEvent(event);
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    sendToRenderer(
      window,
      IPC_CHANNELS.agentEvent,
      bufferedLive ? { serverId, event, bufferedLive } : { serverId, event },
    );
    if (window.isFocused() || !Notification.isSupported()) return;

    const content = notificationForAgentEvent(event, getAgentService()?.listAgents() ?? []);
    if (!content) return;
    const notification = new Notification(content);
    notification.on("click", () => {
      // Re-read rather than reuse the local above: a notification can be clicked long after it was
      // shown, by which time the window may have been closed and a new one built.
      const current = getMainWindow();
      if (!current || current.isDestroyed()) return;
      showMainWindow(current);
    });
    notification.show();
  }

  function forwardBrowserDisplayState(state: BrowserDisplayState): void {
    for (const window of BrowserWindow.getAllWindows()) {
      sendToRenderer(window, IPC_CHANNELS.browserDisplayStateEvent, state);
    }
  }

  function forwardUpdateStatus(status: import("@openbot/contracts/ipc").UpdateStatus): void {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    sendToRenderer(window, IPC_CHANNELS.updateEvent, status);
  }

  function forwardVoiceModelStatus(status: VoiceModelStatus): void {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    sendToRenderer(window, IPC_CHANNELS.voiceModelStatus, status);
  }

  function forwardProviderRuntimeStatus(snapshot: import("@openbot/contracts/ipc").ProviderRuntimeSnapshot): void {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    sendToRenderer(window, IPC_CHANNELS.providerRuntimesEvent, snapshot);
  }

  function forwardHostStatus(status: import("@openbot/contracts/ipc").HostStatus): void {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    sendToRenderer(window, IPC_CHANNELS.hostEvent, status);
    const remoteServers = getRemoteServerManager();
    if (remoteServers) {
      sendToRenderer(window, IPC_CHANNELS.serversEvent, withLocalHostSummary(remoteServers.list(), status));
    }
  }

  function forwardRemoteDesktopSessions(sessions: import("@openbot/contracts/ipc").RemoteDesktopSession[]): void {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    sendToRenderer(window, IPC_CHANNELS.remoteDesktopEvent, sessions);
  }

  function forwardServers(servers: import("@openbot/contracts/ipc").ServerSummary[]): void {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    const host = getHostService();
    sendToRenderer(window, IPC_CHANNELS.serversEvent, host ? withLocalHostSummary(servers, host.getStatus()) : servers);
  }

  function forwardTeamPresence(
    serverId: string,
    snapshot: import("@openbot/contracts/ipc").TeamPresenceSnapshot,
  ): void {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    sendToRenderer(window, IPC_CHANNELS.serversPresence, { serverId, snapshot });
  }

  function forwardDirectMessage(
    serverId: string,
    event: import("@openbot/contracts/ipc").DirectMessageRealtimeEvent,
  ): void {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    sendToRenderer(window, IPC_CHANNELS.serversDirectMessage, { serverId, event });
  }

  function forwardDirectTyping(
    serverId: string,
    event: import("@openbot/contracts/ipc").DirectTypingRealtimeEvent,
  ): void {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    sendToRenderer(window, IPC_CHANNELS.serversDirectTyping, { serverId, event });
  }

  return {
    forwardAgentEvent,
    forwardBrowserDisplayState,
    forwardUpdateStatus,
    forwardVoiceModelStatus,
    forwardProviderRuntimeStatus,
    forwardHostStatus,
    forwardRemoteDesktopSessions,
    forwardServers,
    forwardTeamPresence,
    forwardDirectMessage,
    forwardDirectTyping,
  };
}
