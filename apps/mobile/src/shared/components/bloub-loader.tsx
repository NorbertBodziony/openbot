import { useThemeColor } from "heroui-native/hooks";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import Animated, {
  cancelAnimation,
  type DerivedValue,
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";

import {
  CYCLE_SECONDS,
  FPS,
  IDLE_MORPH_SECONDS,
  LOADER_COLOR,
  type LoaderFrame,
  prepareLoaderFrames,
  prepareReturnToIdleFrames,
  REST_FRAME,
} from "@/shared/lib/bloub-loader-frames";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const LOADER_SPRING = { duration: 240, dampingRatio: 0.75, overshootClamping: true, reduceMotion: ReduceMotion.System };
interface BloubAnimationContextValue {
  frameIndex: DerivedValue<number>;
  frames: LoaderFrame[] | null;
  retainPlayback: () => () => void;
}

const BloubAnimationContext = createContext<BloubAnimationContextValue | null>(null);

export function BloubAnimationProvider({ children }: PropsWithChildren) {
  const [activeLoaders, setActiveLoaders] = useState(0);
  const [frames, setFrames] = useState<LoaderFrame[] | null>(null);
  const reducedMotion = useReducedMotion();
  // Start after the loop's wide → idle seam so REST_FRAME doesn't jump to wide
  // eyes when preparation completes. Later loops still include the whole seam.
  const elapsed = useSharedValue(IDLE_MORPH_SECONDS * 1000);
  const frameIndex = useDerivedValue(() => Math.floor((elapsed.get() / 1000) * FPS));
  const playback = useFrameCallback(({ timeSincePreviousFrame }) => {
    elapsed.set((elapsed.get() + (timeSincePreviousFrame ?? 0)) % (CYCLE_SECONDS * 1000));
  }, false);
  const retainPlayback = useCallback(() => {
    setActiveLoaders((count) => count + 1);
    return () => setActiveLoaders((count) => count - 1);
  }, []);

  const shouldPrepare = activeLoaders > 0 && !reducedMotion && frames === null;
  useEffect(() => {
    // The root loader stays mounted, even while hidden. First commit REST_FRAME;
    // prepare one shared sequence only when an animated loader is actually active.
    if (shouldPrepare) return prepareLoaderFrames(setFrames);
  }, [shouldPrepare]);

  useEffect(() => {
    const updatePlayback = () =>
      playback.setActive(frames !== null && activeLoaders > 0 && !reducedMotion && AppState.currentState === "active");
    updatePlayback();
    const subscription = AppState.addEventListener("change", updatePlayback);
    return () => {
      subscription.remove();
      playback.setActive(false);
    };
  }, [activeLoaders, frames, playback, reducedMotion]);

  const value = useMemo(() => ({ frameIndex, frames, retainPlayback }), [frameIndex, frames, retainPlayback]);
  return <BloubAnimationContext.Provider value={value}>{children}</BloubAnimationContext.Provider>;
}

function LoaderEye({ frame, index, fill }: { frame: DerivedValue<LoaderFrame>; index: number; fill: string }) {
  const props = useAnimatedProps(() => frame.get().eyes[index] ?? { d: "", opacity: 0, matrix: [1, 0, 0, 1, 0, 0] });
  return <AnimatedPath fill={fill} animatedProps={props} />;
}

function LoaderDot({ frame, index, fill }: { frame: DerivedValue<LoaderFrame>; index: number; fill: string }) {
  const props = useAnimatedProps(() => frame.get().dots[index] ?? { cx: 0, cy: 0, r: 0, opacity: 0 });
  return <AnimatedCircle fill={fill} animatedProps={props} />;
}

export function BloubLoader({
  label,
  active = true,
  visible = true,
  onExitComplete,
}: {
  label: string;
  active?: boolean;
  visible?: boolean;
  onExitComplete?: () => void;
}) {
  const animation = useContext(BloubAnimationContext);
  if (!animation) throw new Error("BloubLoader requires BloubAnimationProvider.");
  const { frameIndex, frames, retainPlayback } = animation;
  const background = useThemeColor("background");
  const reducedMotion = useReducedMotion();
  const idleFrames = useSharedValue<LoaderFrame[] | null>(null);
  const idleFrameIndex = useSharedValue(0);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const exitRevision = useRef(0);
  const finishExit = useCallback(
    (revision: number) => {
      if (exitRevision.current === revision) onExitComplete?.();
    },
    [onExitComplete],
  );
  const frame = useDerivedValue(() => {
    if (reducedMotion) return REST_FRAME;
    const settling = idleFrames.get();
    return (settling ? settling[Math.floor(idleFrameIndex.get())] : frames?.[frameIndex.get()]) ?? REST_FRAME;
  });
  const bodyProps = useAnimatedProps(() => frame.get().body);
  const loaderStyle = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ scale: scale.get() }] }));

  useLayoutEffect(() => {
    const revision = ++exitRevision.current;
    let cancelPreparation: (() => void) | undefined;
    if (reducedMotion) {
      scale.set(1);
      opacity.set(
        withTiming(visible ? 1 : 0, { duration: 150, reduceMotion: ReduceMotion.Never }, (finished) => {
          if (finished && !visible) scheduleOnRN(finishExit, revision);
        }),
      );
    } else if (visible) {
      idleFrames.set(null);
      opacity.set(1);
      scale.set(withSpring(1, LOADER_SPRING));
    } else {
      const scaleDown = () => {
        "worklet";
        scale.set(
          withSequence(
            withTiming(1.08, { duration: 80, easing: EASE_OUT }),
            withSpring(0, LOADER_SPRING, (finished) => {
              if (finished) scheduleOnRN(finishExit, revision);
            }),
          ),
        );
      };
      if (!frames) {
        // Loading finished before preparation: REST_FRAME is already idle.
        idleFrames.set([REST_FRAME]);
        idleFrameIndex.set(0);
        scaleDown();
      } else {
        const sourceIndex = frameIndex.get();
        // Hold the displayed pose while preparing its settling sequence off the
        // commit path. Otherwise the loop advances and the exit starts with a jump.
        idleFrames.set([frames[sourceIndex] ?? REST_FRAME]);
        idleFrameIndex.set(0);
        cancelPreparation = prepareReturnToIdleFrames(sourceIndex, (settling) => {
          idleFrames.set(settling);
          idleFrameIndex.set(
            withTiming(
              settling.length - 1,
              { duration: IDLE_MORPH_SECONDS * 1000, easing: Easing.linear, reduceMotion: ReduceMotion.System },
              (finished) => {
                if (finished) scaleDown();
              },
            ),
          );
        });
      }
    }
    return () => {
      exitRevision.current += 1;
      cancelPreparation?.();
      cancelAnimation(idleFrameIndex);
      cancelAnimation(scale);
      cancelAnimation(opacity);
    };
  }, [finishExit, frameIndex, frames, idleFrameIndex, idleFrames, opacity, reducedMotion, scale, visible]);
  useEffect(() => {
    if (active) return retainPlayback();
  }, [active, retainPlayback]);

  return (
    <Animated.View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      style={loaderStyle}
    >
      <Svg width={112} height={112} viewBox="-158 -158 316 316" accessible={false} accessibilityElementsHidden>
        <AnimatedPath fill={LOADER_COLOR} animatedProps={bodyProps} />
        <LoaderEye frame={frame} index={0} fill={background} />
        <LoaderEye frame={frame} index={1} fill={background} />
        <LoaderDot frame={frame} index={0} fill={LOADER_COLOR} />
        <LoaderDot frame={frame} index={1} fill={LOADER_COLOR} />
      </Svg>
    </Animated.View>
  );
}
