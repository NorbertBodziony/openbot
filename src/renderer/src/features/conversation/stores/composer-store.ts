import { attachmentReferenceIds } from "@openbot/contracts/attachment-references";
import { createMemo } from "solid-js";
import { appendVoiceTranscript } from "../../../voice-recording";
import type { ComposerDraft, ConversationProps, ConversationTarget } from "../ConversationView";
import { EMPTY_DRAFT } from "../composer-draft";
import { composerDraftKey } from "../conversation-keys";

export interface ComposerStoreDeps {
  props: ConversationProps;
  drafts: () => Record<string, ComposerDraft>;
  setDrafts: (update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>) => void;
  conversationErrors: () => Record<string, string>;
  setConversationErrors: (update: (current: Record<string, string>) => Record<string, string>) => void;
  editingAgentId: () => string | null;
  editingServerId: () => string | null;
  editingDeliveryId: () => string | null;
  seenMessageIds: Set<string>;
}

export function currentConversationTarget(props: ConversationProps): ConversationTarget | undefined {
  const agentId = props.agent?.id;
  return agentId ? { agentId, serverId: props.server?.id ?? "local" } : undefined;
}

export function createComposerStore(deps: ComposerStoreDeps) {
  const currentTarget = (): ConversationTarget | undefined => currentConversationTarget(deps.props);
  const currentEditingDeliveryId = createMemo(() => {
    const target = currentTarget();
    return target && deps.editingAgentId() === target.agentId && deps.editingServerId() === target.serverId
      ? deps.editingDeliveryId()
      : null;
  });
  const currentDraft = createMemo(() => {
    const target = currentTarget();
    return target ? (deps.drafts()[composerDraftKey(target)] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
  });
  const currentConversationError = createMemo(() => {
    const target = currentTarget();
    return target ? (deps.conversationErrors()[composerDraftKey(target)] ?? null) : null;
  });
  const unreferencedDraftAttachments = createMemo(() => {
    const referencedIds = attachmentReferenceIds(currentDraft().text);
    return currentDraft().attachments.filter((attachment) => !referencedIds.has(attachment.id));
  });
  const composerHasContent = createMemo(
    () => Boolean(currentDraft().text.trim()) || currentDraft().attachments.length > 0,
  );
  const replyTarget = createMemo(() => {
    const id = currentDraft().replyToMessageId;
    return id ? deps.props.messages.find((message) => message.id === id) : undefined;
  });

  const markMessageSeen = (messageId: string): boolean => {
    const key = `${deps.props.agent?.id ?? "none"}:${messageId}`;
    if (deps.seenMessageIds.has(key)) return false;
    deps.seenMessageIds.add(key);
    return true;
  };

  function clearConversationError(target: ConversationTarget): void {
    const key = composerDraftKey(target);
    deps.setConversationErrors((current) => {
      const { [key]: _removed, ...next } = current;
      return next;
    });
  }

  const updateCurrentDraft = (patch: Partial<ComposerDraft>) => {
    const target = currentTarget();
    if (!target) return;
    clearConversationError(target);
    const key = composerDraftKey(target);
    deps.setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? EMPTY_DRAFT), ...patch },
    }));
  };

  function clearSubmittedDraft(target: ConversationTarget, submitted: ComposerDraft): void {
    const key = composerDraftKey(target);
    const submittedAttachmentIds = new Set(submitted.attachments.map((attachment) => attachment.id));
    deps.setDrafts((current) => {
      const draft = current[key] ?? EMPTY_DRAFT;
      const next: ComposerDraft = {
        text: draft.text === submitted.text ? "" : draft.text,
        attachments: draft.attachments.filter((attachment) => !submittedAttachmentIds.has(attachment.id)),
        replyToMessageId: draft.replyToMessageId === submitted.replyToMessageId ? null : draft.replyToMessageId,
      };
      return { ...current, [key]: next };
    });
  }

  function setConversationError(target: ConversationTarget, message: string): void {
    deps.setConversationErrors((current) => ({
      ...current,
      [composerDraftKey(target)]: message,
    }));
  }

  function restoreVoiceTranscript(target: ConversationTarget, transcript: string): void {
    const key = composerDraftKey(target);
    deps.setDrafts((current) => {
      const draft = current[key] ?? EMPTY_DRAFT;
      return {
        ...current,
        [key]: { ...draft, text: appendVoiceTranscript(draft.text, transcript) },
      };
    });
  }

  return {
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
    restoreVoiceTranscript,
  };
}

export type ComposerStore = ReturnType<typeof createComposerStore>;
