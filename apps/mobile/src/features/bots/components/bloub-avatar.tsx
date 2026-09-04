import { COLOR_BY_ID } from "@norbert_bodziony/bloub";
import { bloubAvatarProfile } from "@openbot/brand/bloub-avatar";
import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { useId } from "react";
import Animated, { type DerivedValue, useAnimatedProps } from "react-native-reanimated";
import Svg, { Circle, Defs, FeColorMatrix, Filter, G, Mask, Path, Rect } from "react-native-svg";
import { type BloubActivityFrame, useBloubActivityFrame } from "@/features/bots/components/use-bloub-activity-frame";
import { useBotActivity } from "@/features/workspace/components/use-bot-activity";

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
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function AvatarEye({ frame, index }: { frame: DerivedValue<BloubActivityFrame>; index: number }) {
  const props = useAnimatedProps(() => frame.get().eyes[index] ?? { d: "", opacity: 0, matrix: [1, 0, 0, 1, 0, 0] });
  return <AnimatedPath fill="#000000" animatedProps={props} />;
}

function AvatarDot({ frame, index, color }: { frame: DerivedValue<BloubActivityFrame>; index: number; color: string }) {
  const props = useAnimatedProps(() => frame.get().dots[index] ?? { cx: 0, cy: 0, r: 0, opacity: 0 });
  return <AnimatedCircle fill={color} animatedProps={props} />;
}

export function BloubAvatar({ botId, hue, seed, size = 54 }: BloubAvatarProps) {
  const { bots, servers } = useMobileWorkspace();
  const serverId = bots.find((bot) => bot.id === botId)?.serverId;
  const disconnected = !servers.some((server) => server.id === serverId && server.state === "online");
  const appearance = useConnectionAppearance(disconnected);
  const colorProps = useAnimatedProps(() => ({ values: [appearance.get().saturation] }));
  const appearanceProps = useAnimatedProps(() => ({ opacity: appearance.get().opacity }));
  const activity = useBotActivity(botId);
  const frame = useBloubActivityFrame(seed, hue, !disconnected && Boolean(activity && activity.phase !== "waiting"));
  const bodyProps = useAnimatedProps(() => frame.get().body);
  const maskId = `bloub-${useId().replaceAll(":", "")}`;
  const color = getBloubAvatarColor(seed, hue);

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
        <Filter id={`${maskId}-offline`}>
          <AnimatedColorMatrix type="saturate" animatedProps={colorProps} />
        </Filter>
        <Mask id={maskId} x={-158} y={-158} width={316} height={316} maskUnits="userSpaceOnUse">
          <AnimatedPath fill="#ffffff" animatedProps={bodyProps} />
          <AvatarEye frame={frame} index={0} />
          <AvatarEye frame={frame} index={1} />
        </Mask>
      </Defs>
      {/* Mobile-only feedback: keep the synced avatar profile and color untouched. */}
      <AnimatedGroup filter={`url(#${maskId}-offline)`} animatedProps={appearanceProps}>
        <AnimatedPath fill={AVATAR_PAPER} animatedProps={bodyProps} />
        <Rect fill={color} height={316} mask={`url(#${maskId})`} width={316} x={-158} y={-158} />
        <AvatarDot frame={frame} index={0} color={color} />
        <AvatarDot frame={frame} index={1} color={color} />
        <AvatarDot frame={frame} index={2} color={color} />
      </AnimatedGroup>
    </Svg>
  );
}

export function getBloubAvatarColor(seed: string, hue: BotAvatarHue | null): string {
  const profile = bloubAvatarProfile(seed, hue);
  return COLOR_BY_ID.get(profile.color)?.hex ?? "#8b5cf6";
}
