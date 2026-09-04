import type { TeamPresenceMember } from "@openbot/contracts/ipc";
import type { AvatarMotion } from "../bloub-avatar";
import { AgentAvatar } from "./AgentAvatar";

// A person is never "working", so the caller only picks between resting and moving. The
// sidebar passes `"hover"` because its list is on screen all day; the conversation header
// keeps `"idle"`, where the avatar is the subject rather than one row of many and nothing
// focusable surrounds it to bring the motion back.
export function TeamPersonAvatar(props: { member: TeamPresenceMember; large?: boolean; motion?: AvatarMotion }) {
  const avatarSeed = () => props.member.email ?? props.member.username ?? props.member.id;

  return (
    <span class={["person-avatar", { large: Boolean(props.large), online: props.member.online }]} aria-hidden="true">
      <AgentAvatar
        seed={avatarSeed()}
        url={props.member.avatarUrl}
        motion={props.motion ?? "idle"}
        class="person-avatar-generated"
      />
      <i />
    </span>
  );
}

export function teamMemberName(member: TeamPresenceMember): string {
  return member.name?.trim() || member.email || member.username;
}
