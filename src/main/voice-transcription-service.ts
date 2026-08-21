import { type ChildProcess, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { VoiceTranscriptionResult } from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";

const TRANSCRIPTION_TIMEOUT_MS = 180_000;

export class VoiceTranscriptionService {
  private activeChild: ChildProcess | null = null;
  private busy = false;

  constructor(private readonly resourcesRoot: string) {}

  async transcribe(audio: Uint8Array): Promise<VoiceTranscriptionResult> {
    if (this.busy) throw new Error("A voice transcription is already in progress.");
    this.busy = true;
    let temporaryRoot: string | undefined;
    const executable = join(
      this.resourcesRoot,
      "bin",
      process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli",
    );
    const model = join(this.resourcesRoot, "model", "ggml-small-q5_1.bin");
    const startedAt = Date.now();

    try {
      temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-voice-"));
      const inputPath = join(temporaryRoot, "recording.wav");
      const outputPath = join(temporaryRoot, "transcript");
      await writeFile(inputPath, audio);
      await this.run(executable, [
        "--model",
        model,
        "--file",
        inputPath,
        "--language",
        "auto",
        "--output-txt",
        "--output-file",
        outputPath,
        "--no-timestamps",
        "--no-gpu",
        "--threads",
        "4",
      ]);
      const text = (await readFile(`${outputPath}.txt`, "utf8")).trim();
      if (text.length > INPUT_LIMITS.messageText) throw new Error("The voice transcript is too long.");
      console.info(`Voice transcription completed in ${Date.now() - startedAt}ms.`);
      return { text };
    } catch (error) {
      console.error(`Voice transcription failed after ${Date.now() - startedAt}ms.`, errorCategory(error));
      throw userFacingError(error);
    } finally {
      this.activeChild = null;
      this.busy = false;
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  shutdown(): void {
    this.activeChild?.kill();
    this.activeChild = null;
  }

  private run(executable: string, arguments_: string[]): Promise<void> {
    return new Promise((resolveRun, rejectRun) => {
      const child = execFile(executable, arguments_, { windowsHide: true });
      this.activeChild = child;
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-4_000);
      });
      const timer = setTimeout(() => {
        child.kill();
        rejectRun(new Error("Voice transcription timed out."));
      }, TRANSCRIPTION_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectRun(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolveRun();
        else rejectRun(new Error(`Whisper exited with ${signal ?? `code ${String(code)}`}: ${stderr.trim()}`));
      });
    });
  }
}

function errorCategory(error: unknown): "unknown" | "runtime-unavailable" | "timeout" | "inference-failed" {
  if (!(error instanceof Error)) return "unknown";
  if (errorCode(error) === "ENOENT") return "runtime-unavailable";
  if (error.message.includes("timed out")) return "timeout";
  return "inference-failed";
}

function userFacingError(error: unknown): Error {
  if (error instanceof Error && error.message.includes("timed out")) return error;
  if (error instanceof Error && errorCode(error) === "ENOENT") {
    return new Error("Local voice transcription is unavailable. Run `bun run voice:prepare` and restart OpenBot.");
  }
  return new Error("OpenBot could not transcribe this recording.");
}

function errorCode(error: Error): string | undefined {
  const code = "code" in error ? error.code : undefined;
  return isString(code) ? code : undefined;
}
