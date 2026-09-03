import MaskedView from "@react-native-masked-view/masked-view";
import { BlurView } from "expo-blur";
import { type StyleProp, useColorScheme, type ViewStyle } from "react-native";
import Animated, { Extrapolation, interpolate, type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

interface SheetScrollEdgeEffectProps {
  scrollY: SharedValue<number>;
  style: StyleProp<ViewStyle>;
}

export function SheetScrollEdgeEffect({ scrollY, style }: SheetScrollEdgeEffectProps) {
  const colorScheme = useColorScheme();
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.get(), [0, 8, 24], [0, 0.55, 1], Extrapolation.CLAMP),
  }));

  return (
    <Animated.View pointerEvents="none" style={[style, animatedStyle]}>
      <MaskedView
        style={{ flex: 1 }}
        maskElement={
          <Svg height="100%" width="100%">
            <Defs>
              <LinearGradient id="sheet-scroll-edge-mask" x1="0" x2="0" y1="0" y2="1">
                <Stop offset="0" stopColor="#000000" stopOpacity="0.92" />
                <Stop offset="0.5" stopColor="#000000" stopOpacity="0.62" />
                <Stop offset="0.82" stopColor="#000000" stopOpacity="0.18" />
                <Stop offset="1" stopColor="#000000" stopOpacity="0" />
              </LinearGradient>
            </Defs>
            <Rect fill="url(#sheet-scroll-edge-mask)" height="100%" width="100%" />
          </Svg>
        }
      >
        <BlurView
          intensity={52}
          style={{ flex: 1 }}
          tint={colorScheme === "dark" ? "systemChromeMaterialDark" : "systemUltraThinMaterialLight"}
        />
      </MaskedView>
    </Animated.View>
  );
}
