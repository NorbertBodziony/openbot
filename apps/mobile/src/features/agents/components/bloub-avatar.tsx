import { BotEngine, COLOR_BY_ID, EXPRESSION_BY_ID, SHAPE_BY_ID } from "@norbert_bodziony/bloub";
import { bloubAvatarProfile } from "@openbot/brand/bloub-avatar";
import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { useMemo } from "react";
import Svg, { Defs, Mask, Path, Rect } from "react-native-svg";

interface BloubAvatarProps {
  hue: BotAvatarHue | null;
  seed: string;
  size?: number;
}

const AVATAR_PAPER = "#f9f9f9";

export function BloubAvatar({ hue, seed, size = 54 }: BloubAvatarProps) {
  const avatar = useMemo(() => {
    const profile = bloubAvatarProfile(seed, hue);
    const silhouette = SHAPE_BY_ID.get(profile.shape);
    const expression = EXPRESSION_BY_ID.get(profile.expression);
    const color = COLOR_BY_ID.get(profile.color)?.hex;
    if (!silhouette || !expression || !color) throw new Error("Bloub avatar profile is invalid.");
    const frame = new BotEngine(100, "idle", silhouette.radii, expression).sample(0);

    return { color, frame, maskId: `bloub-${stableHash(seed).toString(16)}` };
  }, [hue, seed]);

  return (
    <Svg
      accessibilityElementsHidden
      accessible={false}
      height={size}
      pointerEvents="none"
      viewBox="-158 -158 316 316"
      width={size}
    >
      <Defs>
        <Mask id={avatar.maskId} x={-158} y={-158} width={316} height={316} maskUnits="userSpaceOnUse">
          <Path d={avatar.frame.bodyPath} fill="#ffffff" opacity={avatar.frame.bodyAlpha} />
          {avatar.frame.eyes.map((eye) => (
            <Path
              key={`${avatar.maskId}-${eye.matrix}`}
              d={eye.d}
              fill="#000000"
              opacity={eye.alpha}
              transform={eye.matrix}
            />
          ))}
        </Mask>
      </Defs>
      <Path d={avatar.frame.bodyPath} fill={AVATAR_PAPER} opacity={avatar.frame.bodyAlpha} />
      <Rect fill={avatar.color} height={316} mask={`url(#${avatar.maskId})`} width={316} x={-158} y={-158} />
    </Svg>
  );
}

export function getBloubAvatarColor(seed: string, hue: BotAvatarHue | null): string {
  const profile = bloubAvatarProfile(seed, hue);
  return COLOR_BY_ID.get(profile.color)?.hex ?? "#8b5cf6";
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
