import type { DraftAttachment, QueueDelivery } from "@openbot/contracts/ipc";
import { expandComposerMentions } from "../ComposerEditor";
import type { ComposerDraft, ConversationProps, ConversationTarget } from "../ConversationView";
import { copyComposerDraft, EMPTY_DRAFT } from "../composer-draft";
import { composerDraftKey } from "../conversation-keys";

export interface ComposerActionsDeps {
  props: ConversationProps;
  agentReady: () => boolean;
  drafts: () => Record<string, ComposerDraft>;
  setDrafts: (update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>) => void;
  editingAgentId: () => string | null;
  setEditingAgentId: (id: string | null) => void;
  editingServerId: () => string | null;
  setEditingServerId: (id: string | null) => void;
  editingDeliveryId: () => string | null;
  setEditingDeliveryId: (id: string | null) => void;
  editingDraftBackup: () => ComposerDraft | null;
  setEditingDraftBackup: (draft: ComposerDraft | null) => void;
  editingOriginalAttachmentIds: () => string[];
  setEditingOriginalAttachmentIds: (ids: string[]) => void;
  submitting: () => boolean;
  setSubmitting: (submitting: boolean) => void;
  selectionSending: () => boolean;
  setSelectionSending: (sending: boolean) => void;
  voicePhase: () => string;
  setComposerError: (error: string | null) => void;
  setComposerFocusRequest: (update: (current: number) => number) => void;
  setShowComposerActions: (show: boolean) => void;
  orderedQueuedDeliveries: () => QueueDelivery[];
  presentedQueueDeliveries: () => QueueDelivery[];
  typing: {
    idleTimer: ReturnType<typeof setTimeout> | undefined;
    agentId: string | null;
  };
  voice: {
    agentId: string | undefined;
    serverId: string | undefined;
    submitRequest:
      | {
          agentId: string;
          serverId: string;
          draft: ComposerDraft;
          queuedEdit: { deliveryId: string; originalAttachmentIds: string[] } | undefined;
        }
      | undefined;
  };
  stopComposerTyping: () => void;
  stopVoiceRecording: () => void;
  currentTarget: () => ConversationTarget | undefined;
  currentDraft: () => ComposerDraft;
  currentEditingDeliveryId: () => string | null;
  clearConversationError: (target: ConversationTarget) => void;
  clearSubmittedDraft: (target: ConversationTarget, submitted: ComposerDraft) => void;
  setConversationError: (target: ConversationTarget, message: string) => void;
  setStickToLatest: (value: boolean) => void;
  imageAttachmentPicker: () => HTMLInputElement | undefined;
  contextAttachmentPicker: () => HTMLInputElement | undefined;
}

export function createComposerActions(deps: ComposerActionsDeps) {
  function updateTeamTyping(text: string): void {
    const agentId = deps.props.agent?.id;
    if (deps.typing.idleTimer) clearTimeout(deps.typing.idleTimer);
    if (!agentId || !text.trim()) {
      stopTeamTyping();
      return;
    }
    if (deps.typing.agentId && deps.typing.agentId !== agentId) deps.props.onTypingChange(deps.typing.agentId, false);
    deps.typing.agentId = agentId;
    deps.props.onTypingChange(agentId, true);
    deps.typing.idleTimer = setTimeout(stopTeamTyping, 3_000);
  }

  function stopTeamTyping(): void {
    deps.stopComposerTyping();
  }

  function addAttachments(selected: DraftAttachment[], target = deps.currentTarget()) {
    if (!target) return;
    deps.clearConversationError(target);
    const key = composerDraftKey(target);
    const draft = deps.drafts()[key] ?? EMPTY_DRAFT;
    const available = Math.max(0, 10 - draft.attachments.length);
    const accepted = selected.slice(0, available);
    for (const attachment of selected.slice(available)) {
      void window.openbot.agent.discardDraftAttachment(attachment.id, target.serverId);
    }
    deps.setDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? EMPTY_DRAFT),
        attachments: [...draft.attachments, ...accepted],
      },
    }));
    if (selected.length > accepted.length) deps.setComposerError("You can attach at most 10 files.");
    deps.setShowComposerActions(false);
  }

  function openAttachmentPicker(filter: "all" | "images") {
    deps.setShowComposerActions(false);
    deps.setComposerError(null);
    const picker = filter === "images" ? deps.imageAttachmentPicker() : deps.contextAttachmentPicker();
    if (!picker) return;
    picker.value = "";
    picker.click();
  }

  function openAttachmentPickerFromKey(event: KeyboardEvent, filter: "all" | "images") {
    if (event.key === "Enter" || event.key === " ") openAttachmentPicker(filter);
  }

  function editQueuedMessage(delivery: QueueDelivery) {
    const agentId = deps.props.agent?.id;
    const serverId = deps.props.server?.id ?? "local";
    if (!agentId || delivery.status !== "queued") return;
    if (deps.editingDeliveryId()) cancelQueuedMessageEdit();
    deps.clearConversationError({ agentId, serverId });
    deps.setEditingAgentId(agentId);
    deps.setEditingServerId(serverId);
    deps.setEditingDraftBackup({
      text: deps.currentDraft().text,
      attachments: [...deps.currentDraft().attachments],
      replyToMessageId: deps.currentDraft().replyToMessageId,
    });
    deps.setEditingOriginalAttachmentIds(delivery.attachments.map((attachment) => attachment.id));
    deps.setEditingDeliveryId(delivery.id);
    deps.setDrafts((current) => ({
      ...current,
      [composerDraftKey({ agentId, serverId })]: {
        text: delivery.text,
        attachments: [...delivery.attachments],
        replyToMessageId: delivery.replyToMessageId,
      },
    }));
    deps.setComposerFocusRequest((current) => current + 1);
    deps.setShowComposerActions(false);
    deps.setComposerError(null);
  }

  function cancelQueuedMessageEdit() {
    const agentId = deps.editingAgentId() ?? deps.props.agent?.id;
    const serverId = deps.editingServerId() ?? deps.props.server?.id ?? "local";
    const target = agentId ? { agentId, serverId } : undefined;
    const backup = deps.editingDraftBackup();
    const draft = target ? (deps.drafts()[composerDraftKey(target)] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
    const preservedAttachmentIds = new Set([
      ...(backup?.attachments.map((attachment) => attachment.id) ?? []),
      ...deps.editingOriginalAttachmentIds(),
    ]);
    for (const attachment of draft.attachments) {
      if (!preservedAttachmentIds.has(attachment.id)) {
        void window.openbot.agent.discardDraftAttachment(attachment.id, serverId);
      }
    }
    if (target) {
      deps.setDrafts((current) => ({ ...current, [composerDraftKey(target)]: backup ?? EMPTY_DRAFT }));
    }
    deps.setEditingAgentId(null);
    deps.setEditingServerId(null);
    deps.setEditingDeliveryId(null);
    deps.setEditingDraftBackup(null);
    deps.setEditingOriginalAttachmentIds([]);
  }

  async function saveQueuedMessageEdit(
    draftOverride?: ComposerDraft,
    target?: ConversationTarget & { deliveryId: string; originalAttachmentIds: string[] },
    submittedSnapshot?: ComposerDraft,
  ): Promise<boolean> {
    const agentId = target?.agentId ?? deps.editingAgentId() ?? deps.props.agent?.id;
    const serverId = target?.serverId ?? deps.editingServerId() ?? deps.props.server?.id ?? "local";
    const deliveryId = target?.deliveryId ?? deps.editingDeliveryId();
    const draft = draftOverride ?? deps.currentDraft();
    if (!agentId || !deliveryId || deps.submitting()) return false;
    const delivery = target ? undefined : deps.props.queue?.deliveries.find((item) => item.id === deliveryId);
    if (!target && delivery?.status !== "queued") {
      deps.setComposerError("This queued message is no longer available.");
      cancelQueuedMessageEdit();
      return false;
    }
    const text = expandComposerMentions(draft.text);
    const originalAttachmentIds = new Set(
      target?.originalAttachmentIds ?? delivery?.attachments.map((attachment) => attachment.id) ?? [],
    );
    const keepAttachmentIds = draft.attachments
      .filter((attachment) => originalAttachmentIds.has(attachment.id))
      .map((attachment) => attachment.id);
    const attachmentDraftIds = draft.attachments
      .filter((attachment) => !originalAttachmentIds.has(attachment.id))
      .map((attachment) => attachment.id);
    if (!text.trim() && keepAttachmentIds.length === 0 && attachmentDraftIds.length === 0) return false;

    stopTeamTyping();
    deps.setSubmitting(true);
    deps.setComposerError(null);
    let saved = false;
    try {
      saved = await deps.props.onUpdateQueuedMessage(
        deliveryId,
        text,
        keepAttachmentIds,
        attachmentDraftIds,
        target ?? (agentId ? { agentId, serverId } : undefined),
      );
    } catch (error) {
      deps.setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      deps.setSubmitting(false);
    }
    if (!saved) return false;
    const savedTarget = { agentId, serverId };
    deps.clearConversationError(savedTarget);
    if (submittedSnapshot) deps.clearSubmittedDraft(savedTarget, submittedSnapshot);
    else deps.setDrafts((current) => ({ ...current, [composerDraftKey(savedTarget)]: EMPTY_DRAFT }));
    if (
      deps.editingAgentId() === agentId &&
      deps.editingServerId() === serverId &&
      deps.editingDeliveryId() === deliveryId
    ) {
      deps.setEditingAgentId(null);
      deps.setEditingServerId(null);
      deps.setEditingDeliveryId(null);
      deps.setEditingDraftBackup(null);
      deps.setEditingOriginalAttachmentIds([]);
    }
    return true;
  }

  function reorderPresentedQueue(deliveryIds: string[]) {
    const allQueuedIds = deps.orderedQueuedDeliveries().map((delivery) => delivery.id);
    const presentedQueuedIds = deps
      .presentedQueueDeliveries()
      .filter((delivery) => delivery.status === "queued")
      .map((delivery) => delivery.id);
    if (presentedQueuedIds.length === allQueuedIds.length) {
      deps.props.onReorderQueue(deliveryIds);
      return;
    }

    const presentedIds = new Set(presentedQueuedIds);
    let nextPresentedIndex = 0;
    deps.props.onReorderQueue(
      allQueuedIds.map((deliveryId) =>
        presentedIds.has(deliveryId) ? (deliveryIds[nextPresentedIndex++] ?? deliveryId) : deliveryId,
      ),
    );
  }

  async function submitMessage(
    draftOverride?: ComposerDraft,
    targetOverride?: ConversationTarget,
    submittedSnapshot?: ComposerDraft,
  ): Promise<boolean> {
    if (deps.selectionSending()) return false;
    if (!draftOverride && deps.currentEditingDeliveryId()) {
      return saveQueuedMessageEdit();
    }
    const agentId = targetOverride?.agentId ?? deps.props.agent?.id;
    const target = targetOverride ?? (agentId ? { agentId, serverId: deps.props.server?.id ?? "local" } : undefined);
    const draft = draftOverride ?? deps.currentDraft();
    const text = expandComposerMentions(draft.text);
    const attachments = draft.attachments;
    if (!agentId || !target || deps.submitting() || (!text.trim() && attachments.length === 0)) return false;
    stopTeamTyping();
    deps.setStickToLatest(true);
    deps.setSubmitting(true);
    deps.setComposerError(null);
    const sent = await deps.props.onSendMessage(
      text,
      attachments.map((item) => item.id),
      draft.replyToMessageId,
      target,
    );
    deps.setSubmitting(false);
    if (sent) {
      deps.clearConversationError(target);
      if (submittedSnapshot) deps.clearSubmittedDraft(target, submittedSnapshot);
      else deps.setDrafts((current) => ({ ...current, [composerDraftKey(target)]: EMPTY_DRAFT }));
    }
    return sent;
  }

  function submitComposer(): void {
    const phase = deps.voicePhase();
    if (phase === "recording") {
      const agentId = deps.voice.agentId;
      const serverId = deps.voice.serverId;
      if (!agentId || !serverId) return;
      const target = { agentId, serverId };
      const draft = copyComposerDraft(deps.drafts()[composerDraftKey(target)] ?? EMPTY_DRAFT);
      const deliveryId =
        deps.editingAgentId() === agentId && deps.editingServerId() === serverId ? deps.editingDeliveryId() : null;
      const activeTarget = deps.currentTarget();
      const targetIsActive = activeTarget?.agentId === target.agentId && activeTarget.serverId === target.serverId;
      const delivery =
        deliveryId && targetIsActive ? deps.props.queue?.deliveries.find((item) => item.id === deliveryId) : undefined;
      if (deliveryId && targetIsActive && delivery?.status !== "queued") {
        deps.setComposerError("This queued message is no longer available.");
        cancelQueuedMessageEdit();
        return;
      }
      deps.voice.submitRequest = {
        agentId,
        serverId,
        draft,
        queuedEdit: deliveryId
          ? {
              deliveryId,
              originalAttachmentIds: delivery
                ? delivery.attachments.map((attachment) => attachment.id)
                : [...deps.editingOriginalAttachmentIds()],
            }
          : undefined,
      };
      deps.stopVoiceRecording();
      return;
    }
    if (phase !== "idle") return;
    void submitMessage();
  }

  async function sendSelectionInstruction(messageId: string, body: string): Promise<boolean> {
    if (!deps.props.agent || deps.submitting() || deps.selectionSending() || !deps.agentReady()) {
      return false;
    }
    deps.setSelectionSending(true);
    try {
      return await deps.props.onSendMessage(body, [], messageId);
    } finally {
      deps.setSelectionSending(false);
    }
  }

  return {
    updateTeamTyping,
    stopTeamTyping,
    addAttachments,
    openAttachmentPicker,
    openAttachmentPickerFromKey,
    editQueuedMessage,
    cancelQueuedMessageEdit,
    saveQueuedMessageEdit,
    reorderPresentedQueue,
    submitMessage,
    submitComposer,
    sendSelectionInstruction,
  };
}

export type ComposerActions = ReturnType<typeof createComposerActions>;
