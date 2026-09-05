import type { ComposerDraft } from "./conversation-types";

export const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
  replyToMessageId: null,
};

export function copyComposerDraft(draft: ComposerDraft): ComposerDraft {
  return {
    text: draft.text,
    attachments: [...draft.attachments],
    replyToMessageId: draft.replyToMessageId,
  };
}
