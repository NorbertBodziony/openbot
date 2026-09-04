import { BotEngine, type BotFrame, EXPRESSION_BY_ID, SHAPE_BY_ID } from "@norbert_bodziony/bloub";
import { bloubAvatarProfile } from "@openbot/brand/bloub-avatar";
import type { BotAvatarHue } from "@openbot/contracts/ipc";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { useDerivedValue, useFrameCallback, useReducedMotion, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const FPS = 60;
const IDLE = 1.2;
const THINKING = 1.7;
const WIDE = 1;
const CYCLE = IDLE + THINKING + WIDE;
const FRAME_COUNT = Math.round(CYCLE * FPS);
const SETTLE = 0.45;

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

export type BloubActivityFrame = ReturnType<typeof nativeFrame>;
interface Playback {
  frames: BloubActivityFrame[];
  index: number;
  loopStart: number | null;
}

export function useBloubActivityFrame(seed: string, hue: BotAvatarHue | null, working: boolean) {
  const focused = useIsFocused();
  const reducedMotion = useReducedMotion();
  const [playing, setPlaying] = useState(false);
  const geometry = useMemo(() => {
    const profile = bloubAvatarProfile(seed, hue);
    const silhouette = SHAPE_BY_ID.get(profile.shape);
    const expression = EXPRESSION_BY_ID.get(profile.expression);
    if (!silhouette || !expression) throw new Error("Bloub avatar profile is invalid.");
    return { radii: silhouette.radii, expression };
  }, [hue, seed]);
  const rest = useMemo(
    () => nativeFrame(new BotEngine(100, "idle", geometry.radii, geometry.expression).sample(0)),
    [geometry],
  );
  const playback = useSharedValue<Playback>({ frames: [rest], index: 0, loopStart: null });
  const stopPlayback = useCallback(() => {
    const current = playback.get();
    if (current.loopStart === null && current.index >= current.frames.length - 1) setPlaying(false);
  }, [playback]);
  const clock = useFrameCallback(({ timeSincePreviousFrame }) => {
    const current = playback.get();
    let index = current.index + (Math.min(timeSincePreviousFrame ?? 0, 64) * FPS) / 1000;
    if (current.loopStart !== null && index >= current.frames.length) {
      index = current.loopStart + ((index - current.loopStart) % (current.frames.length - current.loopStart));
    } else if (current.loopStart === null) index = Math.min(index, current.frames.length - 1);
    if (index !== current.index)
      playback.modify((value) => {
        value.index = index;
        return value;
      });
    if (current.loopStart === null && index >= current.frames.length - 1) scheduleOnRN(stopPlayback);
  }, false);

  useEffect(() => {
    const update = () => clock.setActive(playing && focused && !reducedMotion && AppState.currentState === "active");
    update();
    const subscription = AppState.addEventListener("change", update);
    return () => {
      subscription.remove();
      clock.setActive(false);
    };
  }, [clock, focused, playing, reducedMotion]);

  useEffect(() => {
    function cycleEngine(seconds: number, looping: boolean) {
      const engine = new BotEngine(100, "idle", geometry.radii, geometry.expression);
      if (looping) engine.reset("idle", -IDLE);
      engine.setState("thinking", 0);
      if (seconds >= THINKING) engine.setState("wide", THINKING);
      if (seconds >= THINKING + WIDE) engine.setState("idle", THINKING + WIDE);
      return engine;
    }
    if (reducedMotion || !focused) {
      setPlaying(false);
      playback.set({ frames: [rest], index: 0, loopStart: null });
    } else if (working) {
      // Bloub is not a worklet: prepare geometry once and play it on the UI thread.
      const frames: BloubActivityFrame[] = [];
      for (const looping of [false, true]) {
        const engine = cycleEngine(0, looping);
        for (let index = 0; index < FRAME_COUNT; index += 1) {
          if (index === Math.round(THINKING * FPS)) engine.setState("wide", THINKING);
          if (index === Math.round((THINKING + WIDE) * FPS)) engine.setState("idle", THINKING + WIDE);
          frames.push(nativeFrame(engine.sample(index / FPS)));
        }
      }
      playback.set({ frames, index: 0, loopStart: FRAME_COUNT });
      setPlaying(true);
    } else {
      const current = playback.get();
      if (current.loopStart === null) {
        setPlaying(false);
        playback.set({ frames: [rest], index: 0, loopStart: null });
        return;
      }
      const seconds = (Math.floor(current.index) % FRAME_COUNT) / FPS;
      const engine = cycleEngine(seconds, current.index >= FRAME_COUNT);
      engine.setState("idle", seconds);
      const frames = Array.from({ length: Math.ceil(SETTLE * FPS) + 1 }, (_, index) =>
        nativeFrame(engine.sample(seconds + index / FPS)),
      );
      playback.set({ frames, index: 0, loopStart: null });
      setPlaying(true);
    }
  }, [focused, geometry, playback, reducedMotion, rest, working]);

  return useDerivedValue(() => {
    const current = playback.get();
    return current.frames[Math.floor(current.index)] ?? rest;
  });
}
