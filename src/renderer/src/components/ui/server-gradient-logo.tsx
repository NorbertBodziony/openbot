import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { cx } from "./utils";

type GradientPalette = readonly [base: string, first: string, second: string, third: string];

export interface ServerGradientLogoProfile {
  paletteIndex: number;
  colors: GradientPalette;
  backgroundImage: string;
}

export interface ServerGradientLogoProps {
  seed: string;
  class?: JSX.HTMLAttributes<HTMLSpanElement>["class"];
}

const SERVER_GRADIENT_PALETTES = [
  ["#10195c", "#4361ee", "#4cc9f0", "#b5179e"],
  ["#4a102a", "#ff4d6d", "#ff9f1c", "#7b2cbf"],
  ["#073b3a", "#00f5d4", "#80ff72", "#4361ee"],
  ["#4a2100", "#ff6b35", "#ffd166", "#ef476f"],
  ["#240046", "#9d4edd", "#ff70a6", "#3a86ff"],
  ["#003049", "#00b4d8", "#90e0ef", "#2a9d8f"],
  ["#3c096c", "#ff006e", "#8338ec", "#ffbe0b"],
  ["#102a43", "#1f7a8c", "#bfdbf7", "#e63946"],
  ["#3d0c11", "#e63946", "#ffb703", "#fb8500"],
  ["#132a13", "#38b000", "#ccff33", "#00b4d8"],
  ["#1b263b", "#3a86ff", "#8338ec", "#06d6a0"],
  ["#3a0f2d", "#f72585", "#7209b7", "#4cc9f0"],
] as const satisfies readonly GradientPalette[];

const BLOB_RANGES = [
  { x: [-12, 36], y: [-12, 42] },
  { x: [62, 112], y: [-8, 58] },
  { x: [8, 92], y: [64, 112] },
] as const;

export function serverGradientLogoProfile(seed: string): ServerGradientLogoProfile {
  const stableSeed = seed || "server";
  const paletteIndex = stableHash(`${stableSeed}:palette`) % SERVER_GRADIENT_PALETTES.length;
  const colors = requiredPalette(paletteIndex);
  const layers = colors.slice(1).map((color, index) => {
    const range = BLOB_RANGES[index];
    if (!range) throw new Error("Server gradient blob ranges are incomplete.");
    const x = seededRange(`${stableSeed}:blob:${index}:x`, range.x[0], range.x[1]);
    const y = seededRange(`${stableSeed}:blob:${index}:y`, range.y[0], range.y[1]);
    const width = seededRange(`${stableSeed}:blob:${index}:width`, 68, 94);
    const height = seededRange(`${stableSeed}:blob:${index}:height`, 64, 92);
    const solidStop = seededRange(`${stableSeed}:blob:${index}:solid`, 4, 15);
    const fadeStop = seededRange(`${stableSeed}:blob:${index}:fade`, 66, 82);
    return `radial-gradient(ellipse ${width}% ${height}% at ${x}% ${y}%, ${color} 0%, ${color} ${solidStop}%, ${transparentHex(color)} ${fadeStop}%)`;
  });

  return {
    paletteIndex,
    colors,
    backgroundImage: layers.join(", "),
  };
}

export function ServerGradientLogo(props: ServerGradientLogoProps): JSX.Element {
  const profile = createMemo(() => serverGradientLogoProfile(props.seed));

  return (
    <span
      class={cx("ui-server-gradient-logo", props.class)}
      style={{
        "--server-gradient-base": profile().colors[0],
        "--server-gradient-layers": profile().backgroundImage,
      }}
      aria-hidden="true"
    />
  );
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededRange(seed: string, minimum: number, maximum: number): number {
  return minimum + (stableHash(seed) % (maximum - minimum + 1));
}

function transparentHex(color: string): string {
  return `${color}00`;
}

function requiredPalette(index: number): GradientPalette {
  const palette = SERVER_GRADIENT_PALETTES[index];
  if (!palette) throw new Error("Server gradient palettes are empty.");
  return palette;
}
