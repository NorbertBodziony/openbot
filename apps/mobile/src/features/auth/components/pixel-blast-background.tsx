import { useEffect } from "react";
import { useWindowDimensions, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useCSSVariable } from "uniwind";

interface PixelSpec {
  color: "accent" | "brand";
  drift: number;
  id: string;
  opacity: number;
  phase: number;
  size: number;
  x: number;
  y: number;
}

const PIXEL_COUNT = 88;
const MOTION_DURATION_MS = 3_000;
const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);

function createPixelField(): PixelSpec[] {
  let seed = 0x6f70656e;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };

  return Array.from({ length: PIXEL_COUNT }, (_, index) => {
    const angle = random() * Math.PI * 2;
    const radius = 0.08 + random() ** 0.62 * 0.68;
    const x = Math.min(0.97, Math.max(0.03, 0.5 + Math.cos(angle) * radius * 0.72));
    const y = Math.min(0.97, Math.max(0.03, 0.42 + Math.sin(angle) * radius));

    return {
      color: index % 4 === 0 ? "accent" : "brand",
      drift: 4 + random() * 7,
      id: `pixel-${index}`,
      opacity: 0.18 + random() * 0.3,
      phase: random(),
      size: 3 + Math.floor(random() * 4),
      x,
      y,
    };
  });
}

const PIXELS = createPixelField();

function Pixel({
  accentColor,
  brandColor,
  height,
  pixel,
  progress,
  reduceMotion,
  width,
}: {
  accentColor: string;
  brandColor: string;
  height: number;
  pixel: PixelSpec;
  progress: SharedValue<number>;
  reduceMotion: boolean;
  width: number;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: pixel.opacity * 0.9 };

    const angle = (progress.get() + pixel.phase) * Math.PI * 2;
    const wave = (Math.sin(angle) + 1) / 2;

    return {
      opacity: pixel.opacity * (0.28 + wave * 0.72),
      transform: [
        { translateX: Math.cos(angle) * pixel.drift },
        { translateY: Math.sin(angle) * pixel.drift },
        { scale: 0.62 + wave * 0.76 },
      ],
    };
  });

  return (
    <Animated.View
      style={[
        {
          backgroundColor: pixel.color === "accent" ? accentColor : brandColor,
          borderCurve: "continuous",
          borderRadius: pixel.size * 0.3,
          height: pixel.size,
          left: pixel.x * width - pixel.size / 2,
          position: "absolute",
          top: pixel.y * height - pixel.size / 2,
          width: pixel.size,
        },
        animatedStyle,
      ]}
    />
  );
}

export function PixelBlastBackground({ active }: { active: boolean }) {
  const { height, width } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const brandColor = String(useCSSVariable("--openbot-logo-production") ?? "#cdadec");
  const accentColor = String(useCSSVariable("--openbot-accent") ?? "#6960f1");

  useEffect(() => {
    cancelAnimation(progress);

    if (!active || reduceMotion) {
      progress.set(0);
      return;
    }

    progress.set(
      withRepeat(
        withTiming(1, {
          duration: MOTION_DURATION_MS,
          easing: EASE_IN_OUT,
          reduceMotion: ReduceMotion.System,
        }),
        -1,
        false,
        undefined,
        ReduceMotion.System,
      ),
    );

    return () => cancelAnimation(progress);
  }, [active, progress, reduceMotion]);

  return (
    <View
      accessibilityElementsHidden
      className="absolute inset-0 overflow-hidden"
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {PIXELS.map((pixel) => (
        <Pixel
          key={pixel.id}
          accentColor={accentColor}
          brandColor={brandColor}
          height={height}
          pixel={pixel}
          progress={progress}
          reduceMotion={reduceMotion}
          width={width}
        />
      ))}
    </View>
  );
}
