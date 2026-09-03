// The local Whisper model and dictation.

import { IPC_CHANNELS, type VoiceModelStatus, type VoiceTranscriptionResult } from "@openbot/contracts/ipc";
import { handleTrusted } from "../trusted-ipc";
import type { VoiceTranscriptionService } from "../voice-transcription-service";
import { parseVoiceTranscription } from "./voice-inputs";

export interface VoiceIpcDependencies {
  voice: VoiceTranscriptionService;
}

export function registerVoiceIpcHandlers({ voice }: VoiceIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.voiceGetModelStatus, (): Promise<VoiceModelStatus> => voice.getModelStatus());
  handleTrusted(IPC_CHANNELS.voicePrepareModel, (): Promise<VoiceModelStatus> => voice.prepareModel());
  handleTrusted(
    IPC_CHANNELS.voiceTranscribe,
    parseVoiceTranscription,
    (transcription): Promise<VoiceTranscriptionResult> => voice.transcribe(transcription.audio),
  );
}
