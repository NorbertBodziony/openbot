import { BlurTargetView, BlurView } from "expo-blur";
import { type PropsWithChildren, useLayoutEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, type View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const ROW_DURATION = 260;
const ROW_STAGGER = 32;
const MAX_DELAY = 160;
const REDUCED_DURATION = 150;
const EASE_OUT = Easing.bezierFn(0.23, 1, 0.32, 1);

export interface BotListRevealState {
  elapsed: SharedValue<number>;
  finished: boolean;
  reducedMotion: boolean;
  stagger: number;
}

export function useBotListReveal(ready: boolean, itemCount: number): BotListRevealState {
  const elapsed = useSharedValue(0);
  const reducedMotion = useReducedMotion();
  const [finished, setFinished] = useState(false);
  const stagger = Math.min(ROW_STAGGER, MAX_DELAY / Math.max(1, itemCount - 1));

  useLayoutEffect(() => {
    elapsed.set(0);
    setFinished(false);
    if (!ready) return;
    let active = true;
    const finish = () => {
      if (active) setFinished(true);
    };
    const duration = reducedMotion ? REDUCED_DURATION : ROW_DURATION + MAX_DELAY;
    elapsed.set(
      withTiming(duration, { duration, easing: Easing.linear, reduceMotion: ReduceMotion.Never }, (done) => {
        if (done) scheduleOnRN(finish);
      }),
    );
    return () => {
      active = false;
      cancelAnimation(elapsed);
    };
  }, [elapsed, ready, reducedMotion]);

  return useMemo(() => ({ elapsed, finished, reducedMotion, stagger }), [elapsed, finished, reducedMotion, stagger]);
}

export function BotListRowReveal({
  children,
  index,
  reveal,
  skip = false,
}: PropsWithChildren<{ index: number; reveal: BotListRevealState; skip?: boolean }>) {
  const target = useRef<View | null>(null);
  const { elapsed, finished, reducedMotion, stagger } = reveal;
  const progress = useDerivedValue(() => {
    if (finished || skip) return 1;
    const delay = reducedMotion ? 0 : Math.min(index * stagger, MAX_DELAY);
    const duration = reducedMotion ? REDUCED_DURATION : ROW_DURATION;
    return EASE_OUT(Math.min(1, Math.max(0, (elapsed.get() - delay) / duration)));
  });
  const contentStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateX: reducedMotion ? 0 : -18 * (1 - progress.get()) }],
  }));
  const blurStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.get() }));

  return (
    <Animated.View style={contentStyle}>
      <BlurTargetView ref={target}>{children}</BlurTargetView>
      {!finished && !reducedMotion && !skip ? (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[StyleSheet.absoluteFill, blurStyle]}
        >
          <BlurView
            blurTarget={target}
            blurMethod="dimezisBlurViewSdk31Plus"
            intensity={16}
            tint="default"
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
