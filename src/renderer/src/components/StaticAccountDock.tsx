import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { createMemo } from "solid-js";

interface StaticAccountDockProps {
  account: CentralAuthUser;
  compact: boolean;
  withServerRail: boolean;
}

export function StaticAccountDock(props: StaticAccountDockProps) {
  const accountName = createMemo(() => props.account.name?.trim() || props.account.email);
  const accountInitials = createMemo(() => {
    const localPart = accountName().split("@")[0] ?? "OpenBot";
    const parts = localPart.split(/[._\-\s]+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : localPart.slice(0, 2)).toUpperCase();
  });

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
        <span class="account-dock-avatar" aria-hidden="true">
          {accountInitials()}
        </span>
        <span class="account-dock-copy">
          <strong>{accountName()}</strong>
          <span>{props.account.email}</span>
        </span>
      </div>
    </div>
  );
}
