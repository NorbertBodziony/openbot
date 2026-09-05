import { ATTACHMENT_FILE_ACCEPT, IMAGE_ATTACHMENT_ACCEPT } from "@openbot/contracts/attachment-files";
import { For, Loading, lazy, Show } from "solid-js";
import { ComposerEditor } from "../ComposerEditor";
import { Button, DropdownMenu, File, Image, ImageRemoveButton, Input, LoaderCircle, Mic, Puzzle } from "../ui";
import { fileBadge, formatFileSize } from "./AttachmentCards";
import { attachmentReferenceTone } from "./AttachmentReference";
import { CloseIcon, MoreIcon, PlusIcon, StopIcon } from "./ConversationIcons";
import { useConversationViewScope } from "./conversation-scope";
import { RichMessageText } from "./RichMessageText";
import { formatVoiceDuration, voiceButtonLabel } from "./voice-status";

/** @internal Stable HMR boundary for conversation composer. */
export function ConversationComposer() {
  const {
    agentReady,
    attachmentAction,
    attachmentBusy,
    composerError,
    composerFocusRequest,
    composerHasContent,
    currentDraft,
    currentConversationError,
    installedSkills,
    editQueuedMessage,
    editingDeliveryId,
    openAttachmentPicker,
    openAttachmentPickerFromKey,
    openExternalMessageUrl,
    presentedQueueDeliveries,
    previewAttachment,
    props,
    queuePanelVisible,
    removeAttachment,
    reorderPresentedQueue,
    replyTarget,
    selectionSending,
    setComposerFocusRequest,
    setContextAttachmentPickerElement,
    setImageAttachmentPickerElement,
    setShowComposerActions,
    showComposerActions,
    startVoiceRecording,
    stopVoiceRecording,
    submitComposer,
    submitting,
    unreferencedDraftAttachments,
    updateCurrentDraft,
    updateTeamTyping,
    voiceElapsedSeconds,
    voicePhase,
    voiceModelProgress,
  } = useConversationViewScope();
  return (
    <Show when={!props.prompt && !props.approval && !props.browserTakeover}>
      <div class="composer-wrap">
        <div
          class="agent-queue-slot"
          data-open={queuePanelVisible() ? "true" : "false"}
          aria-hidden={queuePanelVisible() ? undefined : "true"}
          inert={queuePanelVisible() ? undefined : true}
        >
          <div class="agent-queue-slot-inner">
            <Show when={queuePanelVisible()}>
              <Loading>
                <QueuePanel
                  deliveries={presentedQueueDeliveries()}
                  agents={props.agents}
                  skills={installedSkills()}
                  editingDeliveryId={editingDeliveryId()}
                  canSteer={Boolean(props.activeTurnId)}
                  onSteer={props.onSteerQueuedMessage}
                  onCancel={props.onCancelQueuedMessage}
                  onEdit={editQueuedMessage}
                  onReorder={reorderPresentedQueue}
                />
              </Loading>
            </Show>
          </div>
        </div>
        <Show when={replyTarget()}>
          {(message) => (
            <div class="composer-reply-preview">
              <div>
                <span>Replying to {message().author === "you" ? "your message" : "Agent"}</span>
                <p>
                  <RichMessageText
                    body={message().body || "Attachment"}
                    agents={props.agents}
                    skills={installedSkills()}
                    attachments={message().attachments}
                    onSelectAgent={props.onSelectAgent}
                    onOpenLink={(url) => void openExternalMessageUrl(url)}
                    onOpenAttachment={(attachment) => void previewAttachment(attachment)}
                  />
                </p>
              </div>
              <Button
                variant="ghost"
                type="button"
                aria-label="Cancel reply"
                disabled={voicePhase() === "transcribing"}
                onClick={() => updateCurrentDraft({ replyToMessageId: null })}
              >
                <CloseIcon />
              </Button>
            </div>
          )}
        </Show>
        <Show when={composerError() ?? currentConversationError()}>
          <div class="composer-error" role="alert">
            {composerError() ?? currentConversationError()}
          </div>
        </Show>
        <div
          class={`composer${voicePhase() === "recording" ? " composer-recording" : ""}`}
          data-compact={
            currentDraft().text.includes("\n") || unreferencedDraftAttachments().length > 0 ? undefined : ""
          }
          data-has-attachments={unreferencedDraftAttachments().length > 0 ? "" : undefined}
          onPointerDown={(event) => {
            if (!(event.target instanceof Element)) return;
            if (event.target.closest("button, .composer-editor-surface")) return;
            event.preventDefault();
            setComposerFocusRequest((current) => current + 1);
          }}
        >
          <Show when={unreferencedDraftAttachments().length > 0}>
            <div class="composer-attachments">
              <For each={unreferencedDraftAttachments()}>
                {(attachment) => (
                  <div class="composer-attachment ui-removable-image" data-kind={attachment.kind}>
                    <span
                      class="composer-attachment-preview"
                      data-file-tone={attachment.kind === "file" ? attachmentReferenceTone(attachment.name) : undefined}
                    >
                      <Show when={attachment.kind === "image"} fallback={fileBadge(attachment)}>
                        <img src={attachment.previewUrl ?? ""} alt="" />
                      </Show>
                    </span>
                    <Show when={attachment.kind === "file"}>
                      <span class="composer-attachment-copy">
                        <strong title={attachment.name}>{attachment.name}</strong>
                        <small>{formatFileSize(attachment.size)}</small>
                      </span>
                    </Show>
                    <ImageRemoveButton
                      label={`Remove ${attachment.name}`}
                      disabled={voicePhase() === "transcribing"}
                      onClick={() => removeAttachment(attachment.id)}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="composer-input-label">
            <ComposerEditor
              agentId={props.agent?.id}
              agents={props.agents}
              skills={installedSkills()}
              attachments={currentDraft().attachments}
              value={currentDraft().text}
              disabled={submitting() || selectionSending() || voicePhase() === "transcribing" || !agentReady()}
              placeholder={
                !agentReady()
                  ? "Complete agent CLI setup to start"
                  : replyTarget()
                    ? "Reply…"
                    : `Message ${props.agent?.name ?? "agent"}`
              }
              ariaLabel={`Message ${props.agent?.name ?? "agent"}`}
              focusRequest={composerFocusRequest()}
              onValueChange={(text) => {
                updateCurrentDraft({ text });
                updateTeamTyping(text);
              }}
              onSubmit={submitComposer}
              onOpenAttachment={(attachment) =>
                attachment.previewKind === "none"
                  ? attachmentAction(attachment, "open")
                  : void previewAttachment(attachment)
              }
            />
          </div>
          <div class="composer-toolbar">
            <Input
              ref={setImageAttachmentPickerElement}
              type="file"
              accept={IMAGE_ATTACHMENT_ACCEPT}
              multiple
              hidden
              tabindex={-1}
              data-openbot-attachment-picker="true"
            />
            <Input
              ref={setContextAttachmentPickerElement}
              type="file"
              accept={ATTACHMENT_FILE_ACCEPT}
              multiple
              hidden
              tabindex={-1}
              data-openbot-attachment-picker="true"
            />
            <DropdownMenu.Root
              open={showComposerActions()}
              onOpenChange={setShowComposerActions}
              placement="top-start"
              gutter={8}
              modal={false}
            >
              <DropdownMenu.Trigger
                class="composer-button"
                aria-label="Add to prompt"
                disabled={
                  attachmentBusy() ||
                  submitting() ||
                  selectionSending() ||
                  voicePhase() === "transcribing" ||
                  !agentReady()
                }
              >
                <PlusIcon />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content aria-label="Add to prompt">
                  <DropdownMenu.Item
                    disabled={attachmentBusy()}
                    onPointerDown={(event) => {
                      if (event.button === 0) openAttachmentPicker("images");
                    }}
                    onKeyDown={(event) => openAttachmentPickerFromKey(event, "images")}
                  >
                    <Image aria-hidden="true" />
                    <span>Attach image</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item disabled title="Skill selection is not available yet.">
                    <Puzzle aria-hidden="true" />
                    <span>Use a skill</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={attachmentBusy()}
                    onPointerDown={(event) => {
                      if (event.button === 0) openAttachmentPicker("all");
                    }}
                    onKeyDown={(event) => openAttachmentPickerFromKey(event, "all")}
                  >
                    <File aria-hidden="true" />
                    <span>Add context</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <div class="composer-primary-actions">
              <Show when={voicePhase() === "preparing"}>
                <span class="voice-model-progress" role="status">
                  Downloading voice model {voiceModelProgress() ?? 0}%
                </span>
              </Show>
              <Show
                when={voicePhase() === "recording"}
                fallback={
                  <Button
                    variant="ghost"
                    type="button"
                    class="dictation-button"
                    aria-label={voiceButtonLabel(voicePhase())}
                    disabled={
                      voicePhase() === "requesting" ||
                      voicePhase() === "preparing" ||
                      voicePhase() === "transcribing" ||
                      (voicePhase() === "idle" && (!props.agent || !agentReady()))
                    }
                    onClick={() => void startVoiceRecording()}
                  >
                    <Show
                      when={
                        voicePhase() === "preparing" || voicePhase() === "requesting" || voicePhase() === "transcribing"
                      }
                      fallback={<Mic aria-hidden="true" />}
                    >
                      <LoaderCircle class="dictation-spinner" aria-hidden="true" />
                    </Show>
                  </Button>
                }
              >
                <fieldset class="voice-recording-status" aria-label="Voice recording">
                  <Button
                    variant="ghost"
                    type="button"
                    class="voice-recording-stop"
                    aria-label="Stop voice recording"
                    onClick={stopVoiceRecording}
                  >
                    <StopIcon />
                  </Button>
                  <time class="voice-recording-duration" datetime={`PT${voiceElapsedSeconds()}S`}>
                    {formatVoiceDuration(voiceElapsedSeconds())}
                  </time>
                  <MoreIcon />
                </fieldset>
              </Show>
              <Show
                when={
                  props.activeTurnId && !editingDeliveryId() && !composerHasContent() && voicePhase() !== "recording"
                }
                fallback={
                  <Button
                    variant="ghost"
                    type="button"
                    class="voice-button"
                    aria-label={
                      editingDeliveryId()
                        ? "Save queued message"
                        : voicePhase() === "recording"
                          ? "Send voice message"
                          : "Send message"
                    }
                    disabled={
                      submitting() ||
                      selectionSending() ||
                      !agentReady() ||
                      voicePhase() === "preparing" ||
                      voicePhase() === "requesting" ||
                      voicePhase() === "transcribing"
                    }
                    onClick={submitComposer}
                  >
                    {submitting() ? "…" : "↑"}
                  </Button>
                }
              >
                <Button
                  variant="ghost"
                  type="button"
                  class="voice-button voice-button-active"
                  aria-label="Stop agent"
                  onClick={props.onStop}
                >
                  <StopIcon />
                </Button>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

const QueuePanel = lazy(() => import("./QueuePanel").then((module) => ({ default: module.QueuePanel })));
