import { BotEngine } from "@norbert_bodziony/bloub";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { useDerivedValue, useFrameCallback, useReducedMotion, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import {
  type BloubActivityFrame,
  bloubActivityFrames,
  bloubActivityGeometry,
  cycleEngine,
  FPS,
  FRAME_COUNT,
  nativeFrame,
  SETTLE,
} from "../model/bloub-activity";

interface Playback {
  frames: BloubActivityFrame[];
  index: number;
  loopStart: number | null;
}

export function useBloubActivityFrame(seed: string, working: boolean) {
  const focused = useIsFocused();
  const reducedMotion = useReducedMotion();
  const [playing, setPlaying] = useState(false);
  const geometry = useMemo(() => bloubActivityGeometry(seed), [seed]);
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
    if (reducedMotion || !focused) {
      setPlaying(false);
      playback.set({ frames: [rest], index: 0, loopStart: null });
    } else if (working) {
      // Reuse sampled paths across the header, activity row, and later working turns.
      const frames = bloubActivityFrames(geometry);
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
      const engine = cycleEngine(geometry, seconds, current.index >= FRAME_COUNT);
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
