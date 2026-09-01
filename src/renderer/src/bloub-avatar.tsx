import {
  BloubBot,
  COLOR_BY_ID,
  type ColorId,
  EXPRESSIONS,
  type ExpressionId,
  SHAPES,
  type ShapeId,
} from "@norbert_bodziony/bloub";
import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { render } from "@solidjs/web";
import { flush } from "solid-js";

export type AvatarMotion = "hover" | "always" | "idle" | "working" | "connecting";
export type SupportedAvatarSilhouetteId = Exclude<ShapeId, "goutte">;
export interface BloubAvatarProfile {
  shape: SupportedAvatarSilhouetteId;
  color: ColorId;
  expression: ExpressionId;
}

const AUTOMATIC_COLORS = ["rouge", "orange", "ambre", "vert", "turquoise", "bleu", "violet", "rose"] as const;
const UNSUPPORTED_AVATAR_SILHOUETTE = "goutte" as const satisfies ShapeId;
const SUPPORTED_AVATAR_SILHOUETTES = SHAPES.map((option) => option.id).filter(
  (silhouette): silhouette is SupportedAvatarSilhouetteId => silhouette !== UNSUPPORTED_AVATAR_SILHOUETTE,
);

const HUE_COLORS: Readonly<Record<BotAvatarHue, ColorId>> = {
  0: "rouge",
  30: "orange",
  55: "ambre",
  100: "vert",
  150: "vert",
  185: "turquoise",
  215: "bleu",
  245: "violet",
  280: "violet",
  320: "rose",
};

export const AVATAR_HUE_OPTIONS: ReadonlyArray<{
  hue: BotAvatarHue;
  label: string;
}> = [
  { hue: 0, label: "Red" },
  { hue: 30, label: "Orange" },
  { hue: 55, label: "Yellow" },
  { hue: 100, label: "Lime" },
  { hue: 150, label: "Green" },
  { hue: 185, label: "Cyan" },
  { hue: 215, label: "Blue" },
  { hue: 245, label: "Indigo" },
  { hue: 280, label: "Violet" },
  { hue: 320, label: "Magenta" },
];

export function bloubAvatarProfile(seed: string, hue: BotAvatarHue | null): BloubAvatarProfile {
  const storedSilhouette = requiredItem(SHAPES, stableIndex(`${seed}:shape`, SHAPES.length)).id;
  const silhouette =
    storedSilhouette === UNSUPPORTED_AVATAR_SILHOUETTE
      ? requiredItem(
          SUPPORTED_AVATAR_SILHOUETTES,
          stableIndex(`${seed}:shape:replacement`, SUPPORTED_AVATAR_SILHOUETTES.length),
        )
      : storedSilhouette;
  const expression = requiredItem(EXPRESSIONS, stableIndex(`${seed}:expression`, EXPRESSIONS.length)).id;
  return {
    shape: silhouette,
    expression,
    color:
      hue === null
        ? requiredItem(AUTOMATIC_COLORS, stableIndex(`${seed}:color`, AUTOMATIC_COLORS.length))
        : HUE_COLORS[hue],
  };
}

export function avatarHueSwatch(hue: BotAvatarHue): string {
  return colorHex(HUE_COLORS[hue]);
}

export function avatarHeadColor(seed: string, hue: BotAvatarHue | null): string {
  return colorHex(bloubAvatarProfile(seed, hue).color);
}

export function avatarCandidateSeeds(botId: string, currentSeed: string, batch: number): string[] {
  const candidates = [currentSeed];
  const firstProfile = bloubAvatarProfile(currentSeed, null);
  const unseenSilhouetteIds = new Set<SupportedAvatarSilhouetteId>(SUPPORTED_AVATAR_SILHOUETTES);
  const usedExpressions = new Set<ExpressionId>([firstProfile.expression]);
  unseenSilhouetteIds.delete(firstProfile.shape);
  let index = 1;

  while (unseenSilhouetteIds.size > 0) {
    const candidate = `${botId}:avatar:${batch}:${index}`;
    index += 1;
    if (candidates.includes(candidate)) continue;
    const profile = bloubAvatarProfile(candidate, null);
    if (!unseenSilhouetteIds.delete(profile.shape)) continue;
    candidates.push(candidate);
    usedExpressions.add(profile.expression);
  }

  while (candidates.length < 12) {
    const candidate = `${botId}:avatar:${batch}:${index}`;
    index += 1;
    if (candidates.includes(candidate)) continue;
    const profile = bloubAvatarProfile(candidate, null);
    if (usedExpressions.has(profile.expression)) continue;
    candidates.push(candidate);
    usedExpressions.add(profile.expression);
  }

  return candidates;
}

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

function stableIndex(value: string, length: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % length;
}

function colorHex(color: ColorId): string {
  const value = COLOR_BY_ID.get(color)?.hex;
  if (!value) throw new Error(`Bloub did not return a color for ${color}.`);
  return value;
}

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error("Bloub avatar options are empty.");
  return item;
}
