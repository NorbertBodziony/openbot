import { useConversationViewScope } from "./conversation-scope";

const SETTINGS_PANEL_MIN = 180;
const SETTINGS_PANEL_MAX = 1600;
const BROWSER_PANEL_DEFAULT_RATIO = 0.5;
const BROWSER_PANEL_MIN = 220;
const BROWSER_PANEL_MAX = 1600;
const CONVERSATION_PANEL_MIN = 96;
const loadAgentSettingsPanel = () => import("./AgentSettingsPanel");

import { Loading, lazy, Show } from "solid-js";

/** @internal Stable HMR boundary for conversation panels. */
export function ConversationPanels() {
  const {
    activateBrowserTab,
    activeBrowserControl,
    activeBrowserTab,
    agentActivity,
    browserAddress,
    browserControlForTab,
    browserControllerForTab,
    browserSidebarOpen,
    browserTabs,
    closeSidebarFilePreview,
    closeBrowserTab,
    conversationPanelElement,
    filePreviewOpen,
    openBrowserAddress,
    openExternalMessageUrl,
    openRoutineRunMessage,
    openSharedFile,
    openSidebarFileExternally,
    openWorkspaceFile,
    navigateBrowserTab,
    props,
    reloadBrowserTab,
    setActiveRightPanel,
    setBrowserAddress,
    setBrowserAddressEditing,
    setBrowserPanelWidth,
    setBrowserSurfaceElement,
    setSettingsPanelWidth,
    showBrowserPip,
    handleRoutineSettingsRequest,
    sidebarFilePreview,
    settingsOpen,
    routineSettingsRequest,
    settingsModel,
    settingsProvider,
    settingsReasoning,
    updateRuntimeSettings,
  } = useConversationViewScope();
  return (
    <>
      <Show when={filePreviewOpen() && sidebarFilePreview()}>
        {(file) => (
          <Loading>
            <FilePreviewPanel
              preview={file().preview}
              agents={props.agents}
              defaultWidth={() =>
                (conversationPanelElement()?.clientWidth || window.innerWidth) * BROWSER_PANEL_DEFAULT_RATIO
              }
              maxWidth={() =>
                Math.min(
                  BROWSER_PANEL_MAX,
                  Math.max(
                    BROWSER_PANEL_MIN,
                    (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
                  ),
                )
              }
              onWidthChange={setBrowserPanelWidth}
              onOpenLink={(url) => void openExternalMessageUrl(url)}
              onOpenSharedFile={openSharedFile}
              onOpenWorkspaceFile={openWorkspaceFile}
              onOpenExternally={openSidebarFileExternally}
              onClose={closeSidebarFilePreview}
            />
          </Loading>
        )}
      </Show>

      <Show when={browserSidebarOpen()}>
        <BrowserPanel
          tabs={browserTabs()}
          activeTab={activeBrowserTab()}
          activeControl={activeBrowserControl()}
          address={browserAddress()}
          defaultWidth={() =>
            (conversationPanelElement()?.clientWidth || window.innerWidth) * BROWSER_PANEL_DEFAULT_RATIO
          }
          maxWidth={() =>
            Math.min(
              BROWSER_PANEL_MAX,
              Math.max(
                BROWSER_PANEL_MIN,
                (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
              ),
            )
          }
          controlForTab={browserControlForTab}
          controllerForTab={browserControllerForTab}
          onAddressChange={setBrowserAddress}
          onAddressEditingChange={setBrowserAddressEditing}
          onOpenAddress={(address) => void openBrowserAddress(address)}
          onNavigate={(tabId, direction) => void navigateBrowserTab(tabId, direction)}
          onReload={(tabId) => void reloadBrowserTab(tabId)}
          onActivateTab={activateBrowserTab}
          onCloseTab={(tabId) => void closeBrowserTab(tabId)}
          onSurface={setBrowserSurfaceElement}
          onWidthChange={setBrowserPanelWidth}
          onEnterPip={showBrowserPip}
        />
      </Show>

      <Show when={settingsOpen() && props.agent}>
        {(agent) => (
          <Loading>
            <AgentSettingsPanel
              agent={agent()}
              runtimeSettings={{
                provider: settingsProvider(),
                model: settingsModel(),
                reasoningEffort: settingsReasoning(),
              }}
              agentStatus={props.agentStatus}
              providerRuntimeStatuses={props.providerRuntimeStatuses}
              onDownloadProvider={props.onDownloadProvider}
              onCancelProviderDownload={props.onCancelProviderDownload}
              onConnectProvider={props.onConnectProvider}
              modelOptions={props.modelOptions}
              working={agentActivity() === "Working"}
              maxWidth={() =>
                Math.min(
                  SETTINGS_PANEL_MAX,
                  Math.max(
                    SETTINGS_PANEL_MIN,
                    (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
                  ),
                )
              }
              onClose={() => setActiveRightPanel("none")}
              onWidthChange={setSettingsPanelWidth}
              onUpdateAgent={props.onUpdateAgent}
              onUpdateRuntimeSettings={updateRuntimeSettings}
              onSetAgentAvatar={props.onSetAgentAvatar}
              routineSelectionRequest={
                routineSettingsRequest()?.agentId === agent().id ? routineSettingsRequest() : null
              }
              onRoutineSelectionRequestHandled={handleRoutineSettingsRequest}
              onOpenRoutineRun={props.onOpenSearchMessage ? openRoutineRunMessage : undefined}
            />
          </Loading>
        )}
      </Show>
    </>
  );
}

const AgentSettingsPanel = lazy(loadAgentSettingsPanel);
const BrowserPanel = lazy(() => import("./BrowserPanel"));
const FilePreviewPanel = lazy(() => import("./FilePreviewPanel"));
