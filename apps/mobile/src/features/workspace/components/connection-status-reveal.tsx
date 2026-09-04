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
import { scheduleOnRN } from "react-native-worklets";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** Retain outgoing content until its exit animation finishes. */
export function ConnectionStatusReveal<T>({
  value,
  children,
  collapseOnHide = false,
}: {
  value: T | null;
  children: (value: T) => ReactNode;
  collapseOnHide?: boolean;
}) {
  const [retained, setRetained] = useState(value);
  const target = useRef<View | null>(null);
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const visible = value !== null;

  useEffect(() => {
    if (value !== null) setRetained(value);
  }, [value]);

  useEffect(() => {
    let cancelled = false;
    const clearRetained = () => {
      if (!cancelled) setRetained(null);
    };
    progress.set(
      withTiming(
        visible ? 1 : 0,
        {
          duration: visible ? 240 : 180,
          easing: EASE_OUT,
          reduceMotion: ReduceMotion.System,
        },
        (finished) => {
          if (finished && !visible && collapseOnHide) scheduleOnRN(clearRetained);
        },
      ),
    );
    return () => {
      cancelled = true;
    };
  }, [collapseOnHide, progress, visible]);

  const contentStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: reduceMotion ? 0 : (1 - progress.get()) * 3 }],
  }));
  const blurStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0 : 1 - progress.get(),
  }));
  const displayed = value ?? retained;
  if (displayed === null) return null;

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      style={contentStyle}
    >
      <BlurTargetView ref={target}>{children(displayed)}</BlurTargetView>
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
