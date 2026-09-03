import Animated, { interpolate, type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import { BloubAvatar } from "@/features/bots/components/bloub-avatar";
import type { BotPinTransitionState } from "@/features/bots/components/bot-pin-transition";

interface BotPinTransitionOverlayProps {
  progress: SharedValue<number>;
  transition: BotPinTransitionState | null;
}

export function BotPinTransitionOverlay({ progress, transition }: BotPinTransitionOverlayProps) {
  const overlayStyle = useAnimatedStyle(() => {
    if (!transition) return { opacity: 0 };

    const to = transition.to ?? transition.from;
    const value = progress.get();
    const scale = interpolate(value, [0, 1], [1, to.width / transition.from.width]);
    const endX = to.x - transition.from.x + (to.width - transition.from.width) / 2;
    const endY = to.y - transition.from.y + (to.height - transition.from.height) / 2;
    const arc = -24 * 4 * value * (1 - value);

    return {
      height: transition.from.height,
      left: transition.from.x,
      opacity: transition.to ? 1 : 0.98,
      position: "absolute" as const,
      top: transition.from.y,
      transform: [{ translateX: endX * value }, { translateY: endY * value + arc }, { scale }],
      width: transition.from.width,
      zIndex: 100,
    };
  }, [transition]);

  if (!transition) return null;

  return (
    <Animated.View pointerEvents="none" style={overlayStyle}>
      <BloubAvatar hue={transition.avatarHue} seed={transition.avatarSeed} size={transition.from.width} />
    </Animated.View>
  );
}
