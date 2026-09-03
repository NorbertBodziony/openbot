import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { IPC_CHANNELS, type VoiceModelStatus, type VoiceTranscriptionResult } from "@openbot/contracts/ipc";
import { validateProfileName } from "@openbot/contracts/validation";
import type { CentralAuthManager } from "../central-auth-manager";
import { parseAvatarImage } from "../ipc/avatar-inputs";
import { isObject, requireString } from "../ipc/validation";
import { parseVoiceTranscription } from "../ipc/voice-inputs";
import { handleTrusted } from "../trusted-ipc";
import type { VoiceTranscriptionService } from "../voice-transcription-service";

interface VoiceAuthIpcDependencies {
  voice: VoiceTranscriptionService;
  centralAuth: CentralAuthManager;
}

export function registerVoiceAuthIpcHandlers({ voice, centralAuth }: VoiceAuthIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.voiceGetModelStatus, (): Promise<VoiceModelStatus> => voice.getModelStatus());
  handleTrusted(IPC_CHANNELS.voicePrepareModel, (): Promise<VoiceModelStatus> => voice.prepareModel());
  handleTrusted(
    IPC_CHANNELS.voiceTranscribe,
    (input: unknown): Promise<VoiceTranscriptionResult> => voice.transcribe(parseVoiceTranscription(input).audio),
  );
  handleTrusted(IPC_CHANNELS.authGetState, () => centralAuth.getState());
  handleTrusted(IPC_CHANNELS.authRetry, () => centralAuth.retry());
  handleTrusted(IPC_CHANNELS.authRequestEmailCode, (email: unknown) =>
    centralAuth.requestEmailCode(requireString(email, "email", INPUT_LIMITS.email)),
  );
  handleTrusted(IPC_CHANNELS.authVerifyEmailCode, (input: unknown) => {
    if (!isObject(input)) throw new Error("Sign-in code details are required.");
    return centralAuth.verifyEmailCode(
      requireString(input.challengeId, "challengeId", INPUT_LIMITS.identifier),
      requireString(input.code, "code", 32),
    );
  });
  handleTrusted(IPC_CHANNELS.authUpdateName, (input: unknown) => {
    const rawName = requireString(input, "name", INPUT_LIMITS.accountName);
    const validation = validateProfileName(rawName);
    if (validation.error) {
      throw new Error(
        `name must contain ${INPUT_LIMITS.profileNameMin} to ${INPUT_LIMITS.profileName} safe characters.`,
      );
    }
    return centralAuth.updateName(validation.name);
  });
  handleTrusted(IPC_CHANNELS.authUpdateAvatar, (input: unknown) => centralAuth.updateAvatar(parseAvatarImage(input)));
  handleTrusted(IPC_CHANNELS.authCreateMobileConnect, () => centralAuth.createMobileConnect());
  handleTrusted(IPC_CHANNELS.authListMobileConnectedDevices, () => centralAuth.listMobileConnectedDevices());
  handleTrusted(IPC_CHANNELS.authRevokeMobileConnectedDevice, (input: unknown) =>
    centralAuth.revokeMobileConnectedDevice(requireString(input, "sessionId", INPUT_LIMITS.identifier)),
  );
  handleTrusted(IPC_CHANNELS.authLogout, () => centralAuth.logout());
}
