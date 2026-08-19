import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { type AvatarMotion, buildAnimatedAvatarSvg } from "../blobatar";
import type { BotProfile } from "../data";

interface AgentAvatarProps {
  bot?: Pick<BotProfile, "avatarSeed" | "avatarHue" | "avatarUrl">;
  seed?: string;
  hue?: BotAvatarHue | null;
  url?: string | null;
  motion?: AvatarMotion;
  class?: string;
  style?: Record<string, string>;
}

export function AgentAvatar(props: AgentAvatarProps) {
  const seed = () => props.seed ?? props.bot?.avatarSeed ?? "agent";
  const hue = () => (props.hue !== undefined ? props.hue : (props.bot?.avatarHue ?? null));
  const motion = () => props.motion ?? "hover";
  const url = () => (props.url !== undefined ? props.url : (props.bot?.avatarUrl ?? null));
  const [imageFailed, setImageFailed] = createSignal(false);
  const markup = createMemo(() => buildAnimatedAvatarSvg(seed(), hue(), motion()));
  createEffect(
    () => url(),
    () => {
      setImageFailed(false);
    },
  );
  const className = () => `bot-avatar bot-avatar-motion-${motion()} ${props.class ?? ""}`;
  return (
    <Show
      when={url() && !imageFailed()}
      fallback={<span class={className()} style={props.style} aria-hidden="true" innerHTML={markup()} />}
    >
      <span class={`${className()} bot-avatar-custom`} style={props.style} aria-hidden="true">
        <img src={url() ?? ""} alt="" draggable={false} onError={() => setImageFailed(true)} />
      </span>
    </Show>
  );
}
