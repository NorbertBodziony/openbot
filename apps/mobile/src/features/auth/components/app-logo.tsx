import { Pressable, View } from "react-native";
import Animated from "react-native-reanimated";
import Svg, { Polyline, Rect } from "react-native-svg";
import { useCSSVariable } from "uniwind";

import { type AppLogoAnimation, useAppLogoMotion } from "@/features/auth/components/use-app-logo-motion";

export type { AppLogoAnimation } from "@/features/auth/components/use-app-logo-motion";

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
const LEFT_EYE_POINTS =
  "43.55 93.61 64.69 81.41 36.48 108.04 79.67 83.11 35.93 122.88 91.58 90.74 38.9 132.69 97.66 98.76 42.44 138.88 100.43 105.4 46.9 143.83 101.97 112.04 55.08 149.51 101.83 122.52 73.01 152.43 94.14 140.23";
const RIGHT_EYE_POINTS =
  "145.65 93.61 166.79 81.41 140.83 101.52 175.58 81.46 138.3 109.53 183.18 83.63 137.55 117.43 189.67 87.33 139.67 129.39 197.88 95.78 142.92 136.32 201.52 102.48 149.03 143.86 204.07 112.08 159.14 150.37 203.51 124.75 169.28 152.61 199.82 134.98";

function resolveColor(value: string | number | undefined, fallback: string): string {
  return String(value ?? fallback);
}

export function AppLogo({
  animation = "none",
  followDeviceOrientation = false,
  interactive = false,
  size = VIEWBOX_SIZE,
}: AppLogoProps) {
  const backgroundColor = resolveColor(useCSSVariable("--openbot-logo-production"), "#d6adf2");
  const eyeColor = resolveColor(useCSSVariable("--openbot-logo-eye"), "#040007");
  const { deviceRotationAnimatedStyle, handlePressIn, leftEyeAnimatedStyle, rightEyeAnimatedStyle } = useAppLogoMotion({
    animation,
    followDeviceOrientation,
    size,
  });
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
