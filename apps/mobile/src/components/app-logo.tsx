import * as Haptics from "expo-haptics";
import { DeviceMotion } from "expo-sensors";
import { useCallback, useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import Animated, {
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
import Svg, { Polyline, Rect } from "react-native-svg";
import { useCSSVariable } from "uniwind";

export type AppLogoAnimation = "none" | "blink";

export interface AppLogoProps {
  animation?: AppLogoAnimation;
  followDeviceOrientation?: boolean;
  interactive?: boolean;
  size?: number;
}

const VIEWBOX_SIZE = 240;
const LEFT_EYE_CENTER_X = 68.88;
const RIGHT_EYE_CENTER_X = 170.88;
const EYE_CENTER_Y = 117;
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

const LEFT_EYE_POINTS =
  "43.55 93.61 64.69 81.41 36.48 108.04 79.67 83.11 35.93 122.88 91.58 90.74 38.9 132.69 97.66 98.76 42.44 138.88 100.43 105.4 46.9 143.83 101.97 112.04 55.08 149.51 101.83 122.52 73.01 152.43 94.14 140.23";
const RIGHT_EYE_POINTS =
  "145.65 93.61 166.79 81.41 140.83 101.52 175.58 81.46 138.3 109.53 183.18 83.63 137.55 117.43 189.67 87.33 139.67 129.39 197.88 95.78 142.92 136.32 201.52 102.48 149.03 143.86 204.07 112.08 159.14 150.37 203.51 124.75 169.28 152.61 199.82 134.98";

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

function resolveColor(value: string | number | undefined, fallback: string): string {
  return String(value ?? fallback);
}

export function AppLogo({
  animation = "none",
  followDeviceOrientation = false,
  interactive = false,
  size = VIEWBOX_SIZE,
}: AppLogoProps) {
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
  const backgroundColor = resolveColor(useCSSVariable("--openbot-logo-production"), "#d6adf2");
  const eyeColor = resolveColor(useCSSVariable("--openbot-logo-eye"), "#040007");

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

  const eyeLayerStyle = {
    height: size,
    left: 0,
    position: "absolute" as const,
    top: 0,
    width: size,
  };

  const logo = (
    <Animated.View style={[{ height: size, transformOrigin: "center", width: size }, deviceRotationAnimatedStyle]}>
      <View
        style={{ height: size, width: size }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}>
          <Rect width={VIEWBOX_SIZE} height={VIEWBOX_SIZE} rx={50} ry={50} fill={backgroundColor} />
        </Svg>

        <Animated.View
          pointerEvents="none"
          style={[
            eyeLayerStyle,
            { transformOrigin: [(LEFT_EYE_CENTER_X * size) / VIEWBOX_SIZE, (EYE_CENTER_Y * size) / VIEWBOX_SIZE, 0] },
            leftEyeAnimatedStyle,
          ]}
        >
          <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}>
            <Polyline
              points={LEFT_EYE_POINTS}
              fill="none"
              stroke={eyeColor}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={9.5}
            />
          </Svg>
        </Animated.View>

        <Animated.View
          pointerEvents="none"
          style={[
            eyeLayerStyle,
            { transformOrigin: [(RIGHT_EYE_CENTER_X * size) / VIEWBOX_SIZE, (EYE_CENTER_Y * size) / VIEWBOX_SIZE, 0] },
            rightEyeAnimatedStyle,
          ]}
        >
          <Svg width={size} height={size} viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}>
            <Polyline
              points={RIGHT_EYE_POINTS}
              fill="none"
              stroke={eyeColor}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={9.5}
            />
          </Svg>
        </Animated.View>
      </View>
    </Animated.View>
  );

  if (!interactive) return logo;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Animate OpenBot logo"
      accessibilityHint="Makes the logo wink"
      onPressIn={handlePressIn}
      pressRetentionOffset={12}
    >
      {logo}
    </Pressable>
  );
}
