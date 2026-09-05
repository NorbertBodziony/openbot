import { onCleanup } from "solid-js";
import { type ConversationProps, ConversationView } from "./ConversationView";
import { useConversationController } from "./conversation-controller-context";

export { createConversationController } from "./conversation-controller";

/**
 * The scoped half of the conversation surface.
 *
 * The controller itself is created above the per-server scope (see
 * `app-providers.tsx`), because composer drafts, an in-flight voice send and a
 * queued-message edit are keyed by `serverId:agentId` and are expected to still be
 * there when the user comes back. What *is* scoped is the typing indicator and
 * the microphone: leaving the conversation - by opening Agent setup, a direct
 * message, or another server - has to release both, and this component unmounts
 * on exactly those transitions.
 *
 * On a server switch the typing indicator is released earlier still, in
 * `server-selection.tsx`, because by the time this unmounts main has already
 * moved its active server and the message would reach the wrong one. The call
 * here is then a no-op, and it is what covers the two transitions that stay
 * inside one server.
 *
 * `voiceDisposed` deliberately stays with the controller. It means "the app is
 * going away", not "this view went away", so a transcription that resolves after
 * the switch still lands on the server that started it. What replaces it for the
 * view's own lifetime is the scope guard in `ConversationView`, which keeps a
 * finished model download from opening the microphone for a conversation nobody
 * is looking at.
 *
 * `transcribing` is the one phase this does not release, because unlike the two
 * it does, it names work that is already running and that finishes into a draft
 * the user can still reach.
 */
export function Conversation(props: ConversationProps) {
  const controller = useConversationController();
  const { resources } = controller;

  onCleanup(() => {
    controller.stopComposerTyping();
    const phase = controller.voicePhase();
    if (phase === "preparing" || phase === "requesting") {
      // A model download and a permission prompt both belong to the
      // conversation that asked for them, and both can outlive it by a long way
      // - or never settle at all. The phase does not belong to them: it lives on
      // the controller, so leaving it here would hand the next conversation a
      // disabled microphone and someone else's "Downloading voice model". The
      // abandoned chain still reports its failure where it was asked for,
      // because the generation counter rather than the phase is what tells it
      // that it has been superseded.
      controller.setVoicePhase("idle");
      controller.setVoiceModelProgress(null);
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
