// The macOS screen-recording and accessibility permission flow.

import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import type { ComputerUseMacSetupWindowController } from "../computer-use-mac-setup-window";
import { handleTrusted, handleTrustedWithEvent } from "../trusted-ipc";
import { parseMacPermission } from "./app-inputs";

export interface ComputerUseIpcDependencies {
  computerUseMacSetup: ComputerUseMacSetupWindowController;
}

export function registerComputerUseIpcHandlers({ computerUseMacSetup }: ComputerUseIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.computerUseGetMacSetupState, () => computerUseMacSetup.getState());
  handleTrusted(IPC_CHANNELS.computerUseOpenMacPermissionSetup, parseMacPermission, (parsed) =>
    computerUseMacSetup.open(parsed),
  );
  handleTrustedWithEvent(IPC_CHANNELS.computerUseStartHelperDrag, (event) =>
    computerUseMacSetup.startDrag(event.sender),
  );
  handleTrusted(IPC_CHANNELS.computerUseRevealHelper, () => computerUseMacSetup.revealHelper());
  handleTrusted(IPC_CHANNELS.computerUseCloseMacPermissionSetup, () => computerUseMacSetup.close());
}
