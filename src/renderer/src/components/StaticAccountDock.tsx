import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { createMemo } from "solid-js";
import { UserAvatar } from "./ui";

interface StaticAccountDockProps {
  account: CentralAuthUser;
  compact: boolean;
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
        },
      ]}
    >
      <div class="account-dock-trigger">
        <UserAvatar user={props.account} class="account-dock-avatar" decorative />
        <span class="account-dock-copy">
          <strong title={accountName()}>{accountName()}</strong>
          <span title={props.account.email}>{props.account.email}</span>
        </span>
      </div>
    </div>
  );
}
