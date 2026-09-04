import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { createMemo, Show } from "solid-js";
import { TypingDots } from "./TypingDots";
import { Gauge, UserAvatar } from "./ui";

interface StaticAccountDockProps {
  account: CentralAuthUser;
  compact: boolean;
  hybrid: boolean;
  withServerRail: boolean;
}

export function StaticAccountDock(props: StaticAccountDockProps) {
  const accountName = createMemo(
    () => props.account.name?.trim() || props.account.email.split("@")[0] || props.account.email,
  );
  return (
    <div
      class={[
        "account-dock account-dock-static",
        {
          "account-dock-with-server-rail": props.withServerRail,
          "account-dock-compact": props.compact,
          "account-dock-hybrid": props.hybrid,
        },
      ]}
    >
      <Show
        when={props.hybrid}
        fallback={
          <div class="account-dock-trigger">
            <UserAvatar user={props.account} class="account-dock-avatar" decorative />
            <span class="account-dock-copy">
              <strong title={accountName()}>{accountName()}</strong>
              <span title={props.account.email}>{props.account.email}</span>
            </span>
          </div>
        }
      >
        <div class="account-dock-hybrid-shelf">
          <div class="account-dock-hybrid-identity">
            <span class="account-dock-avatar-frame">
              <UserAvatar user={props.account} class="account-dock-avatar" decorative />
            </span>
            <span class="account-dock-copy">
              <strong title={accountName()}>{accountName()}</strong>
              <span title={props.account.email}>{props.account.email}</span>
            </span>
          </div>
          <span class="account-dock-usage-trigger" aria-hidden="true">
            <span class="account-dock-usage-chip">
              <Gauge aria-hidden="true" />
              <strong>
                <TypingDots class="account-dock-usage-loading" />
              </strong>
            </span>
          </span>
          <span class="account-dock-icon-button" aria-hidden="true" />
        </div>
      </Show>
    </div>
  );
}
