import { Typography } from "heroui-native";
import { useId, useLayoutEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, FeGaussianBlur, Filter, ForeignObject } from "react-native-svg";

const COUNTER_TIMING = {
  duration: 260,
  easing: Easing.bezier(0.77, 0, 0.175, 1),
  reduceMotion: ReduceMotion.System,
};
const BLUR_PADDING = 3;

function CounterText({ value }: { value: string }) {
  return (
    <Typography.Paragraph
      type="body-xs"
      className="text-text-secondary"
      maxFontSizeMultiplier={1.2}
      style={{ fontVariant: ["tabular-nums"] }}
    >
      {value}
    </Typography.Paragraph>
  );
}

function CounterLayer({
  value,
  incoming,
  progress,
  size,
}: {
  value: string;
  incoming: boolean;
  progress: SharedValue<number>;
  size: { width: number; height: number };
}) {
  const filterId = `counter-blur-${useId().replaceAll(":", "")}`;
  const sharpStyle = useAnimatedStyle(() => {
    const visibility = incoming ? progress.get() : 1 - progress.get();
    return { opacity: visibility * visibility };
  });
  const blurredStyle = useAnimatedStyle(() => {
    const visibility = incoming ? progress.get() : 1 - progress.get();
    return { opacity: 2 * visibility * (1 - visibility) };
  });
  const width = size.width + BLUR_PADDING * 2;
  const height = size.height + BLUR_PADDING * 2;

  return (
    <>
      <Animated.View style={[StyleSheet.absoluteFill, sharpStyle]}>
        <CounterText value={value} />
      </Animated.View>
      <Animated.View
        style={[{ position: "absolute", left: -BLUR_PADDING, top: -BLUR_PADDING, width, height }, blurredStyle]}
      >
        {/* Filter the glyphs themselves. ForeignObject keeps HeroUI's font, scale and theme. */}
        <Svg width={width} height={height}>
          <Defs>
            <Filter id={filterId} filterUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
              <FeGaussianBlur stdDeviation={0.8} />
            </Filter>
          </Defs>
          <ForeignObject
            x={BLUR_PADDING}
            y={BLUR_PADDING}
            width={size.width}
            height={size.height}
            filter={`url(#${filterId})`}
          >
            <View collapsable={false} style={size}>
              <CounterText value={value} />
            </View>
          </ForeignObject>
        </Svg>
      </Animated.View>
    </>
  );
}

export function AnimatedCounter({ value }: { value: string }) {
  const [frame, setFrame] = useState({ previous: value, current: value });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(1);

  if (frame.current !== value) setFrame({ previous: frame.current, current: value });

  useLayoutEffect(() => {
    if (frame.previous === frame.current || reduceMotion) {
      progress.set(1);
      return;
    }
    progress.set(0);
    progress.set(withTiming(1, COUNTER_TIMING));
  }, [frame, progress, reduceMotion]);

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View
        style={{ opacity: reduceMotion || size.width === 0 ? 1 : 0 }}
        onLayout={({ nativeEvent: { layout } }) => {
          setSize((current) =>
            current.width === layout.width && current.height === layout.height
              ? current
              : { width: layout.width, height: layout.height },
          );
        }}
      >
        <CounterText value={value} />
      </View>
      {!reduceMotion && size.width > 0 ? (
        <>
          <CounterLayer value={frame.previous} incoming={false} progress={progress} size={size} />
          <CounterLayer value={frame.current} incoming progress={progress} size={size} />
        </>
      ) : null}
    </View>
  );
}
