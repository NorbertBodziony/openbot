import { Typography } from "heroui-native";
import { useEffect } from "react";
import type { TextStyle } from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const AnimatedTypography = Animated.createAnimatedComponent(Typography);

function RevealedWord({
  text,
  type,
  style,
}: {
  text: string;
  type: "body" | "body-sm" | "h4" | "h5";
  style: TextStyle;
}) {
  const opacity = useSharedValue(0);
  const color = String(style.color);
  useEffect(() => {
    opacity.set(withTiming(1, { duration: 400, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }));
  }, [opacity]);
  // Nested native text supports color rather than a separate view's opacity.
  const revealStyle = useAnimatedStyle(() => ({
    color: interpolateColor(opacity.get(), [0, 1], ["transparent", color]),
  }));
  return (
    <AnimatedTypography type={type} style={[style, revealStyle]}>
      {text}
    </AnimatedTypography>
  );
}

export function StreamingTailText({
  body,
  type,
  style,
}: {
  body: string;
  type: "body" | "body-sm" | "h4" | "h5";
  style: TextStyle;
}) {
  const match = /(\S+\s*)$/u.exec(body);
  if (!match) return body;
  return (
    <>
      {body.slice(0, match.index)}
      <RevealedWord key={match.index} text={match[0]} type={type} style={style} />
    </>
  );
}
