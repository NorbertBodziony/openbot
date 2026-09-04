import { BotEngine, type BotFrame, COLOR_BY_ID, SHAPE_BY_ID, STATE_BY_ID } from "@norbert_bodziony/bloub";
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

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const FPS = 60;
const IDLE_SECONDS = 1.2;
const THINKING_SECONDS = 1.7;
const WIDE_SECONDS = 1;
const CYCLE_SECONDS = IDLE_SECONDS + THINKING_SECONDS + WIDE_SECONDS;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const LOADER_SPRING = { duration: 240, dampingRatio: 0.75, overshootClamping: true, reduceMotion: ReduceMotion.System };
function loaderAppearance() {
  const color = COLOR_BY_ID.get("rose")?.hex;
  const radii = SHAPE_BY_ID.get("squircle")?.radii;
  const idleMorph = STATE_BY_ID.get("idle")?.morph;
  if (!color || !radii || idleMorph === undefined) throw new Error("Bloub loader appearance is unavailable.");
  return { color, radii, idleMorph };
}

const { color: LOADER_COLOR, radii: LOADER_RADII, idleMorph: IDLE_MORPH_SECONDS } = loaderAppearance();

interface BloubAnimationContextValue {
  frameIndex: DerivedValue<number>;
  retainPlayback: () => () => void;
}

const BloubAnimationContext = createContext<BloubAnimationContextValue | null>(null);

export function BloubAnimationProvider({ children }: PropsWithChildren) {
  const [activeLoaders, setActiveLoaders] = useState(0);
  const reducedMotion = useReducedMotion();
  const elapsed = useSharedValue(0);
  const frameIndex = useDerivedValue(() => Math.floor((elapsed.get() / 1000) * FPS));
  const playback = useFrameCallback(({ timeSincePreviousFrame }) => {
    elapsed.set((elapsed.get() + (timeSincePreviousFrame ?? 0)) % (CYCLE_SECONDS * 1000));
  }, false);
  const retainPlayback = useCallback(() => {
    setActiveLoaders((count) => count + 1);
    return () => setActiveLoaders((count) => count - 1);
  }, []);

  useEffect(() => {
    const updatePlayback = () =>
      playback.setActive(activeLoaders > 0 && !reducedMotion && AppState.currentState === "active");
    updatePlayback();
    const subscription = AppState.addEventListener("change", updatePlayback);
    return () => {
      subscription.remove();
      playback.setActive(false);
    };
  }, [activeLoaders, playback, reducedMotion]);

  const value = useMemo(() => ({ frameIndex, retainPlayback }), [frameIndex, retainPlayback]);
  return <BloubAnimationContext.Provider value={value}>{children}</BloubAnimationContext.Provider>;
}

function nativeFrame(frame: BotFrame) {
  return {
    body: { d: frame.bodyPath, opacity: frame.bodyAlpha },
    eyes: frame.eyes.map((eye) => ({
      d: eye.d,
      opacity: eye.alpha,
      matrix: eye.matrix.slice(7, -1).split(",").map(Number),
    })),
    dots: frame.dots.map((dot) => ({ cx: dot.x, cy: dot.y, r: dot.r, opacity: dot.opacity })),
  };
}

type LoaderFrame = ReturnType<typeof nativeFrame>;
const REST_FRAME = nativeFrame(new BotEngine(100, "idle", LOADER_RADII).sample(0));
let cachedFrames: LoaderFrame[] | undefined;

function loaderEngine(seconds = 0): BotEngine {
  const engine = new BotEngine(100, "wide", LOADER_RADII);
  // Include the wide → idle morph at the loop seam, rather than jumping to a reset pose.
  engine.reset("wide", -WIDE_SECONDS);
  engine.setState("idle", 0);
  if (seconds >= IDLE_SECONDS) engine.setState("thinking", IDLE_SECONDS);
  if (seconds >= IDLE_SECONDS + THINKING_SECONDS) engine.setState("wide", IDLE_SECONDS + THINKING_SECONDS);
  return engine;
}

function loaderFrames(): LoaderFrame[] {
  if (cachedFrames) return cachedFrames;
  const engine = loaderEngine();
  cachedFrames = Array.from({ length: Math.round(CYCLE_SECONDS * FPS) }, (_, index) => {
    if (index === Math.round(IDLE_SECONDS * FPS)) engine.setState("thinking", IDLE_SECONDS);
    if (index === Math.round((IDLE_SECONDS + THINKING_SECONDS) * FPS)) {
      engine.setState("wide", IDLE_SECONDS + THINKING_SECONDS);
    }
    return nativeFrame(engine.sample(index / FPS));
  });
  return cachedFrames;
}

function returnToIdleFrames(sourceFrameIndex: number): LoaderFrame[] {
  const seconds = sourceFrameIndex / FPS;
  const engine = loaderEngine(seconds);
  // Reconstruct the current pose, including any unfinished morph, before asking Bloub to settle.
  engine.setState("idle", seconds);
  return Array.from({ length: Math.ceil(IDLE_MORPH_SECONDS * FPS) + 1 }, (_, index) =>
    nativeFrame(engine.sample(seconds + index / FPS)),
  );
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
  const { frameIndex, retainPlayback } = animation;
  const background = useThemeColor("background");
  const reducedMotion = useReducedMotion();
  // Bloub isn't a worklet. Sample its geometry once, then play those frames on the UI thread.
  const frames = useMemo(loaderFrames, []);
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
    return (settling ? settling[Math.floor(idleFrameIndex.get())] : frames[frameIndex.get()]) ?? REST_FRAME;
  });
  const bodyProps = useAnimatedProps(() => frame.get().body);
  const loaderStyle = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ scale: scale.get() }] }));

  useLayoutEffect(() => {
    const revision = ++exitRevision.current;
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
      const settling = returnToIdleFrames(frameIndex.get());
      idleFrames.set(settling);
      idleFrameIndex.set(0);
      idleFrameIndex.set(
        withTiming(
          settling.length - 1,
          {
            duration: IDLE_MORPH_SECONDS * 1000,
            easing: Easing.linear,
            reduceMotion: ReduceMotion.System,
          },
          (finished) => {
            if (finished) {
              scale.set(
                withSequence(
                  withTiming(1.08, { duration: 80, easing: EASE_OUT }),
                  withSpring(0, LOADER_SPRING, (exitFinished) => {
                    if (exitFinished) scheduleOnRN(finishExit, revision);
                  }),
                ),
              );
            }
          },
        ),
      );
    }
    return () => {
      exitRevision.current += 1;
      cancelAnimation(idleFrameIndex);
      cancelAnimation(scale);
      cancelAnimation(opacity);
    };
  }, [finishExit, frameIndex, idleFrameIndex, idleFrames, opacity, reducedMotion, scale, visible]);
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
