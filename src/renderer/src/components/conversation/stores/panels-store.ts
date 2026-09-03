import type { AttachmentSummary, BrowserBounds } from "@openbot/contracts/ipc";
import { createMemo, createSignal } from "solid-js";
import type { ConversationProps, MediaPreview, RightPanelMode, SidebarFilePreview } from "../../ConversationView";

export interface RoutineSettingsRequest {
  botId: string;
  routineId: string;
  routineName: string;
  nonce: number;
}

export interface PanelsStoreDeps {
  props: ConversationProps;
  rightPanels: () => Record<string, RightPanelMode>;
  setRightPanels: (update: (current: Record<string, RightPanelMode>) => Record<string, RightPanelMode>) => void;
  settingsProvider: () => import("@openbot/contracts/ipc").AgentProviderId;
  settingsModel: () => import("@openbot/contracts/ipc").AgentModelId;
  settingsReasoning: () => import("@openbot/contracts/ipc").AgentReasoningEffort;
  setBrowserPipBounds: (bounds: BrowserBounds | null) => void;
  mediaPreview: () => MediaPreview | null;
  setMediaPreview: (update: MediaPreview | null | ((current: MediaPreview | null) => MediaPreview | null)) => void;
  sidebarFilePreview: () => SidebarFilePreview | null;
  setSidebarFilePreview: (preview: SidebarFilePreview | null) => void;
  setComposerError: (error: string | null) => void;
  nextFilePreviewGeneration: () => number;
  currentFilePreviewGeneration: () => number;
  invalidateFilePreviewGeneration: () => void;
}

export function createPanelsStore(deps: PanelsStoreDeps) {
  const [routineSettingsRequest, setRoutineSettingsRequest] = createSignal<RoutineSettingsRequest | null>(null);
  let routineSettingsRequestNonce = 0;

  const activeRightPanel = createMemo<RightPanelMode>(() => {
    const botId = deps.props.bot?.id;
    return botId ? (deps.rightPanels()[botId] ?? "none") : "none";
  });
  const settingsOpen = () => activeRightPanel() === "settings";
  const filePreviewOpen = () =>
    activeRightPanel() === "file-preview" && deps.sidebarFilePreview()?.ownerBotId === deps.props.bot?.id;

  function setActiveRightPanel(mode: RightPanelMode, botId = deps.props.bot?.id) {
    if (!botId) return;
    if (mode !== "settings") {
      setRoutineSettingsRequest((current) => (current?.botId === botId ? null : current));
    }
    deps.setRightPanels((current) => (current[botId] === mode ? current : { ...current, [botId]: mode }));
  }

  function openRoutineSettings(routine: { routineId: string; name: string }): void {
    const botId = deps.props.bot?.id;
    if (!botId) return;
    routineSettingsRequestNonce += 1;
    setRoutineSettingsRequest({
      botId,
      routineId: routine.routineId,
      routineName: routine.name,
      nonce: routineSettingsRequestNonce,
    });
    setActiveRightPanel("settings", botId);
  }

  function handleRoutineSettingsRequest(nonce: number): void {
    setRoutineSettingsRequest((current) => (current?.nonce === nonce ? null : current));
  }

  function clearRoutineSettingsRequest(): void {
    setRoutineSettingsRequest(null);
  }

  function openRoutineRunMessage(messageId: string): void {
    setActiveRightPanel("none");
    void deps.props.onOpenSearchMessage?.(messageId);
  }

  function showBrowserPip() {
    setActiveRightPanel("browser-pip");
  }

  function saveBrowserPipBounds(bounds: BrowserBounds) {
    deps.setBrowserPipBounds(bounds);
    window.localStorage.setItem(
      "openbot:browser-pip-native-bounds",
      [bounds.x, bounds.y, bounds.width, bounds.height].join(","),
    );
  }

  function hideBrowserPanel() {
    setActiveRightPanel("none");
    if (deps.props.browserEnabled !== false) void window.openbot.browser.setVisible({ visible: false });
  }

  async function previewAttachment(attachment: AttachmentSummary) {
    if (!attachment.previewUrl || attachment.previewKind === "none") return;
    deps.setMediaPreview({
      attachment,
      text: null,
      loading: attachment.previewKind === "text",
      error: null,
    });
    if (attachment.previewKind !== "text") return;
    try {
      const response = await fetch(attachment.previewUrl);
      if (!response.ok) throw new Error("Preview is unavailable.");
      const text = await response.text();
      deps.setMediaPreview((current) =>
        current?.attachment.id === attachment.id
          ? { ...current, text: text.slice(0, 1_000_000), loading: false }
          : current,
      );
    } catch (error) {
      deps.setMediaPreview((current) =>
        current?.attachment.id === attachment.id
          ? {
              ...current,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }

  function attachmentAction(attachment: AttachmentSummary, action: "open" | "reveal" | "download") {
    void window.openbot.agent
      .openAttachment({ attachmentId: attachment.id, action })
      .catch((error) => deps.setComposerError(error instanceof Error ? error.message : String(error)));
  }

  function openSharedFile(path: string) {
    const ownerBotId = deps.props.bot?.id;
    if (!ownerBotId) return;
    const generation = deps.nextFilePreviewGeneration();
    void window.openbot.agent.previewSharedFile({ path }).then(
      (preview) => {
        if (generation !== deps.currentFilePreviewGeneration() || deps.props.bot?.id !== ownerBotId) return;
        deps.setSidebarFilePreview({ ownerBotId, source: "shared", path, preview });
        setActiveRightPanel("file-preview", ownerBotId);
      },
      (error) => deps.setComposerError(error instanceof Error ? error.message : String(error)),
    );
  }

  function openWorkspaceFile(path: string) {
    const botId = deps.props.bot?.id;
    if (!botId) return;
    const generation = deps.nextFilePreviewGeneration();
    void window.openbot.agent.previewWorkspaceFile({ botId, path }).then(
      (preview) => {
        if (generation !== deps.currentFilePreviewGeneration() || deps.props.bot?.id !== botId) return;
        deps.setSidebarFilePreview({ ownerBotId: botId, source: "workspace", path, preview });
        setActiveRightPanel("file-preview", botId);
      },
      (error) => deps.setComposerError(error instanceof Error ? error.message : String(error)),
    );
  }

  function openSidebarFileExternally() {
    const file = deps.sidebarFilePreview();
    if (!file) return;
    const request =
      file.source === "shared"
        ? window.openbot.agent.openSharedFile({ path: file.path })
        : window.openbot.agent.openWorkspaceFile({ botId: file.ownerBotId, path: file.path });
    void request.catch((error) => deps.setComposerError(error instanceof Error ? error.message : String(error)));
  }

  function closeSidebarFilePreview() {
    deps.invalidateFilePreviewGeneration();
    deps.setSidebarFilePreview(null);
    setActiveRightPanel("none");
  }

  return {
    routineSettingsRequest,
    activeRightPanel,
    settingsOpen,
    filePreviewOpen,
    setActiveRightPanel,
    openRoutineSettings,
    handleRoutineSettingsRequest,
    clearRoutineSettingsRequest,
    openRoutineRunMessage,
    showBrowserPip,
    saveBrowserPipBounds,
    hideBrowserPanel,
    previewAttachment,
    attachmentAction,
    openSharedFile,
    openWorkspaceFile,
    openSidebarFileExternally,
    closeSidebarFilePreview,
  };
}

export type PanelsStore = ReturnType<typeof createPanelsStore>;
