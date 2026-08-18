import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { createMemo } from "solid-js";
import { type AvatarMotion, buildAnimatedAvatarSvg } from "../blobatar";
import type { BotProfile } from "../data";

interface AgentAvatarProps {
  bot?: Pick<BotProfile, "avatarSeed" | "avatarHue">;
  seed?: string;
  hue?: BotAvatarHue | null;
  motion?: AvatarMotion;
  class?: string;
  style?: Record<string, string>;
}

export function AgentAvatar(props: AgentAvatarProps) {
  const seed = () => props.seed ?? props.bot?.avatarSeed ?? "agent";
  const hue = () => (props.hue !== undefined ? props.hue : (props.bot?.avatarHue ?? null));
  const motion = () => props.motion ?? "hover";
  const markup = createMemo(() => buildAnimatedAvatarSvg(seed(), hue(), motion()));
  return (
    <span
      class={`bot-avatar bot-avatar-motion-${motion()} ${props.class ?? ""}`}
      style={props.style}
      aria-hidden="true"
      innerHTML={markup()}
    />
  );
}
