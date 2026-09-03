// The cloud account: email sign-in, profile, and the mobile devices connected to it.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import type { CentralAuthManager } from "../central-auth-manager";
import { handleTrusted } from "../trusted-ipc";
import { parseEmailCodeVerification, parseProfileName } from "./app-inputs";
import { parseAvatarImage } from "./avatar-inputs";
import { stringPayload } from "./validation";
// The cloud account: email sign-in, profile, and the mobile devices connected to it.

export interface AccountIpcDependencies {
  centralAuth: CentralAuthManager;
}

export function registerAccountIpcHandlers({ centralAuth }: AccountIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.authGetState, () => centralAuth.getState());
  handleTrusted(IPC_CHANNELS.authRetry, () => centralAuth.retry());
  handleTrusted(IPC_CHANNELS.authRequestEmailCode, stringPayload("email", INPUT_LIMITS.email), (email) =>
    centralAuth.requestEmailCode(email),
  );
  handleTrusted(IPC_CHANNELS.authVerifyEmailCode, parseEmailCodeVerification, (verification) =>
    centralAuth.verifyEmailCode(verification.challengeId, verification.code),
  );
  handleTrusted(IPC_CHANNELS.authUpdateName, parseProfileName, (name) => centralAuth.updateName(name));
  handleTrusted(IPC_CHANNELS.authUpdateAvatar, parseAvatarImage, (parsed) => centralAuth.updateAvatar(parsed));
  handleTrusted(IPC_CHANNELS.authCreateMobileConnect, () => centralAuth.createMobileConnect());
  handleTrusted(IPC_CHANNELS.authListMobileConnectedDevices, () => centralAuth.listMobileConnectedDevices());
  handleTrusted(
    IPC_CHANNELS.authRevokeMobileConnectedDevice,
    stringPayload("sessionId", INPUT_LIMITS.identifier),
    (sessionId) => centralAuth.revokeMobileConnectedDevice(sessionId),
  );
  handleTrusted(IPC_CHANNELS.authLogout, () => centralAuth.logout());
}
