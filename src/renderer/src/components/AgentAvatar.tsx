import {
  type Block,
  BloubBot,
  defaultCycle,
  makeBlock,
  POSES,
  type ShapeId,
  type StateId,
} from "@norbert_bodziony/bloub";
import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";
import { type AvatarMotion, bloubAvatarProfile } from "../bloub-avatar";
import type { BotProfile } from "../data";

const DEFAULT_CYCLE: Block[] = defaultCycle().blocks;
const SIDEBAR_MOTION_HOLD_FACTOR = 1.25;
const IDLE_CYCLE: Block[] = [slowerBlock("idle")];
const WORKING_CYCLE: Block[] = [slowerBlock("orbit")];
const CONNECTING_CYCLE: Block[] = [makeBlock("orbit"), makeBlock("swirl")];

function slowerBlock(state: StateId): Block {
  const block = makeBlock(state);
  return { ...block, duration: block.duration * SIDEBAR_MOTION_HOLD_FACTOR };
}

interface AgentAvatarProps {
  bot?: Pick<BotProfile, "avatarSeed" | "avatarHue" | "avatarUrl">;
  seed?: string;
  hue?: BotAvatarHue | null;
  url?: string | null;
  motion?: AvatarMotion;
  cycleOffset?: number;
  animationOffset?: number;
  animationState?: StateId;
  shape?: ShapeId;
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
      fallback={
        <GeneratedAvatar
          seed={seed()}
          hue={hue()}
          motion={motion()}
          cycleOffset={props.cycleOffset}
          animationOffset={props.animationOffset}
          animationState={props.animationState}
          shape={props.shape}
          class={className()}
          style={props.style}
        />
      }
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
  cycleOffset?: number;
  animationOffset?: number;
  animationState?: StateId;
  shape?: ShapeId;
  class: string;
  style?: Record<string, string>;
}) {
  let element: HTMLSpanElement | undefined;
  const [interacting, setInteracting] = createSignal(false);
  const [reducedMotion, setReducedMotion] = createSignal(prefersReducedMotion());
  const frozenAt = props.animationState ? POSES[props.animationState] : 0;
  const profile = createMemo(() => bloubAvatarProfile(props.seed, props.hue));
  const cycle = createMemo(() => offsetCycle(DEFAULT_CYCLE, props.cycleOffset ?? 0));
  const animated = () =>
    !reducedMotion() && (Boolean(props.animationState) || props.motion !== "hover" || interacting());
  const motionCycle = () => {
    if (props.animationState) return [slowerBlock(props.animationState)];
    if (props.motion === "connecting") return CONNECTING_CYCLE;
    if (props.motion === "idle") return IDLE_CYCLE;
    if (props.motion === "working") return WORKING_CYCLE;
    return cycle();
  };

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
      shape={props.shape ?? profile().shape}
      color={profile().color}
      expression={profile().expression}
      cycle={motionCycle()}
      playing={true}
      elapsed={props.animationOffset}
      ariaLabel=""
      class="bloub-avatar-svg"
    />
  );

  return (
    <span
      ref={element}
      class={`${props.class} bot-avatar-bloub`}
      style={props.style}
      data-animation-state={props.animationState}
      aria-hidden="true"
    >
      <Show
        when={animated()}
        fallback={
          <BloubBot
            size={100}
            shape={props.shape ?? profile().shape}
            color={profile().color}
            expression={profile().expression}
            frozenAt={frozenAt}
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

function offsetCycle(blocks: Block[], offset: number): Block[] {
  if (blocks.length === 0) return blocks;
  const start = ((Math.trunc(offset) % blocks.length) + blocks.length) % blocks.length;
  if (start === 0) return blocks;
  return [...blocks.slice(start), ...blocks.slice(0, start)];
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
