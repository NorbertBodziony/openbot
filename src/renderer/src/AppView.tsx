import { Loading, Show } from "solid-js";
import { useAuth } from "./features/account/account-context";
import { useAgents } from "./features/agents/agents-context";
import { useSetup } from "./features/onboarding/onboarding-context";
import { useServerSelection } from "./features/servers/server-selection";
import { AccountLogin, InitialSetup, OnboardingFlow } from "./lazy-views";
import { usePlatform } from "./platform";
import { useProviders } from "./providers";
import { WorkspaceShell } from "./WorkspaceShell";

/** The one placeholder every gate below falls back to, at every depth. */
function LoadingScreen() {
  return <div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />;
}

/**
 * Which of four things the window shows: a placeholder until the build and the
 * saved setup are known, the sign-in screen, one of the two first-run flows, or
 * the workspace.
 *
 * The ladder is written as nested `<Show>` rather than pushed into the providers
 * as readiness gates. A gated provider withholds its subtree, and the only
 * subtree here is the whole application, so a gate would replace these
 * placeholders with a blank window and serialize the bootstrap loads that
 * currently run in parallel. See `app-providers.tsx`.
 *
 * `account` is threaded down as an accessor because the innermost `<Show>` is
 * what proves it non-null; the workspace and its overlays need the account, and
 * re-reading `signedInAccount()` below would hand them a nullable value the
 * gate has already ruled out.
 */
export function AppAccessGate() {
  const platform = usePlatform();
  const auth = useAuth();
  const setup = useSetup();
  const { agentStatus } = useAgents();
  const {
    providerRuntimeStatuses,
    providerRuntimeDownloadsAvailable,
    downloadProviderRuntime,
    cancelProviderRuntimeDownload,
    refreshingProviders,
    connectChatGPT,
    connectClaude,
    connectGrok,
    openProviderInstallGuide,
    openProviderSignInGuide,
    refreshAgentProviders,
  } = useProviders();
  const { joinRemoteDuringSetup } = useServerSelection();

  return (
    <Show when={setup.setupLoaded() && platform.appInfo() !== null} fallback={<LoadingScreen />}>
      <Show
        when={auth.visibleSignedInAccount()}
        fallback={
          <Loading fallback={<LoadingScreen />}>
            <AccountLogin
              variant={platform.appInfo()?.variant ?? "production"}
              state={auth.centralAuth()}
              onRetry={auth.retryCentralAccount}
              onRequestEmailCode={auth.requestEmailCode}
              onVerifyEmailCode={auth.verifyEmailCode}
              onReset={auth.logoutCentralAccount}
            />
          </Loading>
        }
      >
        {(account) => (
          <Show
            when={setup.setupState()?.completed}
            fallback={
              <Show
                when={setup.pendingInviteUrl().trim()}
                fallback={
                  <Loading fallback={<LoadingScreen />}>
                    <OnboardingFlow
                      state={setup.setupState() ?? { completed: false, preferredProvider: null }}
                      agentStatus={agentStatus()}
                      platform={platform.appInfo()?.platform ?? "darwin"}
                      refreshingProviders={
                        refreshingProviders() ||
                        agentStatus().phase === "starting" ||
                        agentStatus().phase === "restarting"
                      }
                      providerRuntimeStatuses={
                        providerRuntimeDownloadsAvailable() ? providerRuntimeStatuses() : undefined
                      }
                      onDownloadProvider={providerRuntimeDownloadsAvailable() ? downloadProviderRuntime : undefined}
                      onCancelProviderDownload={
                        providerRuntimeDownloadsAvailable() ? cancelProviderRuntimeDownload : undefined
                      }
                      onConnectProvider={(provider) =>
                        provider === "codex"
                          ? connectChatGPT()
                          : provider === "claude"
                            ? connectClaude()
                            : connectGrok()
                      }
                      onInstallProvider={providerRuntimeDownloadsAvailable() ? undefined : openProviderInstallGuide}
                      onSignInProvider={providerRuntimeDownloadsAvailable() ? undefined : openProviderSignInGuide}
                      onRefreshProviders={providerRuntimeDownloadsAvailable() ? undefined : refreshAgentProviders}
                      onSave={setup.saveSetup}
                    />
                  </Loading>
                }
              >
                <Loading fallback={<LoadingScreen />}>
                  <InitialSetup
                    state={setup.setupState() ?? { completed: false, preferredProvider: null }}
                    agentStatus={agentStatus()}
                    platform={platform.appInfo()?.platform ?? "darwin"}
                    accountEmail={account().email}
                    inviteUrl={setup.pendingInviteUrl()}
                    onSave={setup.saveSetup}
                    onPreviewInvite={setup.previewInvite}
                    onJoinRemote={joinRemoteDuringSetup}
                    onLogout={auth.logoutCentralAccount}
                  />
                </Loading>
              </Show>
            }
          >
            <WorkspaceShell account={account} />
          </Show>
        )}
      </Show>
    </Show>
  );
}
