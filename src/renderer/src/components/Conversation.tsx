import { onCleanup } from "solid-js";
import { type ConversationProps, ConversationView } from "./ConversationView";
import { useConversationController } from "./conversation-controller-context";

export { createConversationController } from "./conversation-controller";

/**
 * The scoped half of the conversation surface.
 *
 * The controller itself is created above the per-server scope (see
 * `app-providers.tsx`), because composer drafts, an in-flight voice send and a
 * queued-message edit are keyed by `serverId:botId` and are expected to still be
 * there when the user comes back. What *is* scoped is the typing indicator and
 * the microphone: leaving the conversation - by opening Bot setup, a direct
 * message, or another server - has to release both, and this component unmounts
 * on exactly those transitions.
 *
 * `voiceDisposed` deliberately stays with the controller. It means "the app is
 * going away", not "this view went away", so a transcription that resolves after
 * the switch still lands on the server that started it. What replaces it for the
 * view's own lifetime is the scope guard in `ConversationView`, which keeps a
 * finished model download from opening the microphone for a conversation nobody
 * is looking at.
 */
export function Conversation(props: ConversationProps) {
  const controller = useConversationController();
  const { resources } = controller;

  onCleanup(() => {
    if (resources.typingIdleTimer) clearTimeout(resources.typingIdleTimer);
    if (resources.typingBotId) {
      props.onTypingChange(resources.typingBotId, false);
      resources.typingBotId = null;
    }
    if (resources.voiceRecordingTimer) clearTimeout(resources.voiceRecordingTimer);
    if (resources.voiceElapsedTimer) clearInterval(resources.voiceElapsedTimer);
    if (resources.voiceRecorder?.state === "recording") {
      // The audio captured so far still belongs to the draft it was dictated
      // into, and drafts outlive this view, so the recording finishes into text
      // rather than being thrown away. `transcribing` is what that is, and
      // leaving the phase on `recording` would offer a stop button for a
      // recorder that has already been handed over.
      controller.setVoicePhase("transcribing");
      resources.voiceRecorder.stop();
    }
    for (const track of resources.voiceStream?.getTracks() ?? []) track.stop();
  });

  return <ConversationView {...props} />;
}
