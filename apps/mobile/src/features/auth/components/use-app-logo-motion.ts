import * as Haptics from "expo-haptics";
import { DeviceMotion } from "expo-sensors";
import { useCallback, useEffect, useRef } from "react";
import {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

export type AppLogoAnimation = "none" | "blink";

const VIEWBOX_SIZE = 240;
const BLINK_INTERVAL_MS = 4_800;
const BLINK_START_DELAY_MS = 2_112;
const BLINK_HALF_DURATION_MS = 96;
const BLINK_END_DELAY_MS = BLINK_INTERVAL_MS - BLINK_START_DELAY_MS - BLINK_HALF_DURATION_MS * 2;
const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const WINK_DURATION_MS = 360;
const WINK_CLOSE_DURATION_MS = 137;
const WINK_HOLD_DURATION_MS = 72;
const WINK_OPEN_DURATION_MS = WINK_DURATION_MS - WINK_CLOSE_DURATION_MS - WINK_HOLD_DURATION_MS;
const WINK_RIGHT_REACTION_DURATION_MS = 173;
const WINK_RIGHT_RECOVERY_DURATION_MS = WINK_DURATION_MS - WINK_RIGHT_REACTION_DURATION_MS;
const ORIENTATION_UPDATE_INTERVAL_MS = 100;
const ORIENTATION_ROTATION_DURATION_MS = 160;
const ORIENTATION_DEAD_ZONE_DEGREES = 1;
const MIN_PLANAR_GRAVITY = DeviceMotion.Gravity * 0.25;
const RADIANS_TO_DEGREES = 180 / Math.PI;

function createBlinkAnimation(): number {
  return withRepeat(
    withSequence(
      ReduceMotion.Never,
      withDelay(BLINK_START_DELAY_MS, withTiming(0.08, { duration: BLINK_HALF_DURATION_MS, easing: EASE_IN_OUT })),
      withTiming(1, { duration: BLINK_HALF_DURATION_MS, easing: EASE_IN_OUT }),
      withDelay(BLINK_END_DELAY_MS, withTiming(1, { duration: 0 })),
    ),
    -1,
    false,
    undefined,
    ReduceMotion.Never,
  );
}

export function useAppLogoMotion({
  animation,
  followDeviceOrientation,
  size,
}: {
  animation: AppLogoAnimation;
  followDeviceOrientation: boolean;
  size: number;
}) {
  const reduceMotion = useReducedMotion();
  const deviceRotation = useSharedValue(0);
  const leftEyeScaleY = useSharedValue(1);
  const rightEyeScaleX = useSharedValue(1);
  const rightEyeScaleY = useSharedValue(1);
  const rightEyeTranslateY = useSharedValue(0);
  const resumeBlinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDeviceAngle = useRef<number | null>(null);
  const accumulatedDeviceRotation = useRef(0);
  const renderedDeviceRotation = useRef(0);

  const stopEyeAnimations = useCallback(() => {
    cancelAnimation(leftEyeScaleY);
    cancelAnimation(rightEyeScaleX);
    cancelAnimation(rightEyeScaleY);
    cancelAnimation(rightEyeTranslateY);
  }, [leftEyeScaleY, rightEyeScaleX, rightEyeScaleY, rightEyeTranslateY]);

  const resetEyes = useCallback(() => {
    leftEyeScaleY.set(1);
    rightEyeScaleX.set(1);
    rightEyeScaleY.set(1);
    rightEyeTranslateY.set(0);
  }, [leftEyeScaleY, rightEyeScaleX, rightEyeScaleY, rightEyeTranslateY]);

  const startIdleBlink = useCallback(() => {
    stopEyeAnimations();
    resetEyes();

    if (animation !== "blink" || reduceMotion) return;

    leftEyeScaleY.set(createBlinkAnimation());
    rightEyeScaleY.set(createBlinkAnimation());
  }, [animation, leftEyeScaleY, reduceMotion, resetEyes, rightEyeScaleY, stopEyeAnimations]);

  useEffect(() => {
    startIdleBlink();

    return () => {
      if (resumeBlinkTimer.current) clearTimeout(resumeBlinkTimer.current);
      stopEyeAnimations();
    };
  }, [startIdleBlink, stopEyeAnimations]);

  useEffect(() => {
    if (!followDeviceOrientation) {
      cancelAnimation(deviceRotation);
      deviceRotation.set(0);
      lastDeviceAngle.current = null;
      accumulatedDeviceRotation.current = 0;
      renderedDeviceRotation.current = 0;
      return;
    }

    let active = true;
    let subscription: ReturnType<typeof DeviceMotion.addListener> | undefined;

    DeviceMotion.setUpdateInterval(ORIENTATION_UPDATE_INTERVAL_MS);
    void DeviceMotion.isAvailableAsync().then((available) => {
      if (!active || !available) return;

      subscription = DeviceMotion.addListener(({ acceleration, accelerationIncludingGravity }) => {
        const x = accelerationIncludingGravity.x - (acceleration?.x ?? 0);
        const y = accelerationIncludingGravity.y - (acceleration?.y ?? 0);
        if (Math.hypot(x, y) < MIN_PLANAR_GRAVITY) return;

        const deviceAngle = -Math.atan2(x, -y) * RADIANS_TO_DEGREES;
        const previousAngle = lastDeviceAngle.current;

        if (previousAngle === null) {
          accumulatedDeviceRotation.current = deviceAngle;
        } else {
          let delta = deviceAngle - previousAngle;
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          accumulatedDeviceRotation.current += delta;
        }

        lastDeviceAngle.current = deviceAngle;
        const nextRotation = accumulatedDeviceRotation.current;
        if (Math.abs(nextRotation - renderedDeviceRotation.current) < ORIENTATION_DEAD_ZONE_DEGREES) return;

        renderedDeviceRotation.current = nextRotation;
        deviceRotation.set(
          reduceMotion
            ? nextRotation
            : withTiming(nextRotation, { duration: ORIENTATION_ROTATION_DURATION_MS, easing: EASE_OUT }),
        );
      });
    });

    return () => {
      active = false;
      subscription?.remove();
      cancelAnimation(deviceRotation);
    };
  }, [deviceRotation, followDeviceOrientation, reduceMotion]);

  const handlePressIn = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (resumeBlinkTimer.current) clearTimeout(resumeBlinkTimer.current);
    stopEyeAnimations();
    resetEyes();

    if (!reduceMotion) {
      leftEyeScaleY.set(
        withSequence(
          ReduceMotion.Never,
          withTiming(0.08, { duration: WINK_CLOSE_DURATION_MS, easing: EASE_OUT }),
          withDelay(WINK_HOLD_DURATION_MS, withTiming(0.08, { duration: 0 })),
          withTiming(1, { duration: WINK_OPEN_DURATION_MS, easing: EASE_OUT }),
        ),
      );
      rightEyeScaleX.set(
        withSequence(
          ReduceMotion.Never,
          withTiming(0.96, { duration: WINK_RIGHT_REACTION_DURATION_MS, easing: EASE_OUT }),
          withTiming(1, { duration: WINK_RIGHT_RECOVERY_DURATION_MS, easing: EASE_OUT }),
        ),
      );
      rightEyeScaleY.set(
        withSequence(
          ReduceMotion.Never,
          withTiming(1.08, { duration: WINK_RIGHT_REACTION_DURATION_MS, easing: EASE_OUT }),
          withTiming(1, { duration: WINK_RIGHT_RECOVERY_DURATION_MS, easing: EASE_OUT }),
        ),
      );
      rightEyeTranslateY.set(
        withSequence(
          ReduceMotion.Never,
          withTiming(-2.4, { duration: WINK_RIGHT_REACTION_DURATION_MS, easing: EASE_OUT }),
          withTiming(0, { duration: WINK_RIGHT_RECOVERY_DURATION_MS, easing: EASE_OUT }),
        ),
      );
    }

    resumeBlinkTimer.current = setTimeout(startIdleBlink, WINK_DURATION_MS);
  }, [
    leftEyeScaleY,
    reduceMotion,
    resetEyes,
    rightEyeScaleX,
    rightEyeScaleY,
    rightEyeTranslateY,
    startIdleBlink,
    stopEyeAnimations,
  ]);

  const leftEyeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: leftEyeScaleY.get() }],
  }));
  const rightEyeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: (rightEyeTranslateY.get() * size) / VIEWBOX_SIZE },
      { scaleX: rightEyeScaleX.get() },
      { scaleY: rightEyeScaleY.get() },
    ],
  }));
  const deviceRotationAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${deviceRotation.get()}deg` }],
  }));

  return { deviceRotationAnimatedStyle, handlePressIn, leftEyeAnimatedStyle, rightEyeAnimatedStyle };
}
