import type { HostStatus, ServerSummary } from "@openbot/contracts/ipc";
import type { TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import { createMemo, createSignal, flush, onSettled } from "solid-js";
import { FALLBACK_HOST_STATUS } from "./app-defaults";
import { toast } from "./components/ui";
import { serverSupportsCapability } from "./server-capabilities";
import { createSimpleContext } from "./simple-context";

/**
 * The workspaces the user can switch between - the local one this computer
 * hosts and every remote team server joined - plus the status of the host this
 * computer runs itself.
 *
 * Two things are deliberately *not* here, and both are the same rule: a domain
 * never reaches into one nested under it.
 *
 * - **`selectServer` stays in the controller.** It tears down and refetches
 *   agents, conversation, direct messages, turns, browser tabs and the sidebar -
 *   every domain that sits below this one. It moves here (or into the keyed
 *   scope that replaces it) once those domains own their own teardown, which is
 *   what the scoped-provider step does.
 * - **`serverLoadRequest` is how this domain asks for that anyway.** A retried
 *   incompatible host, or a remote that only just reported its version, has to
 *   be loaded again the moment the summaries say so. Rather than call downward,
 *   `applyServerSummaries` publishes the request and whoever owns `selectServer`
 *   reacts to it - the same `{ id, nonce }` shape the renderer already uses for
 *   `settingsRequest` and `messageFocusRequest`. The nonce is load-bearing: the
 *   same server can need loading twice in a row.
 *
 * `initialServersReady` exists for the same reason. The first `list()` read is
 * this domain's, but the per-server bootstrap that runs after it belongs to the
 * domains below, so they get the promise instead of the read.
 *
 * Ungated - see `app-providers.tsx` for why no provider gates during the
 * migration. `activeServerId()` answers `"local"` before the list arrives, which
 * is the same answer it gives for the local workspace, so nothing below has to
 * distinguish "not loaded yet" from "local".
 */
const Servers = createSimpleContext({
  name: "Servers",
  init: () => {
    const [servers, setServers] = createSignal<ServerSummary[]>([]);
    const [hostStatus, setHostStatus] = createSignal<HostStatus>(FALLBACK_HOST_STATUS);
    const [joinServerOpen, setJoinServerOpen] = createSignal(false);
    const [serverLoadRequest, setServerLoadRequest] = createSignal<{ serverId: string; nonce: number } | null>(null);
    let loadRequestNonce = 0;
    let pendingCompatibilityRetryServerId: string | null = null;
    let serverSelectionGeneration = 0;

    /**
     * A token for "no other server selection has started since this point".
     *
     * The counter lives here because two unrelated callers need the same
     * answer: whoever runs the switch, and `closeBrowserTab`, which must not
     * apply a close that raced a switch. Neither can read the other's local, and
     * `activeServerId()` alone is not enough - it only changes once
     * `servers.select()` resolves, so it says "unchanged" for the whole window
     * in which a switch is already under way.
     *
     * `beginServerSelection` claims the next generation and invalidates every
     * predicate handed out before it; `currentServerSelection` only observes.
     * Both return the predicate rather than the number so no caller can compare
     * generations across owners - a comparison that stops meaning anything once
     * the counter lives inside a keyed scope.
     */
    function beginServerSelection(): () => boolean {
      const generation = ++serverSelectionGeneration;
      return () => generation === serverSelectionGeneration;
    }

    function currentServerSelection(): () => boolean {
      const generation = serverSelectionGeneration;
      return () => generation === serverSelectionGeneration;
    }

    const activeServer = createMemo(() => servers().find((server) => server.active));
    const activeServerId: () => string = createMemo((): string => activeServer()?.id ?? "local");

    function activeServerSupportsCapability(capability: TeamCurrentCapability): boolean {
      return serverSupportsCapability(activeServer(), capability);
    }

    function applyServerSummaries(value: ServerSummary[]): void {
      const previous = new Map(servers().map((server) => [server.id, server]));
      for (const server of value) {
        const sequence = server.connectionSequence ?? 0;
        const previousSequence = previous.get(server.id)?.connectionSequence ?? 0;
        const compatibility = server.compatibility;
        if (
          server.kind === "remote" &&
          sequence > previousSequence &&
          compatibility?.hostAppVersion &&
          compatibility.hostAppVersion !== compatibility.localAppVersion
        ) {
          toast.warning(`Different OpenBot versions on ${server.name}`, {
            description: `The connection uses protocol ${compatibility.negotiatedProtocol}. Some newer features may be unavailable. Client ${compatibility.localAppVersion}; host ${compatibility.hostAppVersion}.`,
          });
        }
      }
      setServers(value);
      const retryTarget = value.find(
        (server) => server.id === pendingCompatibilityRetryServerId && server.active && server.state === "online",
      );
      const negotiatedTarget = value.find((server) => {
        const oldCompatibility = previous.get(server.id)?.compatibility;
        return (
          server.kind === "remote" &&
          server.active &&
          server.state === "online" &&
          oldCompatibility?.hostAppVersion === null &&
          Boolean(server.compatibility?.hostAppVersion)
        );
      });
      const loadTarget = retryTarget ?? negotiatedTarget;
      if (loadTarget) {
        pendingCompatibilityRetryServerId = null;
        loadRequestNonce += 1;
        setServerLoadRequest({ serverId: loadTarget.id, nonce: loadRequestNonce });
      }
    }

    let markServersLoaded: () => void = () => undefined;
    const initialServersReady = new Promise<void>((resolve) => {
      markServersLoaded = resolve;
    });

    onSettled(() => {
      const unsubscribeServers = window.openbot.servers.onEvent((value) => flush(() => applyServerSummaries(value)));
      const unsubscribeHost = window.openbot.host.onEvent((status) => flush(() => setHostStatus(status)));
      // One `then` rather than a `then`/`catch`/`finally` chain: every extra link
      // is another microtask between the summaries arriving and the per-server
      // bootstrap that waits on this promise, and that gap is long enough for the
      // view to paint a first pass from stale state.
      void window.openbot.servers.list().then(
        (value) => {
          applyServerSummaries(value);
          markServersLoaded();
        },
        () => markServersLoaded(),
      );
      void window.openbot.host
        .getStatus()
        .then(setHostStatus)
        .catch(() => undefined);
      return () => {
        unsubscribeServers();
        unsubscribeHost();
      };
    });

    async function retryServerConnection(serverId: string): Promise<void> {
      pendingCompatibilityRetryServerId = serverId;
      try {
        await window.openbot.servers.retryConnection(serverId);
      } catch (error) {
        pendingCompatibilityRetryServerId = null;
        toast.error("The host is still incompatible", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    }

    async function reorderServers(serverIds: string[]): Promise<void> {
      const previous = servers();
      const serversById = new Map(previous.map((server) => [server.id, server]));
      setServers([
        ...previous.filter((server) => server.kind === "local"),
        ...serverIds.flatMap((serverId) => {
          const server = serversById.get(serverId);
          return server?.kind === "remote" ? [server] : [];
        }),
      ]);
      try {
        setServers(await window.openbot.servers.reorder({ serverIds }));
      } catch (error) {
        setServers(previous);
        throw error;
      }
    }

    return {
      servers,
      setServers,
      activeServer,
      activeServerId,
      activeServerSupportsCapability,
      hostStatus,
      setHostStatus,
      joinServerOpen,
      setJoinServerOpen,
      reorderServers,
      retryServerConnection,
      serverLoadRequest,
      initialServersReady,
      beginServerSelection,
      currentServerSelection,
    };
  },
});

export const ServersProvider = Servers.provider;
export const useServers = Servers.use;
