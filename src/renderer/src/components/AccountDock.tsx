import type {
  AccountUsage,
  AgentStatus,
  AppInfo,
  CentralAuthUser,
  ExternalDestination,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { presentUpdateStatus } from "../update-status";
import {
  Badge,
  Button,
  buttonVariants,
  CalendarClock,
  ChevronUp,
  CircleArrowDown,
  Gauge,
  LogOut,
  Mail,
  Megaphone,
  Popover,
  Progress,
  Puzzle,
  RadialProgress,
  RefreshCw,
  Settings,
  ShieldCheck,
  Tooltip,
} from "./ui";

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
  onLogout: () => Promise<void>;
  onOpenExternal: (destination: ExternalDestination) => Promise<void>;
  onOpenPermissions: () => void;
  onOpenSettings: (trigger: HTMLElement) => void;
  onOpenSkills: () => void;
}

export function AccountDock(props: AccountDockProps) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [usageOpen, setUsageOpen] = createSignal(false);
  const [usageTooltipOpen, setUsageTooltipOpen] = createSignal(false);
  const [usageLoading, setUsageLoading] = createSignal(false);
  const [usageRefreshAcknowledging, setUsageRefreshAcknowledging] = createSignal(false);
  const [usageError, setUsageError] = createSignal<string | null>(null);
  const [menuError, setMenuError] = createSignal<string | null>(null);
  const [avatarFailed, setAvatarFailed] = createSignal(false);
  const [loggingOut, setLoggingOut] = createSignal(false);
  let initialUsageRequested = false;
  let usageRefreshTimer: number | undefined;
  let legacyTrigger: HTMLButtonElement | undefined;
  let menuTrigger: HTMLButtonElement | undefined;
  let usageTrigger: HTMLButtonElement | undefined;
  let settingsTrigger: HTMLButtonElement | undefined;

  const hybridLayout = createMemo(() => props.appInfo?.platform === "darwin" && props.withServerRail && !props.compact);
  const accountName = createMemo(
    () => props.account.name?.trim() || props.account.email.split("@")[0] || props.account.email,
  );
  const accountInitials = createMemo(() => {
    const localPart = props.account.email.split("@")[0] ?? "OpenBot";
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
  const usageValue = createMemo(() => weeklyUsageRemaining() ?? 0);
  const usageTone = createMemo(() => {
    const remaining = weeklyUsageRemaining();
    if (remaining === null || remaining >= 30) return "neutral";
    return remaining < 10 ? "critical" : "warning";
  });
  const usageRadialTone = createMemo(() => {
    const tone = usageTone();
    if (tone === "critical") return "danger";
    return tone === "warning" ? "warning" : "accent";
  });
  const usageButtonLabel = createMemo(() => {
    if (usageLoading() && weeklyUsageRemaining() === null) return "Weekly usage is loading";
    if (weeklyUsageRemaining() === null) return "Weekly usage unavailable";
    return `Weekly usage, ${weeklyUsageRemaining()}% left`;
  });
  const usageRefreshActive = createMemo(() => usageLoading() || usageRefreshAcknowledging());
  const weeklyUsageReset = createMemo(() => {
    const resetsAt = weeklyUsage()?.resetsAt;
    if (resetsAt === null || resetsAt === undefined) return null;
    const date = new Date(resetsAt * 1_000);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  });
  const updatePresentation = createMemo(() => presentUpdateStatus(props.updateStatus));
  const accountMenuError = createMemo(
    () => menuError() ?? (props.updateStatus.phase === "error" ? props.updateStatus.message : null),
  );

  createEffect(
    () => props.account.avatarUrl,
    () => {
      setAvatarFailed(false);
    },
  );

  onCleanup(() => {
    if (usageRefreshTimer !== undefined) window.clearTimeout(usageRefreshTimer);
  });

  createEffect(
    () => [hybridLayout(), props.agentStatus.phase, props.accountUsage] as const,
    ([hybrid, agentPhase, accountUsage]) => {
      if (!hybrid || agentPhase !== "ready" || accountUsage || initialUsageRequested) return;
      initialUsageRequested = true;
      void refreshUsage();
    },
  );

  function restoreFocusWhenDockIsIdle(target: HTMLButtonElement | undefined) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (target?.isConnected && !menuOpen() && !usageOpen() && document.activeElement === document.body) {
          target.focus();
        }
      });
    });
  }

  async function refreshUsage() {
    if (usageLoading() || props.agentStatus.phase !== "ready") return;
    setUsageLoading(true);
    setUsageError(null);
    try {
      await props.onRefreshUsage();
    } catch (cause) {
      setUsageError(cause instanceof Error ? cause.message : "Usage is unavailable.");
    } finally {
      setUsageLoading(false);
    }
  }

  function refreshUsageWithFeedback() {
    if (usageRefreshActive()) return;
    setUsageRefreshAcknowledging(true);
    if (usageRefreshTimer !== undefined) window.clearTimeout(usageRefreshTimer);
    usageRefreshTimer = window.setTimeout(() => {
      usageRefreshTimer = undefined;
      setUsageRefreshAcknowledging(false);
    }, 600);
    void refreshUsage();
  }

  function openExternal(destination: ExternalDestination) {
    setMenuError(null);
    void props
      .onOpenExternal(destination)
      .then(() => setMenuOpen(false))
      .catch((cause) => setMenuError(cause instanceof Error ? cause.message : "Could not open the link."));
  }

  function runUpdateAction() {
    setMenuError(null);
    void props
      .onUpdateAction()
      .catch((cause) => setMenuError(cause instanceof Error ? cause.message : "Could not update OpenBot."));
  }

  async function logout() {
    if (loggingOut()) return;
    setLoggingOut(true);
    setMenuError(null);
    try {
      await props.onLogout();
    } catch (cause) {
      setMenuError(cause instanceof Error ? cause.message : "Could not sign out.");
      setLoggingOut(false);
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

  function accountMenu() {
    return (
      <>
        <section class="account-menu-group" aria-label="OpenBot">
          <Show when={props.updateStatus.phase !== "unsupported"}>
            <Button
              variant="ghost"
              type="button"
              class="account-menu-row"
              onClick={runUpdateAction}
              disabled={updatePresentation().busy}
            >
              <CircleArrowDown
                class={updatePresentation().busy ? "account-menu-icon account-menu-icon-spinning" : "account-menu-icon"}
                aria-hidden="true"
              />
              <span>{updatePresentation().actionLabel}</span>
              <small>{updatePresentation().detail}</small>
            </Button>
          </Show>
          <Button
            variant="ghost"
            type="button"
            class="account-menu-row"
            onClick={() => {
              setMenuOpen(false);
              props.onOpenSkills();
            }}
          >
            <Puzzle class="account-menu-icon" aria-hidden="true" />
            <span>Marketplace</span>
          </Button>
          <Button
            variant="ghost"
            type="button"
            class="account-menu-row"
            onClick={() => {
              setMenuOpen(false);
              props.onOpenPermissions();
            }}
          >
            <ShieldCheck class="account-menu-icon" aria-hidden="true" />
            <span>Providers &amp; permissions</span>
          </Button>
        </section>

        <div class="account-menu-separator" />
        <section class="account-menu-group" aria-label="Help">
          <Button variant="ghost" type="button" class="account-menu-row" onClick={() => openExternal("feedback")}>
            <Megaphone class="account-menu-icon" aria-hidden="true" />
            <span>Send feedback</span>
          </Button>
          <Button variant="ghost" type="button" class="account-menu-row" onClick={() => openExternal("message")}>
            <Mail class="account-menu-icon" aria-hidden="true" />
            <span>Message</span>
          </Button>
        </section>

        <div class="account-menu-separator" />
        <Button
          variant="ghost"
          type="button"
          class="account-menu-row account-menu-danger"
          onClick={() => void logout()}
          disabled={loggingOut()}
        >
          <LogOut class="account-menu-icon" aria-hidden="true" />
          <span>{loggingOut() ? "Signing out…" : "Sign out"}</span>
        </Button>
        <Show when={accountMenuError()}>{(message) => <p class="account-popover-error">{message()}</p>}</Show>
      </>
    );
  }

  function legacyDock() {
    return (
      <Popover.Root
        open={menuOpen()}
        onOpenChange={(nextOpen) => {
          setMenuOpen(nextOpen);
          if (nextOpen) {
            setMenuError(null);
          } else {
            restoreFocusWhenDockIsIdle(legacyTrigger);
          }
        }}
        placement="top-start"
        gutter={8}
      >
        <Popover.Trigger
          ref={(element) => (legacyTrigger = element)}
          as="button"
          type="button"
          class={buttonVariants({ variant: "ghost", class: "account-dock-trigger" })}
          aria-label="Open account menu"
          aria-expanded={menuOpen() ? "true" : "false"}
        >
          {avatar("account-dock-avatar")}
          <span class="account-dock-copy">
            <strong title={accountName()}>{accountName()}</strong>
            <span title={props.account.email}>{props.account.email}</span>
            <Show when={props.appInfo}>
              {(info) => (
                <span class="sr-only" data-testid="app-version">
                  Version {info().version} · {info().platform}
                </span>
              )}
            </Show>
          </span>
          <Show when={updatePresentation().available}>
            <Badge class="sidebar-update-pill" tone="accent" shape="pill">
              Update
            </Badge>
            <span class="sr-only">OpenBot update available</span>
          </Show>
          <ChevronUp class="account-dock-chevron" aria-hidden="true" />
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            class="ui-popover-menu-surface account-popover"
            aria-hidden={menuOpen() ? undefined : "true"}
          >
            <Popover.Title class="sr-only">Account actions</Popover.Title>
            {accountMenu()}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }

  function hybridDock() {
    return (
      <div class="account-dock-hybrid-shelf">
        <Popover.Root
          open={menuOpen()}
          onOpenChange={(nextOpen) => {
            setMenuOpen(nextOpen);
            if (nextOpen) {
              setUsageOpen(false);
              setMenuError(null);
            } else {
              restoreFocusWhenDockIsIdle(menuTrigger);
            }
          }}
          placement="top-start"
          gutter={10}
        >
          <Popover.Trigger
            ref={(element) => (menuTrigger = element)}
            as="button"
            type="button"
            class={buttonVariants({ variant: "ghost", class: "account-dock-hybrid-identity" })}
            aria-label="Open account actions"
            aria-expanded={menuOpen() ? "true" : "false"}
          >
            <span class="account-dock-avatar-frame">{avatar("account-dock-avatar")}</span>
            <span class="account-dock-copy">
              <strong title={accountName()}>{accountName()}</strong>
              <span title={props.account.email}>{props.account.email}</span>
              <Show when={props.appInfo}>
                {(info) => (
                  <span class="sr-only" data-testid="app-version">
                    Version {info().version} · {info().platform}
                  </span>
                )}
              </Show>
              <Show when={updatePresentation().available}>
                <span class="sr-only">OpenBot update available</span>
              </Show>
            </span>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              class="ui-popover-menu-surface account-popover"
              aria-hidden={menuOpen() ? undefined : "true"}
            >
              <Popover.Title class="sr-only">Account actions</Popover.Title>
              {accountMenu()}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <Tooltip.Root
          open={usageTooltipOpen()}
          onOpenChange={(nextOpen) => setUsageTooltipOpen(usageOpen() ? false : nextOpen)}
          openDelay={250}
          closeDelay={75}
          placement="top"
          gutter={8}
        >
          <Tooltip.Trigger as="div" class="account-dock-tooltip-trigger">
            <Popover.Root
              open={usageOpen()}
              onOpenChange={(nextOpen) => {
                setUsageOpen(nextOpen);
                if (nextOpen) {
                  setUsageTooltipOpen(false);
                  setMenuOpen(false);
                  if (!props.accountUsage && !usageLoading()) void refreshUsage();
                } else {
                  restoreFocusWhenDockIsIdle(usageTrigger);
                }
              }}
              placement="top-end"
              gutter={10}
            >
              <Popover.Trigger
                ref={(element) => (usageTrigger = element)}
                as="button"
                type="button"
                class={buttonVariants({ variant: "ghost", class: "account-dock-usage-trigger" })}
                aria-label={usageButtonLabel()}
                aria-expanded={usageOpen() ? "true" : "false"}
                data-usage-tone={usageTone()}
                style={{ "--account-usage-value": `${usageValue()}%` }}
              >
                <span class="account-dock-usage-chip">
                  <Gauge aria-hidden="true" />
                  <strong>{weeklyUsageRemaining() === null ? "—" : `${weeklyUsageRemaining()}%`}</strong>
                </span>
                <span class="account-dock-usage-ring" aria-hidden="true">
                  <span>{weeklyUsageRemaining() === null ? "—" : weeklyUsageRemaining()}</span>
                </span>
                <span class="account-dock-usage-bar" aria-hidden="true">
                  <strong>{weeklyUsageRemaining() === null ? "—" : `${weeklyUsageRemaining()}%`}</strong>
                  <Progress value={usageValue()} />
                </span>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  class="ui-popover-menu-surface account-usage-popover"
                  aria-hidden={usageOpen() ? undefined : "true"}
                >
                  <header class="account-usage-popover-header">
                    <div class="account-usage-popover-heading">
                      <Gauge aria-hidden="true" />
                      <Popover.Title class="account-usage-popover-title">Weekly usage</Popover.Title>
                    </div>
                    <Button
                      variant="ghost"
                      type="button"
                      size="icon-sm"
                      class="account-usage-refresh"
                      aria-label={usageRefreshActive() ? "Refreshing" : usageError() ? "Try again" : "Refresh"}
                      title="Refresh usage"
                      onClick={refreshUsageWithFeedback}
                      disabled={usageRefreshActive() || props.agentStatus.phase !== "ready"}
                    >
                      <RefreshCw
                        class={usageRefreshActive() ? "account-menu-icon-spinning" : undefined}
                        aria-hidden="true"
                      />
                    </Button>
                  </header>
                  <div class="account-usage-popover-meter">
                    <RadialProgress
                      value={usageValue()}
                      tone={usageRadialTone()}
                      aria-label="Weekly usage remaining"
                      aria-valuetext={
                        usageLoading() && weeklyUsageRemaining() === null
                          ? "Loading"
                          : weeklyUsageRemaining() === null
                            ? "Unavailable"
                            : `${weeklyUsageRemaining()}% left`
                      }
                    >
                      <strong>
                        {usageLoading() && weeklyUsageRemaining() === null
                          ? "…"
                          : weeklyUsageRemaining() === null
                            ? "—"
                            : `${weeklyUsageRemaining()}%`}
                      </strong>
                    </RadialProgress>
                  </div>
                  <div class="account-usage-popover-reset">
                    <CalendarClock aria-hidden="true" />
                    <span>Resets</span>
                    <strong>
                      {weeklyUsageReset() ? weeklyUsageReset() : usageLoading() ? "Checking…" : "Unavailable"}
                    </strong>
                  </div>
                  <Show when={usageError()}>{(message) => <p class="account-usage-popover-error">{message()}</p>}</Show>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="account-dock-tooltip">Weekly usage</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>

        <Tooltip.Root openDelay={250} closeDelay={75} placement="top" gutter={8}>
          <Tooltip.Trigger as="div" class="account-dock-tooltip-trigger">
            <Button
              ref={(element) => (settingsTrigger = element)}
              variant="ghost"
              type="button"
              class="account-dock-icon-button"
              aria-label="Settings"
              onClick={() => {
                setMenuOpen(false);
                setUsageOpen(false);
                if (settingsTrigger) props.onOpenSettings(settingsTrigger);
              }}
            >
              <Settings aria-hidden="true" />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="account-dock-tooltip">Settings</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </div>
    );
  }

  return (
    <div
      class={[
        "account-dock",
        {
          "account-dock-with-server-rail": props.withServerRail,
          "account-dock-compact": props.compact,
          "account-dock-hybrid": hybridLayout(),
        },
      ]}
    >
      <Show when={hybridLayout()} fallback={legacyDock()}>
        {hybridDock()}
      </Show>
    </div>
  );
}
