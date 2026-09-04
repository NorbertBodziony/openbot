import { BlurTargetView, BlurView } from "expo-blur";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { StyleSheet, type View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** Retain the outgoing content so the native header can finish its exit animation. */
export function ConnectionStatusReveal<T>({ value, children }: { value: T | null; children: (value: T) => ReactNode }) {
  const [retained, setRetained] = useState(value);
  const target = useRef<View | null>(null);
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const visible = value !== null;

  useEffect(() => {
    if (value !== null) setRetained(value);
  }, [value]);

  useEffect(() => {
    progress.set(
      withTiming(visible ? 1 : 0, {
        duration: visible ? 240 : 180,
        easing: EASE_OUT,
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [progress, visible]);

  const contentStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: reduceMotion ? 0 : (1 - progress.get()) * 3 }],
  }));
  const blurStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0 : 1 - progress.get(),
  }));
  const displayed = value ?? retained;

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      style={contentStyle}
    >
      <BlurTargetView ref={target}>{displayed !== null ? children(displayed) : null}</BlurTargetView>
      {!reduceMotion ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, blurStyle]}>
          <BlurView
            blurTarget={target}
            blurMethod="dimezisBlurViewSdk31Plus"
            intensity={16}
            tint="systemUltraThinMaterial"
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
