import { useConversationViewScope } from "./conversation-scope";

const loadAgentSettingsPanel = () => import("./AgentSettingsPanel");

import { Show } from "solid-js";
import { AgentAvatar } from "../../components/AgentAvatar";
import { ProviderModelPicker } from "../../components/ProviderModelPicker";
import { Button } from "../../components/ui";
import { ComputerIcon, RemoteDesktopIcon } from "./ConversationIcons";

/** @internal Stable HMR boundary for conversation header. */
export function ConversationHeader() {
  const {
    actingBrowserControl,
    agentActivity,
    browserControlAgent,
    hideBrowserPanel,
    props,
    screenOpen,
    selectAndConfirmModel,
    selectAndConfirmReasoning,
    setActiveRightPanel,
    settingsModel,
    settingsProvider,
    settingsReasoning,
    showBrowserPanel,
  } = useConversationViewScope();
  return (
    <header class="window-drag conversation-header">
      <div class="conversation-heading-group">
        <Show when={props.agent}>
          {(agent) => (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              class="conversation-title no-drag"
              aria-label="View agent settings"
              onPointerEnter={() => void loadAgentSettingsPanel()}
              onFocus={() => void loadAgentSettingsPanel()}
              onClick={() => setActiveRightPanel("settings")}
            >
              <AgentAvatar agent={agent()} />
              <h1>{agent().name}</h1>
            </Button>
          )}
        </Show>
      </div>
      <div class="conversation-header-actions no-drag">
        <Show when={props.agent}>
          <ProviderModelPicker
            provider={settingsProvider()}
            value={settingsModel()}
            reasoningEffort={settingsReasoning()}
            modelOptions={props.modelOptions}
            agentStatus={props.agentStatus}
            runtimeStatuses={props.providerRuntimeStatuses}
            onDownloadProvider={props.onDownloadProvider}
            onCancelProviderDownload={props.onCancelProviderDownload}
            onConnectProvider={props.onConnectProvider}
            disabled={agentActivity() === "Working"}
            disabledReason={
              agentActivity() === "Working"
                ? "Wait for the current work to finish before changing models."
                : "Models are available after an agent CLI connects."
            }
            onChange={(model, provider) => void selectAndConfirmModel(model, provider)}
            onReasoningEffortChange={(effort) => void selectAndConfirmReasoning(effort)}
          />
        </Show>
        <Show when={props.remoteDesktopEnabled !== false && props.server?.kind === "remote" ? props.server : undefined}>
          {(server) => {
            const enabled = () =>
              props.remoteDesktopSessionActive || (server().state === "online" && server().remoteDesktopAvailable);
            const label = () => (props.remoteDesktopSessionActive ? "Resume remote control" : "Open remote control");
            return (
              <Button
                variant="ghost"
                type="button"
                class="header-panel-toggle remote-desktop-button"
                aria-label={label()}
                aria-expanded={props.remoteDesktopVisible ? "true" : "false"}
                disabled={!enabled()}
                onClick={(event) => void props.onOpenRemoteDesktop(server().id, event.currentTarget)}
              >
                <RemoteDesktopIcon />
                <Show when={props.remoteDesktopSessionActive}>
                  <span class="remote-desktop-button-dot" aria-hidden="true" />
                </Show>
              </Button>
            );
          }}
        </Show>
        <Show when={props.browserEnabled !== false}>
          <Button
            variant="ghost"
            type="button"
            class={[
              "header-panel-toggle computer-button",
              { "computer-button-agent-active": Boolean(actingBrowserControl()) },
            ]}
            aria-label={
              actingBrowserControl()
                ? `${browserControlAgent()?.name ?? "Agent"} is controlling the browser`
                : screenOpen()
                  ? "Hide computer"
                  : "Open computer"
            }
            aria-expanded={screenOpen() ? "true" : "false"}
            disabled={props.browserVisibilitySuspended}
            onClick={() => {
              if (screenOpen()) hideBrowserPanel();
              else showBrowserPanel();
            }}
          >
            <ComputerIcon />
            <Show when={actingBrowserControl()}>
              <span class="computer-control-dot" aria-hidden="true" />
            </Show>
          </Button>
        </Show>
      </div>
    </header>
  );
}
