import type { UpdateBotInput } from "@openbot/contracts/ipc";
import { createContext, createEffect, onCleanup, onSettled, untrack, useContext } from "solid-js";
import { agentConversationKey, composerDraftKey } from "../../conversation-keys";
import { createScopeGuard } from "../../scope-lifetime";
import type { ComposerDraft, ConversationProps } from "../ConversationView";
import { useConversationController } from "../conversation-controller-context";
import { clearChatSearchHighlights, findChatSearchMatches, renderChatSearchHighlights } from "./chat-search";
import { createActivityStore } from "./stores/activity-store";
import { createBrowserStore } from "./stores/browser-store";
import { createComposerActions } from "./stores/composer-actions";
import { createComposerStore } from "./stores/composer-store";
import { createMessageActions } from "./stores/message-actions";
import { createPanelsStore } from "./stores/panels-store";
import { createQueueStore } from "./stores/queue-store";
import { createScrollStore } from "./stores/scroll-store";
import { createSearchStore } from "./stores/search-store";
import { createSettingsStore, runtimeSettingsEqual } from "./stores/settings-store";
import { createSkillsStore } from "./stores/skills-store";
import { createVoiceStore } from "./stores/voice-store";

function followConversationBottom(element: HTMLDivElement): void {
  element.scrollTop = element.scrollHeight;
}

export function createConversationViewScope(props: ConversationProps) {
  const controller = useConversationController();
  const agentReady = () => props.agentStatus.phase === "ready";
  const {
    drafts,
    setDrafts,
    editingBotId,
    setEditingBotId,
    editingServerId,
    setEditingServerId,
    editingDeliveryId,
    setEditingDeliveryId,
    editingDraftBackup,
    setEditingDraftBackup,
    editingOriginalAttachmentIds,
    setEditingOriginalAttachmentIds,
    composerFocusRequest,
    setComposerFocusRequest,
    showComposerActions,
    setShowComposerActions,
    attachmentBusy,
    setAttachmentBusy,
    composerError,
    setComposerError,
    conversationErrors,
    setConversationErrors,
    voicePhase,
    setVoicePhase,
    voiceModelProgress,
    setVoiceModelProgress,
    voiceElapsedSeconds,
    setVoiceElapsedSeconds,
    markingRead,
    setMarkingRead,
    submitting,
    setSubmitting,
    selectionSending,
    setSelectionSending,
    dropActive,
    setDropActive,
    rightPanels,
    setRightPanels,
    settingsProvider,
    setSettingsProvider,
    settingsModel,
    setSettingsModel,
    settingsReasoning,
    setSettingsReasoning,
    browserAddress,
    setBrowserAddress,
    browserAddressEditing,
    setBrowserAddressEditing,
    browserPipBounds,
    setBrowserPipBounds,
    mediaPreview,
    setMediaPreview,
    sidebarFilePreview,
    setSidebarFilePreview,
    openReactionMessageId,
    setOpenReactionMessageId,
    openMoreMessageId,
    setOpenMoreMessageId,
    expandedEmojiMessageId,
    setExpandedEmojiMessageId,
    expandedThinkingMessages,
    setExpandedThinkingMessages,
    copiedMessageId,
    setCopiedMessageId,
    chatSearchOpen,
    setChatSearchOpen,
    chatSearchQuery,
    setChatSearchQuery,
    chatSearchMatches,
    setChatSearchMatches,
    activeChatSearchIndex,
    setActiveChatSearchIndex,
    chatSearchMessageIds,
    setChatSearchMessageIds,
    chatSearchTotal,
    setChatSearchTotal,
    settingsPanelWidth,
    setSettingsPanelWidth,
    browserPanelWidth,
    setBrowserPanelWidth,
    resources,
  } = controller;
  const panels = createPanelsStore({
    props,
    rightPanels,
    setRightPanels,
    settingsProvider,
    settingsModel,
    settingsReasoning,
    setBrowserPipBounds,
    mediaPreview,
    setMediaPreview,
    sidebarFilePreview,
    setSidebarFilePreview,
    setComposerError,
    nextFilePreviewGeneration: () => {
      resources.filePreviewRequestGeneration += 1;
      return resources.filePreviewRequestGeneration;
    },
    currentFilePreviewGeneration: () => resources.filePreviewRequestGeneration,
    invalidateFilePreviewGeneration: () => {
      resources.filePreviewRequestGeneration += 1;
    },
  });
  const {
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
  } = panels;
  const skills = createSkillsStore({ props });
  const { installedSkills } = skills;
  const composer = createComposerStore({
    props,
    drafts,
    setDrafts,
    conversationErrors,
    setConversationErrors,
    editingBotId,
    editingServerId,
    editingDeliveryId,
    seenMessageIds: resources.seenMessageIds,
  });
  const {
    currentTarget,
    currentEditingDeliveryId,
    currentDraft,
    currentConversationError,
    unreferencedDraftAttachments,
    composerHasContent,
    replyTarget,
    markMessageSeen,
    updateCurrentDraft,
    clearSubmittedDraft,
    clearConversationError,
    setConversationError,
  } = composer;
  const queue = createQueueStore({ props });
  const {
    activeDeliveries,
    orderedQueuedDeliveries,
    presentedQueueDeliveries,
    renderedQueueDeliveries,
    setRenderedQueueDeliveries,
    queuePanelVisible,
    getQueueExitTimer,
  } = queue;
  const activity = createActivityStore({
    props,
    activeDeliveries,
    agentActivityPresentations: resources.agentActivityPresentations,
  });
  const {
    renderedAgentActivity,
    setRenderedAgentActivity,
    agentActivitySpaceReserved,
    setAgentActivitySpaceReserved,
    streamingAgentMessage,
    activeActivityId,
    agentActivity,
    activityPresentation,
    clearAgentActivityShowTimer,
    clearAgentActivityExitTimer,
    clearAgentActivityExitDelayTimer,
    getAgentActivityShowTimer,
    getAgentActivityExitTimer,
    getAgentActivityExitDelayTimer,
  } = activity;
  const queueExitTimer = getQueueExitTimer();
  const agentActivityShowTimer = getAgentActivityShowTimer();
  const agentActivityExitTimer = getAgentActivityExitTimer();
  const agentActivityExitDelayTimer = getAgentActivityExitDelayTimer();
  const browser = createBrowserStore({
    props,
    browserOpenRequests: resources.browserOpenRequests,
    browserAddress,
    setBrowserAddress,
    setBrowserAddressEditing,
    setComposerError,
    panels: { setActiveRightPanel, hideBrowserPanel, screenOpen: () => screenOpen() },
  });
  const {
    browserInteractionAvailable,
    browserTabs,
    activeBrowserTab,
    browserTakeoverTab,
    browserTakeoverPreview,
    browserTakeoverResolution,
    respondToBrowserTakeover,
    activeBrowserControl,
    actingBrowserControl,
    browserControlBot,
    browserControlForTab,
    browserControllerForTab,
    openBrowserAddress,
    closeBrowserTab,
    activateBrowserTab,
    reloadBrowserTab,
    navigateBrowserTab,
    getPreviousBrowserTabCount,
  } = browser;
  const previousBrowserTabCount = getPreviousBrowserTabCount();
  const browserSidebarOpen = () => browserInteractionAvailable() && activeRightPanel() === "browser";
  const browserPipOpen = () => browserInteractionAvailable() && activeRightPanel() === "browser-pip";
  const screenOpen = () => browserSidebarOpen() || browserPipOpen();
  function showBrowserPanel() {
    setActiveRightPanel("browser");
    if (browserTabs().length === 0) void openBrowserAddress();
  }
  const viewIsMounted = createScopeGuard();
  let imageAttachmentPicker: HTMLInputElement | undefined;
  let contextAttachmentPicker: HTMLInputElement | undefined;
  const scroll = createScrollStore({
    props,
    markingRead,
    setMarkingRead,
    setComposerError,
    elements: {
      scrollElement: () => scrollElement,
      virtualRoot: () => virtualRoot,
      unreadMessagesDivider: () => unreadMessagesDivider,
    },
    sticky: {
      getStickToLatest: () => stickToLatest,
      setStickToLatest: (value: boolean) => {
        stickToLatest = value;
      },
      getCurrentUnreadCount: () => currentUnreadCount,
    },
  });
  const {
    scrollFades,
    showScrollToLatest,
    setShowScrollToLatest,
    unreadDividerVisible,
    setUnreadDividerVisible,
    messageVirtualizer,
    updateScrollFade,
    updateVirtualScrollMargin,
    updateUnreadDividerVisibility,
    scheduleUnreadDividerVisibilityUpdate,
    markUnreadMessages,
    jumpToUnreadMessages,
    jumpToLatestMessage,
  } = scroll;
  const search = createSearchStore({
    props,
    chatSearchOpen,
    setChatSearchOpen,
    setChatSearchQuery,
    chatSearchMatches,
    setChatSearchMatches,
    chatSearchMessageIds,
    setChatSearchMessageIds,
    setChatSearchTotal,
    setActiveChatSearchIndex,
  });
  const {
    openChatSearch,
    closeChatSearch,
    moveChatSearch,
    handleChatSearchShortcut,
    setChatSearchInputElement,
    getChatSearchInput,
    getChatSearchReturnFocus,
  } = search;
  const chatSearchInput = getChatSearchInput();
  const chatSearchReturnFocus = getChatSearchReturnFocus();
  const voice = createVoiceStore({
    props,
    resources,
    voicePhase,
    setVoicePhase,
    setVoiceModelProgress,
    voiceElapsedSeconds,
    setVoiceElapsedSeconds,
    drafts,
    setDrafts,
    setConversationErrors,
    setComposerError,
    setComposerFocusRequest,
    clearConversationError,
    setConversationError,
    viewIsMounted,
    hooks: {
      saveEdit: (...args) => actions.saveQueuedMessageEdit(...args),
      submit: (...args) => actions.submitMessage(...args),
      restoreTranscript: (...args) => composer.restoreVoiceTranscript(...args),
    },
  });
  const {
    startVoiceRecording,
    stopVoiceRecording,
    finishVoiceRecording,
    stopVoiceStream,
    startVoiceElapsedTimer,
    stopVoiceElapsedTimer,
  } = voice;
  const actions = createComposerActions({
    props,
    agentReady,
    drafts,
    setDrafts,
    editingBotId,
    setEditingBotId,
    editingServerId,
    setEditingServerId,
    editingDeliveryId,
    setEditingDeliveryId,
    editingDraftBackup,
    setEditingDraftBackup,
    editingOriginalAttachmentIds,
    setEditingOriginalAttachmentIds,
    submitting,
    setSubmitting,
    selectionSending,
    setSelectionSending,
    voicePhase,
    setComposerError,
    setComposerFocusRequest,
    setShowComposerActions,
    orderedQueuedDeliveries,
    presentedQueueDeliveries,
    typing: {
      get idleTimer() {
        return resources.typingIdleTimer;
      },
      set idleTimer(timer: ReturnType<typeof setTimeout> | undefined) {
        resources.typingIdleTimer = timer;
      },
      get botId() {
        return resources.typingBotId;
      },
      set botId(id: string | null) {
        resources.typingBotId = id;
      },
    },
    voice: {
      get botId() {
        return resources.voiceBotId;
      },
      get serverId() {
        return resources.voiceServerId;
      },
      get submitRequest() {
        return resources.voiceSubmitRequest;
      },
      set submitRequest(request:
        | {
            botId: string;
            serverId: string;
            draft: ComposerDraft;
            queuedEdit: { deliveryId: string; originalAttachmentIds: string[] } | undefined;
          }
        | undefined,) {
        resources.voiceSubmitRequest = request;
      },
    },
    stopComposerTyping: controller.stopComposerTyping,
    stopVoiceRecording,
    currentTarget,
    currentDraft,
    currentEditingDeliveryId,
    clearConversationError,
    clearSubmittedDraft,
    setConversationError,
    setStickToLatest: (value: boolean) => {
      stickToLatest = value;
    },
    imageAttachmentPicker: () => imageAttachmentPicker,
    contextAttachmentPicker: () => contextAttachmentPicker,
  });
  const {
    updateTeamTyping,
    stopTeamTyping,
    addAttachments,
    openAttachmentPicker,
    openAttachmentPickerFromKey,
    editQueuedMessage,
    cancelQueuedMessageEdit,
    saveQueuedMessageEdit,
    reorderPresentedQueue,
    submitComposer,
    sendSelectionInstruction,
  } = actions;
  const messageActions = createMessageActions({
    props,
    installedSkills,
    currentDraft,
    updateCurrentDraft,
    currentTarget,
    setOpenReactionMessageId,
    setOpenMoreMessageId,
    setExpandedEmojiMessageId,
    copiedMessageId,
    setCopiedMessageId,
    setComposerError,
  });
  const { replyToMessage, reactToMessage, copyMessage, removeAttachment } = messageActions;
  const settings = createSettingsStore({
    props,
    runtimeSettingsAttempts: resources.runtimeSettingsAttempts,
    runtimeSettingsSaveTails: resources.runtimeSettingsSaveTails,
    settingsProvider,
    setSettingsProvider,
    settingsModel,
    setSettingsModel,
    settingsReasoning,
    setSettingsReasoning,
    setComposerError,
    viewIsMounted,
    saveBotPatch,
  });
  const { updateRuntimeSettings, selectModel, selectAndConfirmModel, selectAndConfirmReasoning } = settings;
  onCleanup(() => {
    clearAgentActivityShowTimer();
    clearAgentActivityExitDelayTimer();
    clearAgentActivityExitTimer();
  });
  let scrollElement: HTMLDivElement | undefined;
  let virtualRoot: HTMLDivElement | undefined;
  let agentActivitySlot: HTMLDivElement | undefined;
  let scrollResizeObserver: ResizeObserver | undefined;
  let unreadMessagesDivider: HTMLDivElement | undefined;
  let latestScrollFrame: number | undefined;
  let latestScrollSettleFrame: number | undefined;
  let currentUnreadCount = 0;
  let conversationPanel: HTMLElement | undefined;
  let browserSurface: HTMLDivElement | undefined;
  let browserResizeObserver: ResizeObserver | undefined;
  let browserWindowResizeHandler: (() => void) | undefined;
  let browserVisibilityFrame: number | undefined;
  let browserBoundsFrame: number | undefined;
  let browserVisibilityGeneration = 0;
  let chatSearchFrame: number | undefined;
  let chatSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let chatSearchRequest = 0;
  let lastChatSearchQuery = "";
  let stickToLatest = true;
  let lastConversationIdentity: string | undefined;
  let lastPanelBotId: string | undefined;
  let lastHandledSettingsRequestNonce: number | undefined;
  let lastHandledMessageFocusNonce: number | undefined;
  let lastRuntimeSettingsSignature: string | undefined;
  async function saveBotPatch(updates: Omit<UpdateBotInput, "botId">, targetBotId = props.bot?.id): Promise<boolean> {
    const botId = targetBotId;
    if (!botId) return false;
    try {
      await props.onUpdateBot(botId, updates);
      return true;
    } catch {
      return false;
    }
  }

  onSettled(() => {
    const unsubscribeImport = window.openbot.agent.onAttachmentImport((event) => {
      if (event.type === "started") {
        const target = currentTarget();
        if (target?.serverId === event.serverId) {
          resources.importTargetBots.set(event.requestId, target);
          clearConversationError(target);
        }
        setAttachmentBusy(true);
        setComposerError(null);
      } else if (event.type === "error") {
        const target = resources.importTargetBots.get(event.requestId);
        resources.importTargetBots.delete(event.requestId);
        setAttachmentBusy(false);
        if (target) {
          setConversationErrors((current) => ({
            ...current,
            [composerDraftKey(target)]: event.message,
          }));
        }
      } else {
        setAttachmentBusy(false);
        const target = resources.importTargetBots.get(event.requestId);
        resources.importTargetBots.delete(event.requestId);
        if (target) {
          addAttachments(event.attachments, target);
        } else {
          for (const attachment of event.attachments) {
            void window.openbot.agent.discardDraftAttachment(attachment.id, event.serverId);
          }
        }
      }
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (chatSearchOpen()) {
        event.preventDefault();
        closeChatSearch();
        return;
      }
      if (currentEditingDeliveryId()) {
        cancelQueuedMessageEdit();
        return;
      }
      setOpenReactionMessageId(null);
      setOpenMoreMessageId(null);
      setExpandedEmojiMessageId(null);
      hideBrowserPanel();
      setMediaPreview(null);
    };
    const closeActiveRemoteBrowserTab = (event: KeyboardEvent) => {
      if (
        props.server?.kind !== "remote" ||
        !screenOpen() ||
        props.browserVisibilitySuspended ||
        event.key.toLowerCase() !== "w" ||
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const tab = activeBrowserTab();
      if (!tab) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void closeBrowserTab(tab.id);
    };
    const closeMessageMenus = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".message-actions")) return;
      setOpenReactionMessageId(null);
      setOpenMoreMessageId(null);
      setExpandedEmojiMessageId(null);
    };
    const keyboardTarget = conversationPanel?.ownerDocument ?? document;
    const keyboardWindow = keyboardTarget.defaultView ?? window;
    keyboardTarget.addEventListener("keydown", closeOnEscape);
    keyboardWindow.addEventListener("keydown", closeActiveRemoteBrowserTab);
    keyboardTarget.addEventListener("keydown", handleChatSearchShortcut);
    window.addEventListener("pointerdown", closeMessageMenus);
    scrollResizeObserver = new ResizeObserver(() => {
      updateVirtualScrollMargin();
      if (scrollElement && stickToLatest) followConversationBottom(scrollElement);
      updateScrollFade();
      updateUnreadDividerVisibility();
    });
    if (scrollElement) scrollResizeObserver.observe(scrollElement);
    if (virtualRoot) scrollResizeObserver.observe(virtualRoot);
    if (agentActivitySlot) scrollResizeObserver.observe(agentActivitySlot);
    requestAnimationFrame(() => {
      if (!scrollElement) return;
      updateVirtualScrollMargin();
      if (stickToLatest) scrollElement.scrollTop = scrollElement.scrollHeight;
      updateScrollFade(scrollElement);
      updateUnreadDividerVisibility();
    });
    return () => {
      scrollResizeObserver?.disconnect();
      scrollResizeObserver = undefined;
      unsubscribeImport();
      keyboardTarget.removeEventListener("keydown", closeOnEscape);
      keyboardWindow.removeEventListener("keydown", closeActiveRemoteBrowserTab);
      keyboardTarget.removeEventListener("keydown", handleChatSearchShortcut);
      window.removeEventListener("pointerdown", closeMessageMenus);
    };
  });

  createEffect(
    () => ({
      open: chatSearchOpen(),
      query: chatSearchQuery(),
      messageSignature: props.messages
        .map((message) => `${message.id}:${message.body}:${message.items?.join("\u0000") ?? ""}`)
        .join("\u0001"),
      remoteMessageIds: chatSearchMessageIds(),
      activeRemoteIndex: activeChatSearchIndex(),
    }),
    ({ open, query, remoteMessageIds, activeRemoteIndex }) => {
      if (chatSearchFrame !== undefined) cancelAnimationFrame(chatSearchFrame);
      if (chatSearchTimer !== undefined) clearTimeout(chatSearchTimer);
      const queryChanged = query !== lastChatSearchQuery;
      lastChatSearchQuery = query;
      if (!open || !query.trim()) {
        setChatSearchMatches([]);
        if (remoteMessageIds.length > 0) setChatSearchMessageIds([]);
        setChatSearchTotal(0);
        setActiveChatSearchIndex(-1);
        clearChatSearchHighlights();
        return;
      }
      if (props.onSearchMessages) {
        if (queryChanged) {
          const request = ++chatSearchRequest;
          chatSearchTimer = setTimeout(() => {
            void props
              .onSearchMessages?.(query)
              .then((result) => {
                if (request !== chatSearchRequest) return;
                setChatSearchMessageIds(result.messageIds);
                setChatSearchTotal(result.total);
                const index = result.messageIds.length > 0 ? 0 : -1;
                setActiveChatSearchIndex(index);
                const messageId = result.messageIds[index];
                if (messageId) void props.onOpenSearchMessage?.(messageId);
              })
              .catch(() => {
                if (request !== chatSearchRequest) return;
                setChatSearchMessageIds([]);
                setChatSearchTotal(0);
                setActiveChatSearchIndex(-1);
              });
          }, 150);
        }
        const activeMessageId = remoteMessageIds[activeRemoteIndex];
        chatSearchFrame = requestAnimationFrame(() => {
          chatSearchFrame = undefined;
          if (!scrollElement || !activeMessageId) return;
          const matches = findChatSearchMatches(scrollElement, query).filter(
            (match) => match.message.dataset.chatSearchMessage === activeMessageId,
          );
          setChatSearchMatches(matches);
        });
        return;
      }
      chatSearchFrame = requestAnimationFrame(() => {
        chatSearchFrame = undefined;
        if (!scrollElement) return;
        const matches = findChatSearchMatches(scrollElement, query);
        setChatSearchMatches(matches);
        setActiveChatSearchIndex((current) => {
          if (matches.length === 0) return -1;
          if (queryChanged || current < 0) return 0;
          return Math.min(current, matches.length - 1);
        });
      });
    },
  );

  createEffect(
    () => ({
      request: props.messageFocusRequest,
      botId: props.bot?.id,
      loaded: props.loaded,
      messageIds: props.messages.map((message) => message.id).join("\u0000"),
    }),
    ({ request, botId, loaded }) => {
      if (!request || request.botId !== botId || !loaded || request.nonce === lastHandledMessageFocusNonce) return;
      requestAnimationFrame(() => {
        const target = scrollElement?.querySelector<HTMLElement>(
          `[data-chat-search-message="${CSS.escape(request.messageId)}"]`,
        );
        if (!target) return;
        lastHandledMessageFocusNonce = request.nonce;
        stickToLatest = false;
        target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
      });
    },
  );

  createEffect(
    () => ({
      open: chatSearchOpen(),
      matches: chatSearchMatches(),
      activeIndex: activeChatSearchIndex(),
    }),
    ({ open, matches, activeIndex }) => {
      if (!open) return;
      const renderedIndex = props.onSearchMessages ? 0 : activeIndex;
      renderChatSearchHighlights(matches, renderedIndex);
      const match = matches[renderedIndex];
      if (!match) return;
      stickToLatest = false;
      match.message.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
    },
  );

  onCleanup(() => {
    if (chatSearchFrame !== undefined) cancelAnimationFrame(chatSearchFrame);
    if (chatSearchTimer !== undefined) clearTimeout(chatSearchTimer);
    clearChatSearchHighlights();
  });

  createEffect(
    () => {
      const lastMessage = props.messages[props.messages.length - 1];
      return {
        botId: props.bot?.id,
        serverId: props.server?.id ?? "local",
        activeTurnId: props.activeTurnId,
        queueSignature: props.queue?.deliveries.map((delivery) => `${delivery.id}:${delivery.status}`).join("|"),
        lastMessageBody: lastMessage?.body,
        lastMessageStatus: lastMessage?.status,
        deliverySignature: lastMessage?.exchange?.deliveries
          .map((delivery) => `${delivery.id}:${delivery.status}:${delivery.position}`)
          .join("|"),
        loaded: props.loaded,
        prompt: props.prompt,
        unreadCount: props.unreadCount,
      };
    },
    ({ botId, serverId, unreadCount }) => {
      currentUnreadCount = unreadCount;
      const conversationIdentity = `${serverId}:${botId ?? ""}`;
      if (conversationIdentity !== lastConversationIdentity) {
        if (lastConversationIdentity !== undefined) closeChatSearch(false);
        lastConversationIdentity = conversationIdentity;
        stickToLatest = true;
        setAgentActivitySpaceReserved(false);
      }
      if (latestScrollFrame !== undefined) cancelAnimationFrame(latestScrollFrame);
      if (latestScrollSettleFrame !== undefined) cancelAnimationFrame(latestScrollSettleFrame);
      const followLatest = stickToLatest;
      latestScrollFrame = requestAnimationFrame(() => {
        latestScrollFrame = undefined;
        if (!scrollElement) return;
        updateVirtualScrollMargin();
        if (followLatest) followConversationBottom(scrollElement);
        updateScrollFade(scrollElement);
        updateUnreadDividerVisibility();
        latestScrollSettleFrame = requestAnimationFrame(() => {
          latestScrollSettleFrame = undefined;
          if (!scrollElement) return;
          if (followLatest) {
            stickToLatest = true;
            followConversationBottom(scrollElement);
          }
          updateScrollFade(scrollElement);
          updateUnreadDividerVisibility();
        });
      });
    },
  );

  onCleanup(() => {
    if (latestScrollFrame !== undefined) cancelAnimationFrame(latestScrollFrame);
    if (latestScrollSettleFrame !== undefined) cancelAnimationFrame(latestScrollSettleFrame);
  });

  createEffect(
    () => {
      const bot = props.bot;
      if (!bot) return null;
      return {
        signature: [bot.id, bot.provider, bot.model, bot.reasoningEffort].join("\u0000"),
        provider: bot.provider,
        model: bot.model,
        reasoningEffort: bot.reasoningEffort,
      };
    },
    (bot) => {
      if (!bot) return;
      const pendingSettings = resources.runtimeSettingsAttempts.get(
        agentConversationKey(props.server?.id ?? "local", props.bot?.id ?? ""),
      );
      if (
        pendingSettings?.pending &&
        !runtimeSettingsEqual(pendingSettings.settings, {
          provider: bot.provider,
          model: bot.model,
          reasoningEffort: bot.reasoningEffort,
        })
      ) {
        setSettingsProvider(pendingSettings.settings.provider);
        setSettingsModel(pendingSettings.settings.model);
        setSettingsReasoning(pendingSettings.settings.reasoningEffort);
        return;
      }
      if (bot.signature === lastRuntimeSettingsSignature) return;
      lastRuntimeSettingsSignature = bot.signature;
      setSettingsProvider(bot.provider);
      setSettingsModel(bot.model);
      setSettingsReasoning(bot.reasoningEffort);
    },
  );

  createEffect(
    () => {
      const botId = props.bot?.id;
      return { botId, panel: botId ? rightPanels()[botId] : undefined };
    },
    ({ botId, panel }) => {
      if (botId === lastPanelBotId) return;
      const previousBotId = lastPanelBotId;
      lastPanelBotId = botId;
      clearRoutineSettingsRequest();
      resources.filePreviewRequestGeneration += 1;
      const preview = sidebarFilePreview();
      if (preview && preview.ownerBotId !== botId) {
        setSidebarFilePreview(null);
        setRightPanels((current) => ({ ...current, [preview.ownerBotId]: "none" }));
      }
      if (!previousBotId || !botId || (panel !== "settings" && panel !== "file-preview")) return;
      setRightPanels((current) => ({ ...current, [botId]: "none" }));
    },
  );

  createEffect(
    () => ({ request: props.settingsRequest, botId: props.bot?.id }),
    ({ request, botId }) => {
      if (!request || botId !== request.botId || request.nonce === lastHandledSettingsRequestNonce) return;
      lastHandledSettingsRequestNonce = request.nonce;
      setActiveRightPanel("settings", botId);
    },
  );

  createEffect(
    () => ({
      botId: props.bot?.id,
      activeTab: activeBrowserTab(),
      addressEditing: browserAddressEditing(),
      screenOpen: screenOpen(),
      activeBrowserTabId: props.activeBrowserTabId,
      onActivateBrowserTab: activateBrowserTab,
      suspended: props.browserVisibilitySuspended,
    }),
    ({ activeTab, addressEditing, screenOpen, activeBrowserTabId, onActivateBrowserTab, suspended }) => {
      if (props.browserEnabled === false || suspended) return;
      if (!addressEditing) setBrowserAddress(activeTab?.url ?? "https://www.google.com");
      if (screenOpen && activeTab && activeTab.id !== activeBrowserTabId) {
        onActivateBrowserTab(activeTab.id);
      }
    },
  );

  createEffect(
    () => ({
      botId: props.bot?.id,
      visible:
        browserSidebarOpen() &&
        !props.browserVisibilitySuspended &&
        !props.globalOverlayOpen &&
        !props.remoteDesktopVisible &&
        !mediaPreview(),
    }),
    ({ botId, visible }) => {
      if (props.browserEnabled === false) return;
      const generation = ++browserVisibilityGeneration;
      if (browserVisibilityFrame !== undefined) cancelAnimationFrame(browserVisibilityFrame);
      browserResizeObserver?.disconnect();
      browserResizeObserver = undefined;
      if (browserWindowResizeHandler) window.removeEventListener("resize", browserWindowResizeHandler);
      browserWindowResizeHandler = undefined;
      if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
      browserBoundsFrame = undefined;
      if (!visible) {
        void window.openbot.browser.setVisible({ visible: false });
        return;
      }
      browserVisibilityFrame = requestAnimationFrame(() => {
        browserVisibilityFrame = undefined;
        if (
          generation !== browserVisibilityGeneration ||
          props.bot?.id !== botId ||
          !browserSidebarOpen() ||
          !browserSurface
        ) {
          return;
        }
        const syncBounds = () => {
          if (
            generation !== browserVisibilityGeneration ||
            props.bot?.id !== botId ||
            !browserSidebarOpen() ||
            !browserSurface
          ) {
            return;
          }
          const bounds = browserSurface.getBoundingClientRect();
          void window.openbot.browser.setVisible({
            visible: true,
            target: "main",
            bounds: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            },
          });
        };
        syncBounds();
        const scheduleBoundsSync = () => {
          if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
          browserBoundsFrame = requestAnimationFrame(() => {
            browserBoundsFrame = undefined;
            syncBounds();
          });
        };
        browserResizeObserver = new ResizeObserver(scheduleBoundsSync);
        browserResizeObserver.observe(browserSurface);
        if (conversationPanel) browserResizeObserver.observe(conversationPanel);
        browserWindowResizeHandler = scheduleBoundsSync;
        window.addEventListener("resize", browserWindowResizeHandler);
      });
    },
  );

  createEffect(
    () => ({ botId: props.bot?.id, open: browserPipOpen() }),
    ({ open }) => {
      if (props.browserEnabled === false) return;
      if (!open) {
        void window.openbot.browser.closePictureInPicture();
        return;
      }
      void window.openbot.browser
        .openPictureInPicture(untrack(browserPipBounds) ?? undefined)
        .then(saveBrowserPipBounds);
    },
  );

  const removeBrowserPictureInPictureListener = window.openbot.browser.onPictureInPictureEvent((event) => {
    if (event.type === "bounds-changed") {
      saveBrowserPipBounds(event.bounds);
      return;
    }
    setActiveRightPanel(event.type === "dock" ? "browser" : "none");
  });

  onCleanup(() => {
    browserVisibilityGeneration += 1;
    if (browserVisibilityFrame !== undefined) cancelAnimationFrame(browserVisibilityFrame);
    if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
    browserResizeObserver?.disconnect();
    if (browserWindowResizeHandler) window.removeEventListener("resize", browserWindowResizeHandler);
    removeBrowserPictureInPictureListener();
    if (props.browserEnabled !== false) {
      void window.openbot.browser.setVisible({ visible: false });
      void window.openbot.browser.closePictureInPicture();
    }
  });

  async function openExternalMessageUrl(url: string) {
    try {
      await window.openbot.openUrl(url);
    } catch {
      setComposerError("Could not open the link in the external browser.");
    }
  }

  const setConversationPanelElement = (element: HTMLElement) => {
    conversationPanel = element;
  };
  const conversationPanelElement = () => conversationPanel;
  const setScrollElement = (element: HTMLDivElement) => {
    scrollElement = element;
    scrollFades.adopt(element);
    updateVirtualScrollMargin();
  };
  const setStickToLatest = (value: boolean) => {
    stickToLatest = value;
  };
  const setVirtualRootElement = (element: HTMLDivElement) => {
    virtualRoot = element;
    updateVirtualScrollMargin();
    scrollResizeObserver?.observe(element);
  };
  const setUnreadMessagesDividerElement = (element: HTMLDivElement) => {
    unreadMessagesDivider = element;
  };
  const setAgentActivitySlotElement = (element: HTMLDivElement) => {
    agentActivitySlot = element;
    scrollResizeObserver?.observe(element);
  };
  const setBrowserSurfaceElement = (element: HTMLDivElement) => {
    browserSurface = element;
  };
  const setImageAttachmentPickerElement = (element: HTMLInputElement) => {
    imageAttachmentPicker = element;
  };
  const setContextAttachmentPickerElement = (element: HTMLInputElement) => {
    contextAttachmentPicker = element;
  };

  return {
    conversationPanelElement,
    setAgentActivitySlotElement,
    setBrowserSurfaceElement,
    setChatSearchInputElement,
    setConversationPanelElement,
    setContextAttachmentPickerElement,
    setImageAttachmentPickerElement,
    setScrollElement,
    setStickToLatest,
    setUnreadMessagesDividerElement,
    setVirtualRootElement,
    activeActivityId,
    activeBrowserControl,
    actingBrowserControl,
    activeBrowserTab,
    browserTakeoverPreview,
    browserTakeoverResolution,
    browserTakeoverTab,
    respondToBrowserTakeover,
    activeChatSearchIndex,
    activeDeliveries,
    activeRightPanel,
    activityPresentation,
    addAttachments,
    agentActivity,
    agentReady,
    agentActivityExitDelayTimer,
    agentActivityExitTimer,
    agentActivityShowTimer,
    agentActivitySlot,
    agentActivitySpaceReserved,
    activateBrowserTab,
    attachmentAction,
    attachmentBusy,
    browserAddress,
    browserPipOpen,
    browserSidebarOpen,
    browserBoundsFrame,
    browserControlBot,
    browserControlForTab,
    browserControllerForTab,
    browserPanelWidth,
    browserResizeObserver,
    browserTabs,
    browserVisibilityFrame,
    browserVisibilityGeneration,
    browserWindowResizeHandler,
    cancelQueuedMessageEdit,
    chatSearchFrame,
    chatSearchInput,
    chatSearchMatches,
    chatSearchMessageIds,
    chatSearchOpen,
    chatSearchQuery,
    chatSearchRequest,
    chatSearchReturnFocus,
    chatSearchTimer,
    chatSearchTotal,
    clearAgentActivityExitDelayTimer,
    clearAgentActivityExitTimer,
    clearAgentActivityShowTimer,
    closeBrowserTab,
    closeChatSearch,
    closeSidebarFilePreview,
    composerError,
    composerFocusRequest,
    composerHasContent,
    controller,
    copiedMessageId,
    copyMessage,
    currentDraft,
    currentConversationError,
    installedSkills,
    currentUnreadCount,
    drafts,
    dropActive,
    editQueuedMessage,
    editingDeliveryId: currentEditingDeliveryId,
    editingDraftBackup,
    expandedEmojiMessageId,
    expandedThinkingMessages,
    scrollFades,
    filePreviewOpen,
    finishVoiceRecording,
    handleChatSearchShortcut,
    hideBrowserPanel,
    jumpToLatestMessage,
    jumpToUnreadMessages,
    lastChatSearchQuery,
    lastConversationIdentity,
    lastHandledMessageFocusNonce,
    lastHandledSettingsRequestNonce,
    lastPanelBotId,
    lastRuntimeSettingsSignature,
    latestScrollFrame,
    latestScrollSettleFrame,
    markMessageSeen,
    markUnreadMessages,
    markingRead,
    mediaPreview,
    messageVirtualizer,
    moveChatSearch,
    openAttachmentPicker,
    openAttachmentPickerFromKey,
    openBrowserAddress,
    openChatSearch,
    openExternalMessageUrl,
    openMoreMessageId,
    openReactionMessageId,
    openRoutineSettings,
    openRoutineRunMessage,
    openSharedFile,
    openSidebarFileExternally,
    openWorkspaceFile,
    orderedQueuedDeliveries,
    presentedQueueDeliveries,
    previewAttachment,
    previousBrowserTabCount,
    props,
    queueExitTimer,
    queuePanelVisible,
    reactToMessage,
    navigateBrowserTab,
    reloadBrowserTab,
    removeAttachment,
    renderedAgentActivity,
    renderedQueueDeliveries,
    reorderPresentedQueue,
    replyTarget,
    replyToMessage,
    resources,
    rightPanels,
    routineSettingsRequest,
    saveBotPatch,
    updateRuntimeSettings,
    saveQueuedMessageEdit,
    scheduleUnreadDividerVisibilityUpdate,
    screenOpen,
    scrollElement,
    scrollResizeObserver,
    selectAndConfirmModel,
    selectAndConfirmReasoning,
    selectModel,
    selectionSending,
    sendSelectionInstruction,
    setActiveChatSearchIndex,
    setActiveRightPanel,
    setAgentActivitySpaceReserved,
    setAttachmentBusy,
    setBrowserAddress,
    setBrowserAddressEditing,
    setBrowserPanelWidth,
    setChatSearchMatches,
    setChatSearchMessageIds,
    setChatSearchOpen,
    setChatSearchQuery,
    setChatSearchTotal,
    setComposerError,
    setComposerFocusRequest,
    setCopiedMessageId,
    setDrafts,
    setDropActive,
    setEditingDeliveryId,
    setEditingDraftBackup,
    setExpandedEmojiMessageId,
    setExpandedThinkingMessages,
    setMarkingRead,
    setMediaPreview,
    setOpenMoreMessageId,
    setOpenReactionMessageId,
    setRenderedAgentActivity,
    setRenderedQueueDeliveries,
    setRightPanels,
    handleRoutineSettingsRequest,
    setSelectionSending,
    setSidebarFilePreview,
    setSettingsModel,
    setSettingsPanelWidth,
    setSettingsProvider,
    setSettingsReasoning,
    setShowComposerActions,
    setShowScrollToLatest,
    setSubmitting,
    setUnreadDividerVisible,
    setVoiceElapsedSeconds,
    setVoicePhase,
    settingsModel,
    settingsProvider,
    settingsOpen,
    settingsPanelWidth,
    settingsReasoning,
    sidebarFilePreview,
    showBrowserPanel,
    showBrowserPip,
    showComposerActions,
    showScrollToLatest,
    startVoiceElapsedTimer,
    startVoiceRecording,
    stickToLatest,
    stopTeamTyping,
    stopVoiceElapsedTimer,
    stopVoiceRecording,
    stopVoiceStream,
    streamingAgentMessage,
    submitComposer,
    submitting,
    unreadDividerVisible,
    unreadMessagesDivider,
    unreferencedDraftAttachments,
    updateCurrentDraft,
    updateScrollFade,
    updateTeamTyping,
    updateUnreadDividerVisibility,
    virtualRoot,
    voiceElapsedSeconds,
    voicePhase,
    voiceModelProgress,
  };
}

export type ConversationViewScope = ReturnType<typeof createConversationViewScope>;

export const ConversationViewScopeContext = createContext<ConversationViewScope>();

export function useConversationViewScope(): ConversationViewScope {
  const scope = useContext(ConversationViewScopeContext);
  if (!scope) throw new Error("Conversation view scope is unavailable outside ConversationView.");
  return scope;
}
