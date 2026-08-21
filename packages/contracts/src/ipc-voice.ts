export const VOICE_AUDIO_LIMITS = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  maximumSeconds: 120,
  maximumWavBytes: 3_840_044,
} as const;

export interface VoiceTranscriptionInput {
  audio: Uint8Array;
}

export interface VoiceTranscriptionResult {
  text: string;
}
