import type { UpdateStatus } from "@openbot/contracts/ipc";
import { isUpdateActivePhase, isUpdateBusyPhase } from "@openbot/contracts/ipc";

export interface UpdateStatusPresentation {
  actionLabel: string;
  available: boolean;
  busy: boolean;
  detail: string;
  supported: boolean;
}

export function presentUpdateStatus(status: UpdateStatus): UpdateStatusPresentation {
  const available = isUpdateActivePhase(status.phase);
  const busy = isUpdateBusyPhase(status.phase);
  let actionLabel = "Check for updates";

  switch (status.phase) {
    case "checking":
      actionLabel = "Checking for updates…";
      break;
    case "available":
      actionLabel = "Download update";
      break;
    case "downloading":
      actionLabel = "Downloading update…";
      break;
    case "ready":
      actionLabel = "Restart to update";
      break;
    case "installing":
      actionLabel = "Restarting…";
      break;
    case "error":
      // A failed stage is retried in place, so the label has to name that stage rather than send the
      // user back through another check.
      if (status.errorCode === "download_failed") actionLabel = "Retry download";
      else if (status.errorCode === "install_failed") actionLabel = "Retry restart";
      break;
  }

  let detail = "";
  if (status.phase === "downloading" && status.progress !== null) detail = `${Math.round(status.progress)}%`;
  else if (status.availableVersion) detail = `v${status.availableVersion}`;
  else if (status.phase === "up-to-date") detail = "Up to date";
  else if (status.currentVersion) detail = `v${status.currentVersion}`;

  return {
    actionLabel,
    available,
    busy,
    detail,
    supported: status.phase !== "unsupported",
  };
}
