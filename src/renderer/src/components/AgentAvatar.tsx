import { BloubBot } from "@norbert_bodziony/bloub";
import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";
import { type AvatarMotion, bloubAvatarProfile } from "../bloub-avatar";
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
      fallback={<GeneratedAvatar seed={seed()} hue={hue()} motion={motion()} class={className()} style={props.style} />}
    >
      <span class={`${className()} bot-avatar-custom`} style={props.style} aria-hidden="true">
        <img src={url() ?? ""} alt="" draggable={false} onError={() => setImageFailed(true)} />
      </span>
    </Show>
  );
}

function GeneratedAvatar(props: {
  seed: string;
  hue: BotAvatarHue | null;
  motion: AvatarMotion;
  class: string;
  style?: Record<string, string>;
}) {
  let element: HTMLSpanElement | undefined;
  const [interacting, setInteracting] = createSignal(false);
  const [reducedMotion, setReducedMotion] = createSignal(prefersReducedMotion());
  const profile = createMemo(() => bloubAvatarProfile(props.seed, props.hue));
  const animated = () => !reducedMotion() && (props.motion === "always" || interacting());

  onSettled(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const syncReducedMotion = () => setReducedMotion(media?.matches ?? false);
    syncReducedMotion();
    media?.addEventListener?.("change", syncReducedMotion);

    const interactionTarget = element?.closest<HTMLElement>("button, a, [role='button'], [tabindex]") ?? element;
    const startInteraction = () => setInteracting(true);
    const stopInteraction = () => setInteracting(false);
    const stopFocusInteraction = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !interactionTarget?.contains(event.relatedTarget)) {
        stopInteraction();
      }
    };
    interactionTarget?.addEventListener("pointerenter", startInteraction);
    interactionTarget?.addEventListener("pointerleave", stopInteraction);
    interactionTarget?.addEventListener("focusin", startInteraction);
    interactionTarget?.addEventListener("focusout", stopFocusInteraction);

    return () => {
      media?.removeEventListener?.("change", syncReducedMotion);
      interactionTarget?.removeEventListener("pointerenter", startInteraction);
      interactionTarget?.removeEventListener("pointerleave", stopInteraction);
      interactionTarget?.removeEventListener("focusin", startInteraction);
      interactionTarget?.removeEventListener("focusout", stopFocusInteraction);
    };
  });

  const avatar = () => (
    <BloubBot
      size={100}
      shape={profile().shape}
      color={profile().color}
      expression={profile().expression}
      playing={true}
      ariaLabel=""
      class="bloub-avatar-svg"
    />
  );

  return (
    <span ref={element} class={`${props.class} bot-avatar-bloub`} style={props.style} aria-hidden="true">
      <Show
        when={animated()}
        fallback={
          <BloubBot
            size={100}
            shape={profile().shape}
            color={profile().color}
            expression={profile().expression}
            frozenAt={0}
            ariaLabel=""
            class="bloub-avatar-svg"
          />
        }
      >
        {avatar()}
      </Show>
    </span>
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
