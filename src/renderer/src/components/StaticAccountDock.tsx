import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { createMemo, Show } from "solid-js";

interface StaticAccountDockProps {
  account: CentralAuthUser;
  compact: boolean;
  withServerRail: boolean;
}

export function StaticAccountDock(props: StaticAccountDockProps) {
  const accountName = createMemo(
    () => props.account.name?.trim() || props.account.email.split("@")[0] || props.account.email,
  );
  const accountInitials = createMemo(() => {
    const localPart = props.account.email.split("@")[0] ?? "OpenBot";
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
          <Show when={props.account.avatarUrl} fallback={accountInitials()}>
            {(avatarUrl) => <img src={avatarUrl()} alt="" />}
          </Show>
        </span>
        <span class="account-dock-copy">
          <strong title={accountName()}>{accountName()}</strong>
          <span title={props.account.email}>{props.account.email}</span>
        </span>
      </div>
    </div>
  );
}
