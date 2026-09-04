import { BotEngine, type BotFrame, EXPRESSION_BY_ID, SHAPE_BY_ID } from "@norbert_bodziony/bloub";
import { bloubAvatarProfile } from "@openbot/brand/bloub-avatar";

export const FPS = 60;
const IDLE = 1.2;
const THINKING = 1.7;
const WIDE = 1;
const CYCLE = IDLE + THINKING + WIDE;
export const FRAME_COUNT = Math.round(CYCLE * FPS);
export const SETTLE = 0.45;

export function nativeFrame(frame: BotFrame) {
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

// Color and bot identity do not change the sampled geometry.
export function bloubActivityGeometry(seed: string) {
  const profile = bloubAvatarProfile(seed, null);
  const silhouette = SHAPE_BY_ID.get(profile.shape);
  const expression = EXPRESSION_BY_ID.get(profile.expression);
  if (!silhouette || !expression) throw new Error("Bloub avatar profile is invalid.");
  return { key: `${profile.shape}:${profile.expression}`, radii: silhouette.radii, expression };
}

type Geometry = ReturnType<typeof bloubActivityGeometry>;
const MAX_CACHED_SEQUENCES = 8;
const sequences = new Map<string, BloubActivityFrame[]>();

export function cycleEngine(geometry: Geometry, seconds: number, looping: boolean) {
  const engine = new BotEngine(100, "idle", geometry.radii, geometry.expression);
  if (looping) engine.reset("idle", -IDLE);
  engine.setState("thinking", 0);
  if (seconds >= THINKING) engine.setState("wide", THINKING);
  if (seconds >= THINKING + WIDE) engine.setState("idle", THINKING + WIDE);
  return engine;
}

export function bloubActivityFrames(geometry: Geometry): BloubActivityFrame[] {
  const cached = sequences.get(geometry.key);
  if (cached) {
    sequences.delete(geometry.key);
    sequences.set(geometry.key, cached);
    return cached;
  }
  const frames: BloubActivityFrame[] = [];
  for (const looping of [false, true]) {
    const engine = cycleEngine(geometry, 0, looping);
    for (let index = 0; index < FRAME_COUNT; index += 1) {
      if (index === Math.round(THINKING * FPS)) engine.setState("wide", THINKING);
      if (index === Math.round((THINKING + WIDE) * FPS)) engine.setState("idle", THINKING + WIDE);
      frames.push(nativeFrame(engine.sample(index / FPS)));
    }
  }
  // Bound retained SVG data; mounted players keep their own references after eviction.
  const oldest = sequences.keys().next().value;
  if (sequences.size >= MAX_CACHED_SEQUENCES && oldest !== undefined) sequences.delete(oldest);
  sequences.set(geometry.key, frames);
  return frames;
}
