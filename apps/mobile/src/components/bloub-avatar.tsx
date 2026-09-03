import { BotEngine, COLOR_BY_ID, EXPRESSIONS, SHAPES, type ShapeId } from "@norbert_bodziony/bloub";
import { useThemeColor } from "heroui-native/hooks";
import { useMemo } from "react";
import Svg, { Defs, Mask, Path, Rect } from "react-native-svg";

interface BloubAvatarProps {
  seed: string;
  size?: number;
}

type SupportedSilhouetteId = Exclude<ShapeId, "goutte">;

const AUTOMATIC_COLORS = ["rouge", "orange", "ambre", "vert", "turquoise", "bleu", "violet", "rose"] as const;
const SUPPORTED_SILHOUETTES = SHAPES.filter(
  (silhouette): silhouette is (typeof SHAPES)[number] & { id: SupportedSilhouetteId } => silhouette.id !== "goutte",
);

export function BloubAvatar({ seed, size = 54 }: BloubAvatarProps) {
  const background = useThemeColor("background");
  const avatar = useMemo(() => {
    const silhouette = requiredItem(
      SUPPORTED_SILHOUETTES,
      stableIndex(`${seed}:silhouette`, SUPPORTED_SILHOUETTES.length),
    );
    const expression = requiredItem(EXPRESSIONS, stableIndex(`${seed}:expression`, EXPRESSIONS.length));
    const color = getBloubAvatarColor(seed);
    const frozenAt = stableIndex(`${seed}:pose`, 180) / 100;
    const frame = new BotEngine(100, "idle", silhouette.radii, expression).sample(frozenAt);

    return { color, frame, maskId: `bloub-${stableHash(seed).toString(16)}` };
  }, [seed]);

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
      <Path d={avatar.frame.bodyPath} fill={String(background)} opacity={avatar.frame.bodyAlpha} />
      <Rect fill={avatar.color} height={316} mask={`url(#${avatar.maskId})`} width={316} x={-158} y={-158} />
    </Svg>
  );
}

export function getBloubAvatarColor(seed: string): string {
  const colorId = requiredItem(AUTOMATIC_COLORS, stableIndex(`${seed}:color`, AUTOMATIC_COLORS.length));
  return COLOR_BY_ID.get(colorId)?.hex ?? "#8b5cf6";
}

function stableIndex(value: string, length: number): number {
  return stableHash(value) % length;
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error("Bloub avatar options are empty.");
  return item;
}
