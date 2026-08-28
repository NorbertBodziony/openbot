import type { CentralAuthUser } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, Show } from "solid-js";

export interface UserAvatarProps {
  user: Pick<CentralAuthUser, "name" | "email" | "avatarUrl">;
  class?: JSX.HTMLAttributes<HTMLSpanElement>["class"];
  decorative?: boolean;
}

export function UserAvatar(props: UserAvatarProps): JSX.Element {
  const [imageFailed, setImageFailed] = createSignal(false);
  const initials = createMemo(() => {
    const accountName = props.user.name?.trim() || props.user.email.split("@")[0] || "OpenBot";
    const parts = accountName.split(/[._\-\s]+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : accountName.slice(0, 2)).toUpperCase();
  });

  createEffect(
    () => props.user.avatarUrl,
    () => {
      setImageFailed(false);
    },
  );

  return (
    <span class={props.class} aria-hidden={props.decorative ? "true" : undefined}>
      <Show when={props.user.avatarUrl && !imageFailed() ? props.user.avatarUrl : null} fallback={initials()}>
        {(avatarUrl) => <img src={avatarUrl()} alt="" onError={() => setImageFailed(true)} />}
      </Show>
    </span>
  );
}
