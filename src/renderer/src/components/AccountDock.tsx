import type {
  AccountUsage,
  AgentStatus,
  AppInfo,
  AvatarImageInput,
  CentralAuthUser,
  ExternalDestination,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { normalizeAvatarFile } from "../avatar-image";
import { Badge, Button, buttonVariants, Input, Popover } from "./ui";

interface AccountDockProps {
  account: CentralAuthUser;
  appInfo: AppInfo | null;
  agentStatus: AgentStatus;
  accountUsage: AccountUsage | null;
  updateStatus: UpdateStatus;
  compact: boolean;
  withServerRail: boolean;
  onRefreshUsage: () => Promise<AccountUsage>;
  onUpdateAction: () => Promise<void>;
  onUpdateAccountAvatar: (image: AvatarImageInput | null) => Promise<void>;
  onLogout: () => Promise<void>;
  onOpenExternal: (destination: ExternalDestination) => Promise<void>;
  onOpenPermissions: () => void;
}

function UsageIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M4.2 13.9a6.5 6.5 0 1 1 11.6 0" />
      <path d="m10 10 3.1-2.3" />
      <circle cx="10" cy="10" r="1" class="account-menu-icon-fill" />
    </svg>
  );
}

function FeedbackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M4 5.2h12v8.6H9l-3.5 2.4v-2.4H4V5.2Z" />
      <path d="M7 8.2h6M7 10.8h4" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M3.8 4.8h12.4v10.4H3.8V4.8Z" />
      <path d="m4.5 5.6 5.5 4.2 5.5-4.2" />
    </svg>
  );
}

function UpdateIcon(props: { active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      class={["account-menu-icon", { "account-menu-icon-spinning": props.active }]}
    >
      <path d="M15.4 6.8A6 6 0 1 0 16 10" />
      <path d="M15.4 3.8v3h-3" />
    </svg>
  );
}

function PermissionsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M10 2.9 15.5 5v4.6c0 3.6-2.2 6.3-5.5 7.5-3.3-1.2-5.5-3.9-5.5-7.5V5L10 2.9Z" />
      <path d="m7.6 9.9 1.5 1.5 3.3-3.4" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-menu-icon">
      <path d="M8.2 4.2H5.5v11.6h2.7" />
      <path d="M11.6 6.6 15 10l-3.4 3.4M7.8 10H15" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M6.5 6.2 7.7 4.5h4.6l1.2 1.7h2.1v9.3H4.4V6.2h2.1Z" />
      <circle cx="10" cy="10.8" r="2.5" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="account-dock-chevron">
      <path d="m6.5 12 3.5-3.5 3.5 3.5" />
    </svg>
  );
}

export function AccountDock(props: AccountDockProps) {
  const [open, setOpen] = createSignal(false);
  const [usageLoading, setUsageLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [avatarBusy, setAvatarBusy] = createSignal(false);
  const [avatarFailed, setAvatarFailed] = createSignal(false);
  const [loggingOut, setLoggingOut] = createSignal(false);
  let avatarInput: HTMLInputElement | undefined;

  const accountName = createMemo(() => props.account.name?.trim() || props.account.email);
  const accountInitials = createMemo(() => {
    const localPart = accountName().split("@")[0] ?? "OpenBot";
    const parts = localPart.split(/[._\-\s]+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : localPart.slice(0, 2)).toUpperCase();
  });
  const weeklyUsage = createMemo(() => {
    const limit =
      props.accountUsage?.limits.find((candidate) => candidate.id === "codex") ?? props.accountUsage?.limits[0];
    if (!limit) return null;
    return (
      [limit.primary, limit.secondary].find((window) => window?.windowDurationMins === 10_080) ??
      limit.secondary ??
      limit.primary
    );
  });
  const weeklyUsageRemaining = createMemo(() => {
    const usage = weeklyUsage();
    return usage ? Math.max(0, Math.round(100 - usage.usedPercent)) : null;
  });
  const updateAvailable = createMemo(() =>
    ["available", "downloading", "ready", "installing"].includes(props.updateStatus.phase),
  );
  const updateBusy = createMemo(() => ["checking", "downloading", "installing"].includes(props.updateStatus.phase));
  const updateLabel = createMemo(() => {
    switch (props.updateStatus.phase) {
      case "checking":
        return "Checking for updates…";
      case "available":
        return "Download update";
      case "downloading":
        return "Downloading update…";
      case "ready":
        return "Restart to update";
      case "installing":
        return "Restarting…";
      default:
        return "Check for updates";
    }
  });
  const updateDetail = createMemo(() => {
    const status = props.updateStatus;
    if (status.phase === "downloading" && status.progress !== null) return `${Math.round(status.progress)}%`;
    if (status.availableVersion) return `v${status.availableVersion}`;
    if (status.phase === "up-to-date") return "Up to date";
    return status.currentVersion ? `v${status.currentVersion}` : "";
  });
  const popoverError = createMemo(
    () => error() ?? (props.updateStatus.phase === "error" ? props.updateStatus.message : null),
  );

  createEffect(
    () => props.account.avatarUrl,
    () => {
      setAvatarFailed(false);
    },
  );

  async function refreshUsage() {
    if (usageLoading() || props.agentStatus.phase !== "ready") return;
    setUsageLoading(true);
    setError(null);
    try {
      await props.onRefreshUsage();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Usage is unavailable.");
    } finally {
      setUsageLoading(false);
    }
  }

  function openExternal(destination: ExternalDestination) {
    setError(null);
    void props
      .onOpenExternal(destination)
      .then(() => setOpen(false))
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not open the link."));
  }

  function runUpdateAction() {
    setError(null);
    void props
      .onUpdateAction()
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not update OpenBot."));
  }

  async function logout() {
    if (loggingOut()) return;
    setLoggingOut(true);
    setError(null);
    try {
      await props.onLogout();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out.");
      setLoggingOut(false);
    }
  }

  async function updateAvatar(image: AvatarImageInput | null) {
    if (avatarBusy()) return;
    setAvatarBusy(true);
    setError(null);
    try {
      await props.onUpdateAccountAvatar(image);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update your avatar.");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function uploadAvatar(file: File | undefined) {
    if (!file) return;
    setAvatarBusy(true);
    setError(null);
    try {
      await props.onUpdateAccountAvatar(await normalizeAvatarFile(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update your avatar.");
    } finally {
      setAvatarBusy(false);
      if (avatarInput) avatarInput.value = "";
    }
  }

  function avatar(className: string) {
    return (
      <span class={className} aria-hidden="true">
        <Show
          when={props.account.avatarUrl && !avatarFailed() ? props.account.avatarUrl : null}
          fallback={accountInitials()}
        >
          {(avatarUrl) => <img src={avatarUrl()} alt="" onError={() => setAvatarFailed(true)} />}
        </Show>
      </span>
    );
  }

  return (
    <div
      class={[
        "account-dock",
        {
          "account-dock-with-server-rail": props.withServerRail,
          "account-dock-compact": props.compact,
        },
      ]}
    >
      <Popover.Root
        open={open()}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            setError(null);
            void refreshUsage();
          }
        }}
        placement="top-start"
        gutter={8}
      >
        <Popover.Trigger
          as="button"
          type="button"
          class={buttonVariants({ variant: "ghost", class: "account-dock-trigger" })}
          aria-label="Open account menu"
          aria-expanded={open() ? "true" : "false"}
        >
          {avatar("account-dock-avatar")}
          <span class="account-dock-copy">
            <strong>{accountName()}</strong>
            <Show when={props.account.name?.trim()}>
              <span>{props.account.email}</span>
            </Show>
            <Show when={props.appInfo}>
              {(info) => (
                <span class="sr-only" data-testid="app-version">
                  Version {info().version} · {info().platform}
                </span>
              )}
            </Show>
          </span>
          <Show when={updateAvailable()}>
            <Badge class="sidebar-update-pill" tone="accent" shape="pill">
              Update
            </Badge>
            <span class="sr-only">OpenBot update available</span>
          </Show>
          <ChevronIcon />
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content class="account-popover" aria-hidden={open() ? undefined : "true"}>
            <Popover.Title class="sr-only">Account</Popover.Title>
            <div class="account-profile-card">
              <Input
                ref={(element) => (avatarInput = element)}
                class="sr-only"
                type="file"
                aria-label="Account profile photo"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => void uploadAvatar(event.currentTarget.files?.[0])}
              />
              <Button
                variant="ghost"
                type="button"
                class="account-profile-photo"
                aria-label={props.account.avatarUrl ? "Replace photo" : "Upload photo"}
                onClick={() => avatarInput?.click()}
                disabled={avatarBusy()}
              >
                {avatar("account-profile-avatar")}
                <span class="account-profile-photo-action">
                  <CameraIcon />
                </span>
              </Button>
              <div class="account-profile-copy">
                <strong>{accountName()}</strong>
                <Show when={props.account.name?.trim()}>
                  <span>{props.account.email}</span>
                </Show>
                <Show when={props.account.avatarUrl}>
                  <Button
                    variant="ghost"
                    type="button"
                    class="account-profile-remove"
                    onClick={() => void updateAvatar(null)}
                    disabled={avatarBusy()}
                  >
                    Remove photo
                  </Button>
                </Show>
              </div>
            </div>

            <div class="account-menu-separator" />
            <Show when={props.updateStatus.phase !== "unsupported"}>
              <Button
                variant="ghost"
                type="button"
                class="account-menu-row account-update-row"
                onClick={runUpdateAction}
                disabled={updateBusy()}
              >
                <UpdateIcon active={updateBusy()} />
                <span>{updateLabel()}</span>
                <small>{updateDetail()}</small>
              </Button>
            </Show>
            <Button
              variant="destructive-ghost"
              type="button"
              class="account-menu-row"
              onClick={() => void refreshUsage()}
              disabled={usageLoading() || props.agentStatus.phase !== "ready"}
            >
              <UsageIcon />
              <span>{usageLoading() ? "Updating usage…" : "Weekly usage"}</span>
              <small>{weeklyUsageRemaining() === null ? "—" : `${weeklyUsageRemaining()}%`}</small>
            </Button>

            <div class="account-menu-separator" />
            <Button
              variant="ghost"
              type="button"
              class="account-menu-row"
              onClick={() => {
                setOpen(false);
                props.onOpenPermissions();
              }}
            >
              <PermissionsIcon />
              <span>Providers &amp; permissions</span>
            </Button>

            <div class="account-menu-separator" />
            <Button variant="ghost" type="button" class="account-menu-row" onClick={() => openExternal("feedback")}>
              <FeedbackIcon />
              <span>Send feedback</span>
            </Button>
            <Button variant="ghost" type="button" class="account-menu-row" onClick={() => openExternal("message")}>
              <MessageIcon />
              <span>Message</span>
            </Button>

            <div class="account-menu-separator" />
            <Button
              variant="ghost"
              type="button"
              class="account-menu-row account-menu-danger"
              onClick={() => void logout()}
              disabled={loggingOut()}
            >
              <LogoutIcon />
              <span>{loggingOut() ? "Signing out…" : "Sign out"}</span>
            </Button>
            <Show when={popoverError()}>{(message) => <p class="account-popover-error">{message()}</p>}</Show>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
