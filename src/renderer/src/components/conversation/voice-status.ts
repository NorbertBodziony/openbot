export type VoicePhase = "idle" | "requesting" | "recording" | "transcribing";

export function voiceButtonLabel(phase: VoicePhase) {
  if (phase === "recording") return "Stop voice recording";
  if (phase === "requesting") return "Requesting microphone access";
  if (phase === "transcribing") return "Transcribing voice prompt";
  return "Create prompt with voice";
}

export function formatVoiceDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function voiceCaptureError(error: unknown) {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "Microphone access is blocked. Allow OpenBot to use the microphone in system settings.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") return "No microphone is available.";
  return "OpenBot could not start voice recording.";
}

export function voiceTranscriptionError(error: unknown): string {
  return error instanceof Error ? error.message : "OpenBot could not transcribe this recording.";
}
