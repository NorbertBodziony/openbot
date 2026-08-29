import { spawn } from "node:child_process";

const HAPTIC_THROTTLE_MS = 300;
const HAPTIC_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("Foundation");

const input = $.NSFileHandle.fileHandleWithStandardInput;
const performer = $.NSHapticFeedbackManager.defaultPerformer;
let pending = "";

while (true) {
  const data = input.availableData;
  if (Number(data.length) === 0) break;
  pending += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  const commands = pending.split(String.fromCharCode(10));
  pending = commands.pop();
  for (const command of commands) {
    if (command !== "alignment") continue;
    performer.performFeedbackPatternPerformanceTime(
      $.NSHapticFeedbackPatternAlignment,
      $.NSHapticFeedbackPerformanceTimeNow,
    );
    $.NSThread.sleepForTimeInterval(0.04);
    performer.performFeedbackPatternPerformanceTime(
      $.NSHapticFeedbackPatternAlignment,
      $.NSHapticFeedbackPerformanceTimeNow,
    );
  }
}
`;

export interface HapticProcess {
  write: (command: string) => boolean;
  end: () => void;
  canWrite: () => boolean;
  isRunning: () => boolean;
  kill: () => void;
  onError: (listener: () => void) => void;
  onExit: (listener: () => void) => void;
}

export interface MacHapticFeedbackOptions {
  platform?: NodeJS.Platform;
  now?: () => number;
  spawnProcess?: () => HapticProcess;
}

export class MacHapticFeedback {
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #spawnProcess: () => HapticProcess;
  #process: HapticProcess | null = null;
  #lastHapticAt = Number.NEGATIVE_INFINITY;

  constructor(options: MacHapticFeedbackOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? performance.now.bind(performance);
    this.#spawnProcess = options.spawnProcess ?? spawnHapticProcess;
  }

  prepare(): void {
    if (this.#platform !== "darwin" || this.#process) return;
    this.#start();
  }

  performAlignment(): void {
    if (this.#platform !== "darwin") return;
    const now = this.#now();
    if (now - this.#lastHapticAt < HAPTIC_THROTTLE_MS) return;
    const child = this.#process ?? this.#start();
    if (!child?.canWrite()) return;
    try {
      if (child.write("alignment\n")) this.#lastHapticAt = now;
    } catch {
      this.#clear(child);
    }
  }

  destroy(): void {
    const child = this.#process;
    this.#process = null;
    if (!child) return;
    child.end();
    if (child.isRunning()) child.kill();
  }

  #start(): HapticProcess | null {
    try {
      const child = this.#spawnProcess();
      this.#process = child;
      child.onError(() => this.#clear(child));
      child.onExit(() => this.#clear(child));
      return child;
    } catch {
      return null;
    }
  }

  #clear(child: HapticProcess): void {
    if (this.#process === child) this.#process = null;
  }
}

function spawnHapticProcess(): HapticProcess {
  const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", HAPTIC_SCRIPT], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  return {
    write: (command) => {
      if (!child.stdin.writable || child.stdin.destroyed) return false;
      return child.stdin.write(command);
    },
    end: () => child.stdin.end(),
    canWrite: () => child.stdin.writable && !child.stdin.destroyed,
    isRunning: () => child.exitCode === null,
    kill: () => {
      child.kill("SIGTERM");
    },
    onError: (listener) => child.once("error", listener),
    onExit: (listener) => child.once("exit", listener),
  };
}
