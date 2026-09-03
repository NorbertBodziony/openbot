import type { RemoteDesktopSession } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, flush, onSettled } from "solid-js";
import { desktopAnalytics } from "./analytics";
import { usePlatform } from "./platform";
import { serverSupportsCapability } from "./server-capabilities";
import { useServers } from "./servers";
import { createSimpleContext } from "./simple-context";

/**
 * Remote Control: viewing another machine's desktop through a server that
 * offers it.
 *
 * Global rather than scoped to the active server, for the same reason as
 * `server-settings.tsx` - `openRemoteDesktopWorkspace(serverId, trigger)` takes
 * an id and the rail can start a session on a server the user is not currently
 * on.
 *
 * Ungated - nothing is connected until someone opens the workspace.
 *
 * Three pieces of state that look redundant and are not:
 *
 * - `remoteDesktopWorkspaceServerId` is which server the workspace is *for*;
 *   `remoteDesktopWorkspaceVisible` is whether it is on screen. Hiding keeps the
 *   session, which is what makes hide/resume a round trip rather than a
 *   reconnect.
 * - `remoteDesktopSessionEstablished` is set once a connection has been seen, so
 *   the second effect below can tell "the session went away" from "no session
 *   yet", and only tear the workspace down for the first.
 * - `remoteDesktopConnectPromise` is the in-flight connect, so a second open of
 *   the same server awaits it instead of racing a second connect, and a
 *   disconnect arriving mid-connect has something to wait on.
 */
const RemoteDesktop = createSimpleContext({
  name: "Remote desktop",
  init: () => {
    const platform = usePlatform();
    const { servers, activeServer } = useServers();
    const [remoteDesktopSessions, setRemoteDesktopSessions] = createSignal<RemoteDesktopSession[]>([]);
    const [remoteDesktopWorkspaceServerId, setRemoteDesktopWorkspaceServerId] = createSignal<string | null>(null);
    const [remoteDesktopWorkspaceVisible, setRemoteDesktopWorkspaceVisible] = createSignal(false);
    const [remoteDesktopConnectingServerId, setRemoteDesktopConnectingServerId] = createSignal<string | null>(null);
    const [remoteDesktopConnectionError, setRemoteDesktopConnectionError] = createSignal<string | null>(null);
    const [remoteDesktopSessionEstablished, setRemoteDesktopSessionEstablished] = createSignal(false);
    let remoteDesktopRestoreTarget: HTMLElement | null = null;
    let remoteDesktopConnectPromise: Promise<RemoteDesktopSession | undefined> | null = null;
    /** Bumped by every open, retry and disconnect, so a late connect cannot revive a closed workspace. */
    let remoteDesktopConnectionRequest = 0;

    async function connectRemoteDesktop(serverId: string): Promise<RemoteDesktopSession> {
      const analytics = desktopAnalytics.scope();
      try {
        const session = await window.openbot.remoteDesktop.connect({ serverId });
        setRemoteDesktopSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
        analytics.track("remote_desktop_action", {
          action: "connect",
          result: "succeeded",
          transport: session.transport,
        });
        return session;
      } catch (error) {
        analytics.track("remote_desktop_action", {
          action: "connect",
          result: "failed",
          failure_code: "connection_failed",
        });
        throw error;
      }
    }

    async function disconnectRemoteDesktop(sessionId: string): Promise<void> {
      const analytics = desktopAnalytics.scope();
      try {
        await window.openbot.remoteDesktop.disconnect(sessionId);
        setRemoteDesktopSessions((current) => current.filter((session) => session.id !== sessionId));
        analytics.track("remote_desktop_action", { action: "disconnect", result: "succeeded" });
      } catch (error) {
        analytics.track("remote_desktop_action", {
          action: "disconnect",
          result: "failed",
          failure_code: "disconnect_failed",
        });
        throw error;
      }
    }

    async function selectRemoteDesktopDisplay(serverId: string, displayId: string): Promise<void> {
      const analytics = desktopAnalytics.scope();
      try {
        await window.openbot.remoteDesktop.selectDisplay({ serverId, displayId });
        setRemoteDesktopSessions((current) =>
          current.map((session) =>
            session.serverId === serverId ? { ...session, selectedDisplayId: displayId } : session,
          ),
        );
        analytics.track("remote_desktop_action", { action: "select_display", result: "succeeded" });
      } catch (error) {
        analytics.track("remote_desktop_action", {
          action: "select_display",
          result: "failed",
          failure_code: "display_select_failed",
        });
        throw error;
      }
    }

    function latestRemoteDesktopSession(serverId: string): RemoteDesktopSession | undefined {
      return [...remoteDesktopSessions()]
        .filter((session) => session.serverId === serverId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    }

    function restoreRemoteDesktopFocus(): void {
      const target = remoteDesktopRestoreTarget;
      remoteDesktopRestoreTarget = null;
      if (target?.isConnected) requestAnimationFrame(() => target.focus());
    }

    function hideRemoteDesktopWorkspace(): void {
      setRemoteDesktopWorkspaceVisible(false);
      restoreRemoteDesktopFocus();
    }

    async function startRemoteDesktopConnection(
      serverId: string,
      request: number,
    ): Promise<RemoteDesktopSession | undefined> {
      try {
        const session = await connectRemoteDesktop(serverId);
        if (request !== remoteDesktopConnectionRequest || remoteDesktopWorkspaceServerId() !== serverId) {
          await disconnectRemoteDesktop(session.id);
          return undefined;
        }
        setRemoteDesktopSessionEstablished(true);
        return session;
      } catch (error) {
        if (request === remoteDesktopConnectionRequest && remoteDesktopWorkspaceServerId() === serverId) {
          setRemoteDesktopConnectionError(error instanceof Error ? error.message : "Could not start remote control.");
        }
        return undefined;
      } finally {
        if (request === remoteDesktopConnectionRequest) setRemoteDesktopConnectingServerId(null);
      }
    }

    async function openRemoteDesktopWorkspace(serverId: string, trigger: HTMLElement): Promise<void> {
      const server = servers().find((item) => item.id === serverId);
      const existingSession = latestRemoteDesktopSession(serverId);
      if (
        server?.kind !== "remote" ||
        !serverSupportsCapability(server, "remote-desktop") ||
        (!existingSession && (server.state !== "online" || !server.remoteDesktopAvailable))
      ) {
        return;
      }

      remoteDesktopRestoreTarget = trigger;
      setRemoteDesktopWorkspaceServerId(serverId);
      setRemoteDesktopWorkspaceVisible(true);
      setRemoteDesktopConnectionError(null);
      if (existingSession) {
        setRemoteDesktopSessionEstablished(true);
        return;
      }
      if (remoteDesktopConnectPromise && remoteDesktopConnectingServerId() === serverId) {
        await remoteDesktopConnectPromise;
        return;
      }

      const request = ++remoteDesktopConnectionRequest;
      setRemoteDesktopSessionEstablished(false);
      setRemoteDesktopConnectingServerId(serverId);
      const connection = startRemoteDesktopConnection(serverId, request);
      remoteDesktopConnectPromise = connection;
      await connection;
      if (remoteDesktopConnectPromise === connection) remoteDesktopConnectPromise = null;
    }

    async function retryRemoteDesktopWorkspace(): Promise<void> {
      const serverId = remoteDesktopWorkspaceServerId();
      if (!serverId) return;
      const existingSession = latestRemoteDesktopSession(serverId);
      const request = ++remoteDesktopConnectionRequest;
      setRemoteDesktopConnectionError(null);
      setRemoteDesktopSessionEstablished(false);
      setRemoteDesktopConnectingServerId(serverId);
      if (existingSession) await disconnectRemoteDesktop(existingSession.id);
      const connection = startRemoteDesktopConnection(serverId, request);
      remoteDesktopConnectPromise = connection;
      await connection;
      if (remoteDesktopConnectPromise === connection) remoteDesktopConnectPromise = null;
    }

    async function disconnectRemoteDesktopWorkspace(restoreFocus = true): Promise<void> {
      const serverId = remoteDesktopWorkspaceServerId();
      if (!serverId) return;
      ++remoteDesktopConnectionRequest;
      setRemoteDesktopConnectionError(null);
      setRemoteDesktopSessionEstablished(false);
      const session = latestRemoteDesktopSession(serverId);
      if (session) await disconnectRemoteDesktop(session.id);
      else await remoteDesktopConnectPromise;
      remoteDesktopConnectPromise = null;
      setRemoteDesktopConnectingServerId(null);
      setRemoteDesktopWorkspaceVisible(false);
      setRemoteDesktopWorkspaceServerId(null);
      if (restoreFocus) restoreRemoteDesktopFocus();
      else remoteDesktopRestoreTarget = null;
    }
    const activeRemoteDesktopSession = createMemo(() => {
      const server = activeServer();
      return server ? latestRemoteDesktopSession(server.id) : undefined;
    });
    const remoteDesktopWorkspaceServer = createMemo(() => {
      const serverId = remoteDesktopWorkspaceServerId();
      return serverId ? servers().find((server) => server.id === serverId) : undefined;
    });
    const remoteDesktopWorkspaceSession = createMemo(() => {
      const serverId = remoteDesktopWorkspaceServerId();
      return serverId ? latestRemoteDesktopSession(serverId) : undefined;
    });

    createEffect(
      () => remoteDesktopWorkspaceVisible(),
      (visible) => {
        const frame = platform.appFrame();
        if (frame) frame.inert = visible;
      },
    );

    createEffect(
      () => {
        const serverId = remoteDesktopWorkspaceServerId();
        return {
          serverId,
          established: remoteDesktopSessionEstablished(),
          sessionExists: serverId ? Boolean(latestRemoteDesktopSession(serverId)) : false,
          connectingServerId: remoteDesktopConnectingServerId(),
        };
      },
      ({ serverId, established, sessionExists, connectingServerId }) => {
        if (serverId && established && !sessionExists && connectingServerId !== serverId) {
          setRemoteDesktopSessionEstablished(false);
          setRemoteDesktopWorkspaceVisible(false);
          setRemoteDesktopWorkspaceServerId(null);
          restoreRemoteDesktopFocus();
        }
      },
    );

    onSettled(() => {
      if (platform.landingPreview) return;
      const unsubscribe = window.openbot.remoteDesktop.onEvent((sessions) =>
        flush(() => setRemoteDesktopSessions(sessions)),
      );
      void window.openbot.remoteDesktop
        .list()
        .then(setRemoteDesktopSessions)
        .catch(() => undefined);
      return unsubscribe;
    });

    return {
      activeRemoteDesktopSession,
      remoteDesktopWorkspaceServer,
      remoteDesktopWorkspaceSession,
      remoteDesktopWorkspaceVisible,
      remoteDesktopConnectingServerId,
      remoteDesktopConnectionError,
      openRemoteDesktopWorkspace,
      hideRemoteDesktopWorkspace,
      retryRemoteDesktopWorkspace,
      disconnectRemoteDesktopWorkspace,
      selectRemoteDesktopDisplay,
    };
  },
});

export const RemoteDesktopProvider = RemoteDesktop.provider;
export const useRemoteDesktop = RemoteDesktop.use;
