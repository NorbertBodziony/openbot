// The cloud account: email sign-in, profile, and the mobile devices connected to it.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { validateProfileName } from "@openbot/contracts/validation";
import type { CentralAuthManager } from "../central-auth-manager";
import { handleTrusted } from "../trusted-ipc";
import { parseAvatarImage } from "./avatar-inputs";
import { isObject, requireString } from "./validation";

export interface AccountIpcDependencies {
  centralAuth: CentralAuthManager;
}

export function registerAccountIpcHandlers({ centralAuth }: AccountIpcDependencies): void {
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
