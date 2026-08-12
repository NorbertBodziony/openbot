import type { BotAvatarColor, BotAvatarShape } from "../../../shared/ipc";
import type { BotProfile } from "../data";
import { GrokMark } from "./GrokMark";

interface AgentAvatarProps {
  bot?: Pick<BotProfile, "avatarShape" | "avatarColor" | "accent">;
  shape?: BotAvatarShape;
  color?: BotAvatarColor;
  class?: string;
  style?: Record<string, string>;
}

export function AgentAvatar(props: AgentAvatarProps) {
  const shape = () => props.shape ?? props.bot?.avatarShape ?? "blob";
  const color = () => props.color ?? props.bot?.avatarColor ?? "orange";
  return (
    <span
      class={`bot-avatar bot-avatar-${props.bot?.accent ?? "neutral"} bot-avatar-shape-${shape()} bot-avatar-color-${color()} ${props.class ?? ""}`}
      style={props.style}
      aria-hidden="true"
    >
      <GrokMark shape={shape()} />
    </span>
  );
}
