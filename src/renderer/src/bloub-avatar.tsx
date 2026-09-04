import { BloubBot } from "@norbert_bodziony/bloub";
import { bloubAvatarProfile } from "@openbot/brand/bloub-avatar";
import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { render } from "@solidjs/web";
import { flush } from "solid-js";

export type AvatarMotion = "hover" | "always" | "idle" | "working" | "connecting";
export {
  AVATAR_HUE_OPTIONS,
  avatarCandidateSeeds,
  avatarHeadColor,
  avatarHueSwatch,
  type BloubAvatarProfile,
  bloubAvatarProfile,
  type SupportedAvatarSilhouetteId,
} from "@openbot/brand/bloub-avatar";

export function createStaticAvatarSvg(seed: string, hue: BotAvatarHue | null): SVGSVGElement {
  const host = document.createElement("span");
  const dispose = mountStaticAvatar(host, seed, hue);
  const svg = host.querySelector("svg");
  if (!svg) {
    dispose();
    throw new Error("Bloub did not render an SVG avatar.");
  }
  const result = svg.cloneNode(true);
  if (!(result instanceof SVGSVGElement)) {
    dispose();
    throw new Error("Bloub did not clone an SVG avatar.");
  }
  dispose();
  return result;
}

function mountStaticAvatar(host: HTMLElement, seed: string, hue: BotAvatarHue | null): () => void {
  const profile = bloubAvatarProfile(seed, hue);
  const dispose = render(
    () => (
      <BloubBot
        size={100}
        shape={profile.shape}
        color={profile.color}
        expression={profile.expression}
        frozenAt={0}
        ariaLabel=""
      />
    ),
    host,
  );
  flush();
  const svg = host.querySelector("svg");
  if (!svg) {
    dispose();
    throw new Error("Bloub did not render an SVG avatar.");
  }
  svg.removeAttribute("role");
  svg.removeAttribute("aria-label");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return dispose;
}
