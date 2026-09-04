import { BotEngine, type BotFrame, COLOR_BY_ID, SHAPE_BY_ID, STATE_BY_ID } from "@norbert_bodziony/bloub";

// Half the sampled geometry of a 60 fps sequence; playback remains on the UI thread.
export const FPS = 30;
const IDLE_SECONDS = 1.2;
const THINKING_SECONDS = 1.7;
const WIDE_SECONDS = 1;
export const CYCLE_SECONDS = IDLE_SECONDS + THINKING_SECONDS + WIDE_SECONDS;
function loaderAppearance() {
  const color = COLOR_BY_ID.get("rose")?.hex;
  const radii = SHAPE_BY_ID.get("squircle")?.radii;
  const idleMorph = STATE_BY_ID.get("idle")?.morph;
  if (!color || !radii || idleMorph === undefined) throw new Error("Bloub loader appearance is unavailable.");
  return { color, radii, idleMorph };
}

export const { color: LOADER_COLOR, radii: LOADER_RADII, idleMorph: IDLE_MORPH_SECONDS } = loaderAppearance();

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

export type LoaderFrame = ReturnType<typeof nativeFrame>;
export const REST_FRAME = nativeFrame(new BotEngine(100, "idle", LOADER_RADII).sample(0));

function loaderEngine(seconds = 0): BotEngine {
  const engine = new BotEngine(100, "wide", LOADER_RADII);
  // Include the wide → idle morph at the loop seam, rather than jumping to a reset pose.
  engine.reset("wide", -WIDE_SECONDS);
  engine.setState("idle", 0);
  if (seconds >= IDLE_SECONDS) engine.setState("thinking", IDLE_SECONDS);
  if (seconds >= IDLE_SECONDS + THINKING_SECONDS) engine.setState("wide", IDLE_SECONDS + THINKING_SECONDS);
  return engine;
}

function* loaderFrames(): Generator<LoaderFrame> {
  const engine = loaderEngine();
  for (let index = 0; index < Math.round(CYCLE_SECONDS * FPS); index += 1) {
    if (index === Math.round(IDLE_SECONDS * FPS)) engine.setState("thinking", IDLE_SECONDS);
    if (index === Math.round((IDLE_SECONDS + THINKING_SECONDS) * FPS)) {
      engine.setState("wide", IDLE_SECONDS + THINKING_SECONDS);
    }
    yield nativeFrame(engine.sample(index / FPS));
  }
}

function* returnToIdleFrames(sourceFrameIndex: number): Generator<LoaderFrame> {
  const seconds = sourceFrameIndex / FPS;
  const engine = loaderEngine(seconds);
  // Reconstruct the displayed pose before asking Bloub to settle.
  engine.setState("idle", seconds);
  for (let index = 0; index <= Math.ceil(IDLE_MORPH_SECONDS * FPS); index += 1) {
    yield nativeFrame(engine.sample(seconds + index / FPS));
  }
}

type Schedule = (callback: () => void) => () => void;

function scheduleIdle(callback: () => void) {
  const id = requestIdleCallback(callback);
  return () => cancelIdleCallback(id);
}

function prepareFrames(source: Generator<LoaderFrame>, onReady: (frames: LoaderFrame[]) => void, schedule: Schedule) {
  const frames: LoaderFrame[] = [];
  // Bloub is not a worklet. Bound each JS slice instead of generating the entire
  // cycle during render or moving the same long blocking job into an effect.
  function batch() {
    for (let count = 0; count < 4; count += 1) {
      const next = source.next();
      if (next.done) {
        onReady(frames);
        return;
      }
      frames.push(next.value);
    }
    cancel = schedule(batch);
  }
  let cancel = schedule(batch);
  return () => cancel();
}

export function prepareLoaderFrames(onReady: (frames: LoaderFrame[]) => void, schedule: Schedule = scheduleIdle) {
  return prepareFrames(loaderFrames(), onReady, schedule);
}

export function prepareReturnToIdleFrames(
  sourceFrameIndex: number,
  onReady: (frames: LoaderFrame[]) => void,
  schedule: Schedule = scheduleIdle,
) {
  return prepareFrames(returnToIdleFrames(sourceFrameIndex), onReady, schedule);
}
