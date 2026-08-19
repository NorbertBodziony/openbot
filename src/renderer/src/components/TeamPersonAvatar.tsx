import type { TeamPresenceMember } from "@openbot/contracts/ipc";
import { blobatar } from "blobatar/blob";
import { createEffect, createMemo, createSignal, Show } from "solid-js";

export function TeamPersonAvatar(props: { member: TeamPresenceMember; large?: boolean }) {
  const avatarUrl = () => props.member.avatarUrl ?? null;
  const [imageFailed, setImageFailed] = createSignal(false);
  const generatedAvatar = createMemo(() =>
    blobatar(props.member.email ?? props.member.username ?? props.member.id, { background: false }),
  );
  createEffect(
    () => avatarUrl(),
    () => {
      setImageFailed(false);
    },
  );
  return (
    <span
      class={["person-avatar", { large: Boolean(props.large), online: props.member.online }]}
      aria-hidden="true"
    >
      <Show
        when={avatarUrl() && !imageFailed()}
        fallback={<span class="person-avatar-generated" innerHTML={generatedAvatar()} />}
      >
        <img
          src={avatarUrl() ?? ""}
          alt=""
          draggable={false}
          onError={() => setImageFailed(true)}
        />
      </Show>
      <i />
    </span>
  );
}

export function teamMemberName(member: TeamPresenceMember): string {
  return member.name?.trim() || member.email || member.username;
}
