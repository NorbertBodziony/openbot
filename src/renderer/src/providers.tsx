import type { AgentProviderId, AgentStatus, ProviderRuntimeSnapshot } from "@openbot/contracts/ipc";
import { createSignal, flush, onSettled } from "solid-js";
import { useAgents } from "./agents";
import { desktopAnalytics } from "./analytics";
import { FALLBACK_PROVIDER_RUNTIMES } from "./app-defaults";
import { createSimpleContext } from "./simple-context";

/**
 * The three coding providers behind an agent - Codex, Claude and Grok - as two
 * separate things the renderer has to reconcile.
 *
 * `providerRuntimes` is the newer, managed path: main downloads a runtime and
 * pushes a revisioned snapshot. `connect*`/`refreshAgentProviders` is the older
 * path, where the provider is already installed and only its sign-in state
 * matters; it reports through `AgentStatus`. Which one a build has is decided by
 * `window.openbot.providerRuntimes` being present at all, which is why every
 * consumer picks its handlers through `providerRuntimeDownloadsAvailable()`.
 *
 * Ungated - `FALLBACK_PROVIDER_RUNTIMES` is a usable snapshot, and the agent
 * status this reads through `useAgents()` has its own fallback.
 *
 * Nested under `agents` because both paths end in an `AgentStatus`:
 * `applyAgentStatus` lives here rather than there because the only thing it does
 * beyond storing the status is close out the connect attempts this domain
 * started. Depending outward on `agents` keeps that edge one-way.
 */
const Providers = createSimpleContext({
  name: "Providers",
  init: () => {
    const { agentStatus, setAgentStatus } = useAgents();
    const [refreshingProviders, setRefreshingProviders] = createSignal(false);
    const [providerRuntimeSnapshot, setProviderRuntimeSnapshot] =
      createSignal<ProviderRuntimeSnapshot>(FALLBACK_PROVIDER_RUNTIMES);
    /** Connect attempts still waiting for the status that says how they ended. */
    const pendingProviderConnections = new Map<AgentProviderId, ReturnType<typeof desktopAnalytics.scope>>();

    /**
     * The status is the completion signal for every connect started here: main
     * answers `connect()` before the provider has finished coming up, so the
     * outcome arrives later, in a status this or an agent event applies.
     */
    function applyAgentStatus(status: AgentStatus): void {
      for (const provider of status.providers ?? []) {
        const analytics = pendingProviderConnections.get(provider.id);
        if (!analytics) continue;
        if (provider.state === "available") {
          pendingProviderConnections.delete(provider.id);
          analytics.track("provider_action", {
            provider: provider.id,
            action: "connect_completed",
            result: "succeeded",
          });
        } else if (provider.state === "error") {
          pendingProviderConnections.delete(provider.id);
          analytics.track("provider_action", {
            provider: provider.id,
            action: "connect_completed",
            result: "failed",
            failure_code: "connect_failed",
          });
        }
      }
      setAgentStatus(status);
    }

    function openProviderInstallGuide(provider: AgentProviderId): Promise<void> {
      if (provider !== "claude")
        return Promise.reject(new Error(`${provider === "codex" ? "ChatGPT" : "Grok"} is included with OpenBot.`));
      return window.openbot.openExternal("claude-install");
    }

    function openProviderSignInGuide(provider: AgentProviderId): Promise<void> {
      if (provider === "codex") return connectChatGPT();
      if (provider === "claude") return window.openbot.openExternal("claude-sign-in");
      return connectGrok();
    }

    /** Revisioned, because the pushed event and the awaited call can land out of order. */
    function applyProviderRuntimeSnapshot(snapshot: ProviderRuntimeSnapshot): void {
      setProviderRuntimeSnapshot((current) => {
        if (snapshot.revision < current.revision) return current;
        for (const provider of ["codex", "claude", "grok"] as const) {
          const previousPhase = current.providers[provider].phase;
          const nextPhase = snapshot.providers[provider].phase;
          if (previousPhase !== "downloading" && previousPhase !== "finishing") continue;
          if (nextPhase === "ready") {
            desktopAnalytics.scope().track("provider_action", {
              provider,
              action: "download_completed",
              result: "succeeded",
            });
          } else if (nextPhase === "download-error") {
            desktopAnalytics.scope().track("provider_action", {
              provider,
              action: "download_completed",
              result: "failed",
              failure_code: "runtime_download_failed",
            });
          }
        }
        return snapshot;
      });
    }

    async function downloadProviderRuntime(provider: AgentProviderId): Promise<void> {
      if (!window.openbot.providerRuntimes) throw new Error("Provider downloads are unavailable.");
      const analytics = desktopAnalytics.scope();
      analytics.track("provider_action", { provider, action: "download_started", result: "succeeded" });
      try {
        applyProviderRuntimeSnapshot(await window.openbot.providerRuntimes.download(provider));
      } catch (error) {
        analytics.track("provider_action", {
          provider,
          action: "download_completed",
          result: "failed",
          failure_code: "download_failed",
        });
        throw error;
      }
    }

    async function cancelProviderRuntimeDownload(provider: AgentProviderId): Promise<void> {
      if (!window.openbot.providerRuntimes) throw new Error("Provider downloads are unavailable.");
      applyProviderRuntimeSnapshot(await window.openbot.providerRuntimes.cancel(provider));
      desktopAnalytics.scope().track("provider_action", {
        provider,
        action: "download_cancelled",
        result: "succeeded",
      });
    }

    async function connectChatGPT(): Promise<void> {
      return connectProvider("codex", window.openbot.connectChatGPT);
    }

    async function connectClaude(): Promise<void> {
      return connectProvider("claude", window.openbot.connectClaude);
    }

    async function connectGrok(): Promise<void> {
      return connectProvider("grok", window.openbot.connectGrok);
    }

    async function connectProvider(provider: AgentProviderId, connect: () => Promise<AgentStatus>): Promise<void> {
      if (refreshingProviders()) return;
      const analytics = desktopAnalytics.scope();
      pendingProviderConnections.set(provider, analytics);
      analytics.track("provider_action", { provider, action: "connect_started", result: "succeeded" });
      try {
        const status = await connect();
        flush(() => applyAgentStatus(status));
      } catch (error) {
        pendingProviderConnections.delete(provider);
        analytics.track("provider_action", {
          provider,
          action: "connect_completed",
          result: "failed",
          failure_code: "connect_failed",
        });
        throw error;
      }
    }

    async function refreshAgentProviders(): Promise<void> {
      if (refreshingProviders() || agentStatus().phase === "starting" || agentStatus().phase === "restarting") {
        return;
      }
      const analytics = desktopAnalytics.scope();
      setRefreshingProviders(true);
      try {
        const status = await window.openbot.refreshAgentProviders();
        flush(() => applyAgentStatus(status));
        analytics.track("provider_action", { action: "refresh", result: "succeeded" });
      } catch (error) {
        analytics.track("provider_action", {
          action: "refresh",
          result: "failed",
          failure_code: "refresh_failed",
        });
        throw error;
      } finally {
        flush(() => setRefreshingProviders(false));
      }
    }

    onSettled(() => {
      const unsubscribe =
        window.openbot.providerRuntimes?.onEvent((snapshot) => {
          flush(() => applyProviderRuntimeSnapshot(snapshot));
        }) ?? (() => undefined);
      void window.openbot.providerRuntimes
        ?.getStatus()
        .then(applyProviderRuntimeSnapshot)
        .catch(() => undefined);
      return () => {
        unsubscribe();
        pendingProviderConnections.clear();
      };
    });

    return {
      providerRuntimeStatuses: () => providerRuntimeSnapshot().providers,
      providerRuntimeDownloadsAvailable: () => Boolean(window.openbot.providerRuntimes),
      refreshingProviders,
      applyAgentStatus,
      applyProviderRuntimeSnapshot,
      connectChatGPT,
      connectClaude,
      connectGrok,
      downloadProviderRuntime,
      cancelProviderRuntimeDownload,
      openProviderInstallGuide,
      openProviderSignInGuide,
      refreshAgentProviders,
    };
  },
});

export const ProvidersProvider = Providers.provider;
export const useProviders = Providers.use;
