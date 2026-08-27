import type { UpdateStatus } from "@openbot/contracts/ipc";

export interface UpdateStatusPresentation {
  actionLabel: string;
  available: boolean;
  busy: boolean;
  detail: string;
  supported: boolean;
}

export function presentUpdateStatus(status: UpdateStatus): UpdateStatusPresentation {
  const available = ["available", "downloading", "preparing", "ready", "installing"].includes(status.phase);
  const busy = ["checking", "downloading", "preparing", "installing"].includes(status.phase);
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
    case "preparing":
      actionLabel = "Preparing update…";
      break;
    case "ready":
      actionLabel = "Restart to update";
      break;
    case "installing":
      actionLabel = "Restarting…";
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
