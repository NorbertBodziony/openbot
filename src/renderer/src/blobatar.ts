import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { palette, traits } from "blobatar";
import { blobatar, layout } from "blobatar/blob";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export type AvatarMotion = "hover" | "always";

const BLOBATAR_BODY_VARIANTS = ["round", "organic", "boxy", "nub", "cloud", "sun"] as const;

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

export function avatarHueSwatch(hue: BotAvatarHue): string {
  const swatch = palette(hue, true, 0.49).head;
  if (!swatch) throw new Error(`Blobatar did not return a head color for hue ${hue}.`);
  return swatch;
}

export function avatarCandidateSeeds(botId: string, currentSeed: string, batch: number): string[] {
  const candidates = [currentSeed];
  const missingBodyVariants = new Set(BLOBATAR_BODY_VARIANTS);
  missingBodyVariants.delete(layout(traits(currentSeed)).shape);
  let index = 1;

  while (missingBodyVariants.size > 0) {
    const candidate = `${botId}:avatar:${batch}:${index}`;
    index += 1;
    if (candidates.includes(candidate)) continue;
    if (!missingBodyVariants.delete(layout(traits(candidate)).shape)) continue;
    candidates.push(candidate);
  }

  while (candidates.length < 12) {
    const candidate = `${botId}:avatar:${batch}:${index}`;
    index += 1;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

export function buildAnimatedAvatarSvg(
  seed: string,
  hue: BotAvatarHue | null,
  motion: AvatarMotion = "hover",
): string {
  const svgMarkup = blobatar(seed, hue === null ? undefined : { hue });
  const document = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  const svg = document.documentElement;
  if (svg.localName !== "svg" || svg.querySelector("parsererror")) return svgMarkup;

  const [bodyGroup, eyesGroup] = Array.from(svg.children);
  if (!bodyGroup || !eyesGroup) return svgMarkup;

  const reader = traits(seed);
  const resolvedLayout = layout(reader);
  const eyeElements = Array.from(eyesGroup.children);
  if (eyeElements.length !== resolvedLayout.eyes.length) return svgMarkup;

  eyesGroup.classList.add("mo-eyes");
  eyeElements.forEach((element, index) => {
    const eye = resolvedLayout.eyes[index];
    if (!eye) return;
    const wrapper = document.createElementNS(SVG_NAMESPACE, "g");
    wrapper.setAttribute("class", "mo-eye");
    wrapper.setAttribute(
      "style",
      [
        `--mo-wrap:${index === 0 ? -1 : 1}`,
        `--mo-lean:${round2(eye.rot)}`,
        `transform-origin:${round2(eye.cx)}px ${round2(eye.cy)}px`,
      ].join(";"),
    );
    eyesGroup.insertBefore(wrapper, element);
    wrapper.append(element);
  });

  const root = document.createElementNS(SVG_NAMESPACE, "g");
  root.setAttribute("class", motion === "always" ? "mo-root mo-always" : "mo-root");
  root.setAttribute(
    "style",
    serializeMotionVariables({
      ...motionVariables(reader),
      "--mo-head": bodyGroup.getAttribute("fill") ?? "#000000",
      "--mo-eye": eyesGroup.getAttribute("fill") ?? "#ffffff",
    }),
  );
  const breathe = document.createElementNS(SVG_NAMESPACE, "g");
  breathe.setAttribute("class", "mo-breathe");
  const bob = document.createElementNS(SVG_NAMESPACE, "g");
  bob.setAttribute("class", "mo-bob");
  bob.append(bodyGroup, eyesGroup);
  breathe.append(bob);
  root.append(breathe);
  svg.replaceChildren(root);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return new XMLSerializer().serializeToString(svg);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Ported from Blobatar v0.2.0 under its MIT license. */
function motionVariables(reader: ReturnType<typeof traits>): Record<string, string> {
  const negativeMilliseconds = (value: number) => `${-Math.round(value)}ms`;
  const blink = Math.round(reader.num("motion.blink", 3500, 6500));
  const saccade = Math.round(reader.num("motion.saccade", 4200, 7600));
  const lookX = reader.num("motion.lookX", 1, 2.2);
  const lookY = reader.num("motion.lookY", 0.8, 1.7);
  return {
    "--mo-phase": negativeMilliseconds(reader.num("motion.phase", 0, 2800)),
    "--mo-bob-phase": negativeMilliseconds(reader.num("motion.bob", 0, 3400)),
    "--mo-blink": `${blink}ms`,
    "--mo-blink-phase": negativeMilliseconds(reader.num("motion.blinkPhase", 0, blink)),
    "--mo-look-x": String(round2(lookX * (reader.bool("motion.lookXFlip") ? -1 : 1))),
    "--mo-look-mx": String(round2(lookX)),
    "--mo-look-y": String(round2(lookY * (reader.bool("motion.lookYFlip") ? -1 : 1))),
    "--mo-look-my": String(round2(lookY)),
    "--mo-saccade": `${saccade}ms`,
    "--mo-saccade-phase": negativeMilliseconds(reader.num("motion.saccadePhase", 0, saccade)),
  };
}

function serializeMotionVariables(variables: Record<string, string>): string {
  return Object.entries(variables)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}
