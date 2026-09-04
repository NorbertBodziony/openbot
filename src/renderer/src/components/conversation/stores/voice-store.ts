import { VOICE_AUDIO_LIMITS } from "@openbot/contracts/ipc";
import { onCleanup } from "solid-js";
import { desktopAnalytics } from "../../../analytics";
import { composerDraftKey } from "../../../conversation-keys";
import { appendVoiceTranscript, recordingToWav } from "../../../voice-recording";
import type { ComposerDraft, ConversationProps, ConversationTarget } from "../../ConversationView";
import { EMPTY_DRAFT } from "../composer-draft";
import { voiceCaptureError, voiceTranscriptionError } from "../voice-status";

export interface VoiceSubmitHooks {
  saveEdit: (
    draftOverride?: ComposerDraft,
    target?: ConversationTarget & { deliveryId: string; originalAttachmentIds: string[] },
    submittedSnapshot?: ComposerDraft,
  ) => Promise<boolean>;
  submit: (
    draftOverride?: ComposerDraft,
    targetOverride?: ConversationTarget,
    submittedSnapshot?: ComposerDraft,
  ) => Promise<boolean>;
  restoreTranscript: (target: ConversationTarget, transcript: string) => void;
}

export interface VoiceStoreDeps {
  props: ConversationProps;
  resources: {
    voiceSubmitRequest:
      | undefined
      | {
          botId: string;
          serverId: string;
          draft: ComposerDraft;
          queuedEdit: { deliveryId: string; originalAttachmentIds: string[] } | undefined;
        };
    voiceDisposed: boolean;
    voiceRequestGeneration: number;
    voiceRecorder: Pick<MediaRecorder, "state" | "stop"> | undefined;
    voiceStream: { getTracks(): Array<Pick<MediaStreamTrack, "stop">> } | undefined;
    voiceRecordingTimer: ReturnType<typeof setTimeout> | undefined;
    voiceElapsedTimer: ReturnType<typeof setInterval> | undefined;
    voiceChunks: Blob[];
    voiceBotId: string | undefined;
    voiceServerId: string | undefined;
  };
  voicePhase: () => "idle" | "preparing" | "requesting" | "recording" | "transcribing";
  setVoicePhase: (phase: "idle" | "preparing" | "requesting" | "recording" | "transcribing") => void;
  setVoiceModelProgress: (progress: number | null) => void;
  voiceElapsedSeconds: () => number;
  setVoiceElapsedSeconds: (seconds: number) => void;
  drafts: () => Record<string, ComposerDraft>;
  setDrafts: (update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>) => void;
  setConversationErrors: (update: (current: Record<string, string>) => Record<string, string>) => void;
  setComposerError: (error: string | null) => void;
  setComposerFocusRequest: (update: (current: number) => number) => void;
  clearConversationError: (target: ConversationTarget) => void;
  setConversationError: (target: ConversationTarget, message: string) => void;
  viewIsMounted: () => boolean;
  hooks: VoiceSubmitHooks;
}

export function createVoiceStore(deps: VoiceStoreDeps) {
  const { resources } = deps;

  async function startVoiceRecording(): Promise<void> {
    const botId = deps.props.bot?.id;
    const serverId = deps.props.server?.id ?? "local";
    if (!botId || deps.voicePhase() !== "idle") return;
    const target = { botId, serverId };
    deps.clearConversationError(target);
    resources.voiceSubmitRequest = undefined;
    deps.setComposerError(null);
    const generation = ++resources.voiceRequestGeneration;
    deps.setVoicePhase("preparing");
    deps.setVoiceModelProgress(0);
    try {
      const modelStatus = await window.openbot.voice.prepareModel();
      if (resources.voiceDisposed || resources.voiceRequestGeneration !== generation) return;
      if (modelStatus.phase !== "ready") {
        deps.setVoicePhase("idle");
        deps.setVoiceModelProgress(null);
        deps.setConversationError(target, modelStatus.message ?? "Could not prepare the voice model.");
        return;
      }
      if (!deps.viewIsMounted()) {
        deps.setVoicePhase("idle");
        deps.setVoiceModelProgress(null);
        return;
      }
      deps.setVoicePhase("requesting");
      deps.setVoiceModelProgress(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (resources.voiceDisposed || !deps.viewIsMounted() || resources.voiceRequestGeneration !== generation) {
        for (const track of stream.getTracks()) track.stop();
        if (!resources.voiceDisposed && resources.voiceRequestGeneration === generation) deps.setVoicePhase("idle");
        return;
      }
      const recorder = new MediaRecorder(stream);
      resources.voiceStream = stream;
      resources.voiceRecorder = recorder;
      resources.voiceBotId = botId;
      resources.voiceServerId = serverId;
      resources.voiceChunks = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) resources.voiceChunks.push(event.data);
      });
      recorder.addEventListener("stop", () => void finishVoiceRecording(recorder.mimeType));
      recorder.start();
      startVoiceElapsedTimer();
      deps.setVoicePhase("recording");
      resources.voiceRecordingTimer = setTimeout(stopVoiceRecording, VOICE_AUDIO_LIMITS.maximumSeconds * 1_000);
    } catch (error) {
      if (resources.voiceRequestGeneration === generation) deps.setVoicePhase("idle");
      deps.setConversationError(target, voiceCaptureError(error));
    }
  }

  const removeVoiceModelListener = window.openbot.voice.onModelStatus((status) => {
    if (deps.voicePhase() !== "preparing") return;
    deps.setVoiceModelProgress(status.progress);
  });
  onCleanup(removeVoiceModelListener);

  function stopVoiceRecording(): void {
    if (deps.voicePhase() !== "recording" || !resources.voiceRecorder) return;
    deps.setVoicePhase("transcribing");
    stopVoiceElapsedTimer();
    if (resources.voiceRecordingTimer) clearTimeout(resources.voiceRecordingTimer);
    resources.voiceRecordingTimer = undefined;
    resources.voiceRecorder.stop();
    stopVoiceStream();
  }

  async function finishVoiceRecording(mimeType: string): Promise<void> {
    const targetBotId = resources.voiceBotId;
    const targetServerId = resources.voiceServerId;
    const chunks = resources.voiceChunks;
    const submitRequest = resources.voiceSubmitRequest;
    resources.voiceRecorder = undefined;
    resources.voiceBotId = undefined;
    resources.voiceServerId = undefined;
    resources.voiceChunks = [];
    resources.voiceSubmitRequest = undefined;
    if (!targetBotId || !targetServerId || resources.voiceDisposed) return;
    const analytics = desktopAnalytics.scope();
    const audioDurationSeconds = deps.voiceElapsedSeconds();
    const startedAt = performance.now();
    try {
      if (chunks.length === 0) throw new Error("No speech was recorded.");
      const audio = await recordingToWav(new Blob(chunks, { type: mimeType }));
      const result = await window.openbot.voice.transcribe({ audio });
      if (!result.text.trim()) throw new Error("No speech was detected.");
      analytics.track("voice_transcription", {
        result: "succeeded",
        audio_duration_seconds: audioDurationSeconds,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      if (resources.voiceDisposed) return;
      const recordingTarget = { botId: targetBotId, serverId: targetServerId };
      deps.clearConversationError(recordingTarget);
      const draft = submitRequest?.draft ?? deps.drafts()[composerDraftKey(recordingTarget)] ?? EMPTY_DRAFT;
      const transcribedDraft = { ...draft, text: appendVoiceTranscript(draft.text, result.text) };
      if (submitRequest) {
        const target = { botId: submitRequest.botId, serverId: submitRequest.serverId };
        let delivered: boolean;
        if (submitRequest.queuedEdit) {
          delivered = await deps.hooks.saveEdit(
            transcribedDraft,
            {
              ...target,
              ...submitRequest.queuedEdit,
            },
            submitRequest.draft,
          );
        } else {
          delivered = await deps.hooks.submit(transcribedDraft, target, submitRequest.draft);
        }
        if (!delivered) deps.hooks.restoreTranscript(target, result.text);
      } else {
        const key = composerDraftKey(recordingTarget);
        deps.setDrafts((current) => ({ ...current, [key]: transcribedDraft }));
        if (deps.props.bot?.id === targetBotId && (deps.props.server?.id ?? "local") === targetServerId) {
          deps.setComposerFocusRequest((current) => current + 1);
        }
      }
    } catch (error) {
      analytics.track("voice_transcription", {
        result: "failed",
        audio_duration_seconds: audioDurationSeconds,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        failure_code: "transcription_failed",
      });
      if (!resources.voiceDisposed) {
        const target = { botId: targetBotId, serverId: targetServerId };
        deps.setConversationErrors((current) => ({
          ...current,
          [composerDraftKey(target)]: voiceTranscriptionError(error),
        }));
      }
    } finally {
      if (!resources.voiceDisposed) deps.setVoicePhase("idle");
    }
  }

  function stopVoiceStream(): void {
    for (const track of resources.voiceStream?.getTracks() ?? []) track.stop();
    resources.voiceStream = undefined;
  }

  function startVoiceElapsedTimer(): void {
    stopVoiceElapsedTimer();
    const startedAt = Date.now();
    deps.setVoiceElapsedSeconds(0);
    resources.voiceElapsedTimer = setInterval(() => {
      deps.setVoiceElapsedSeconds(
        Math.min(VOICE_AUDIO_LIMITS.maximumSeconds, Math.floor((Date.now() - startedAt) / 1_000)),
      );
    }, 250);
  }

  function stopVoiceElapsedTimer(): void {
    if (resources.voiceElapsedTimer) clearInterval(resources.voiceElapsedTimer);
    resources.voiceElapsedTimer = undefined;
  }

  return {
    startVoiceRecording,
    stopVoiceRecording,
    finishVoiceRecording,
    stopVoiceStream,
    startVoiceElapsedTimer,
    stopVoiceElapsedTimer,
  };
}

export type VoiceStore = ReturnType<typeof createVoiceStore>;
