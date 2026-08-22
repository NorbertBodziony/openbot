import type { TeamPresenceMember } from "@openbot/contracts/ipc";
import { AgentAvatar } from "./AgentAvatar";

export function TeamPersonAvatar(props: { member: TeamPresenceMember; large?: boolean }) {
  const avatarSeed = () => props.member.email ?? props.member.username ?? props.member.id;

  return (
    <span class={["person-avatar", { large: Boolean(props.large), online: props.member.online }]} aria-hidden="true">
      <AgentAvatar seed={avatarSeed()} url={props.member.avatarUrl} motion="idle" class="person-avatar-generated" />
      <i />
    </span>
  );
}

export function teamMemberName(member: TeamPresenceMember): string {
  return member.name?.trim() || member.email || member.username;
}
