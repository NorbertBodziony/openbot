import {
  attachmentReferenceIds,
  expandAttachmentReferences,
  removeAttachmentReferences,
} from "@openbot/contracts/attachment-references";
import { expandChatTagReferences } from "@openbot/contracts/chat-tag-references";
import type { InstalledSkill, MessageReaction } from "@openbot/contracts/ipc";
import { desktopAnalytics } from "../../../analytics";
import type { AgentMessage } from "../../../data";
import type { ComposerDraft, ConversationProps } from "../ConversationView";

export interface MessageActionsDeps {
  props: ConversationProps;
  installedSkills: () => InstalledSkill[];
  currentDraft: () => ComposerDraft;
  updateCurrentDraft: (patch: Partial<ComposerDraft>) => void;
  currentTarget: () => { agentId: string; serverId: string } | undefined;
  setOpenReactionMessageId: (id: string | null) => void;
  setOpenMoreMessageId: (id: string | null) => void;
  setExpandedEmojiMessageId: (id: string | null) => void;
  copiedMessageId: () => string | null;
  setCopiedMessageId: (id: string | null) => void;
  setComposerError: (error: string | null) => void;
}

export function createMessageActions(deps: MessageActionsDeps) {
  function replyToMessage(message: AgentMessage) {
    deps.updateCurrentDraft({ replyToMessageId: message.id });
    deps.setOpenReactionMessageId(null);
    deps.setOpenMoreMessageId(null);
  }

  async function reactToMessage(message: AgentMessage, emoji: MessageReaction | null) {
    const agentId = deps.props.agent?.id;
    if (!agentId) return;
    const analytics = desktopAnalytics.scope();
    deps.setOpenReactionMessageId(null);
    deps.setExpandedEmojiMessageId(null);
    try {
      await window.openbot.agent.setMessageReaction({
        agentId,
        messageId: message.id,
        emoji,
      });
      analytics.track("reaction_action", { action: emoji ? "add" : "remove", result: "succeeded" });
    } catch (error) {
      analytics.track("reaction_action", {
        action: emoji ? "add" : "remove",
        result: "failed",
        failure_code: "reaction_failed",
      });
      deps.setComposerError(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyMessage(message: AgentMessage) {
    const attachmentNames = new Map((message.attachments ?? []).map((attachment) => [attachment.id, attachment.name]));
    const agentNames = new Map(deps.props.agents.map((agent) => [agent.id, agent.name]));
    const skillNames = new Map(
      deps
        .installedSkills()
        .filter((skill) => skill.state !== "needs-repair")
        .map((skill) => [skill.skillId, skill.name]),
    );
    const text = expandAttachmentReferences(
      expandChatTagReferences(message.body, (reference) =>
        reference.kind === "agent" ? agentNames.get(reference.id) : skillNames.get(reference.id),
      ),
      (reference) => attachmentNames.get(reference.attachmentId),
    );
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = document.createElement("textarea");
        input.value = text;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.append(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      deps.setCopiedMessageId(message.id);
      window.setTimeout(() => {
        if (deps.copiedMessageId() === message.id) deps.setCopiedMessageId(null);
      }, 1_400);
    } catch (error) {
      deps.setComposerError(error instanceof Error ? error.message : "Could not copy the message.");
    }
  }

  function removeAttachment(id: string) {
    const serverId = deps.currentTarget()?.serverId;
    deps.updateCurrentDraft({
      attachments: deps.currentDraft().attachments.filter((attachment) => attachment.id !== id),
      text: removeAttachmentReferences(deps.currentDraft().text, id),
    });
    void window.openbot.agent.discardDraftAttachment(id, serverId);
  }

  function draftAttachmentIds(): Set<string> {
    return attachmentReferenceIds(deps.currentDraft().text);
  }

  return {
    replyToMessage,
    reactToMessage,
    copyMessage,
    removeAttachment,
    draftAttachmentIds,
  };
}

export type MessageActions = ReturnType<typeof createMessageActions>;
