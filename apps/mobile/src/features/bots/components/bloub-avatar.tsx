import { BotEngine, COLOR_BY_ID, EXPRESSION_BY_ID, SHAPE_BY_ID } from "@norbert_bodziony/bloub";
import { bloubAvatarProfile } from "@openbot/brand/bloub-avatar";
import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { useMemo } from "react";
import Animated, { useAnimatedProps } from "react-native-reanimated";
import Svg, { Defs, FeColorMatrix, Filter, G, Mask, Path, Rect } from "react-native-svg";

import { useConnectionAppearance } from "@/features/workspace/components/use-connection-appearance";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";

interface BloubAvatarProps {
  botId: string;
  hue: BotAvatarHue | null;
  seed: string;
  size?: number;
}

const AVATAR_PAPER = "#f9f9f9";
const AnimatedColorMatrix = Animated.createAnimatedComponent(FeColorMatrix);
const AnimatedGroup = Animated.createAnimatedComponent(G);

export function BloubAvatar({ botId, hue, seed, size = 54 }: BloubAvatarProps) {
  const { bots, servers } = useMobileWorkspace();
  const serverId = bots.find((bot) => bot.id === botId)?.serverId;
  const disconnected = !servers.some((server) => server.id === serverId && server.state === "online");
  const appearance = useConnectionAppearance(disconnected);
  const colorProps = useAnimatedProps(() => ({ values: [appearance.get().saturation] }));
  const appearanceProps = useAnimatedProps(() => ({ opacity: appearance.get().opacity }));
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
        <Filter id={`${avatar.maskId}-offline`}>
          <AnimatedColorMatrix type="saturate" animatedProps={colorProps} />
        </Filter>
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
      {/* Mobile-only feedback: keep the synced avatar profile and color untouched. */}
      <AnimatedGroup filter={`url(#${avatar.maskId}-offline)`} animatedProps={appearanceProps}>
        <Path d={avatar.frame.bodyPath} fill={AVATAR_PAPER} opacity={avatar.frame.bodyAlpha} />
        <Rect fill={avatar.color} height={316} mask={`url(#${avatar.maskId})`} width={316} x={-158} y={-158} />
      </AnimatedGroup>
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
