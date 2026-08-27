import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { VoiceModelStatus } from "@openbot/contracts/ipc";

export const WHISPER_MODEL_NAME = "ggml-medium-q5_0.bin";
export const WHISPER_MODEL_BYTES = 539_212_467;
export const WHISPER_MODEL_SHA256 = "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f";
export const WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-medium-q5_0.bin";

interface VoiceModelEvents {
  status: [status: VoiceModelStatus];
}

interface VoiceModelServiceOptions {
  modelPath: string;
  downloadUrl: string | null;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  expectedBytes?: number;
  expectedSha256?: string;
}

export class VoiceModelService extends EventEmitter<VoiceModelEvents> {
  readonly #modelPath: string;
  readonly #downloadUrl: string | null;
  readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #expectedBytes: number;
  readonly #expectedSha256: string;
  #status: VoiceModelStatus = { phase: "missing", progress: null, message: null };
  #preparation: Promise<VoiceModelStatus> | null = null;
  #abortController: AbortController | null = null;

  constructor(options: VoiceModelServiceOptions) {
    super();
    this.#modelPath = options.modelPath;
    this.#downloadUrl = options.downloadUrl;
    this.#fetch = options.fetch ?? fetch;
    this.#expectedBytes = options.expectedBytes ?? WHISPER_MODEL_BYTES;
    this.#expectedSha256 = options.expectedSha256 ?? WHISPER_MODEL_SHA256;
  }

  get modelPath(): string {
    return this.#modelPath;
  }

  async getStatus(): Promise<VoiceModelStatus> {
    if (this.#status.phase === "downloading") return this.#copyStatus();
    const ready = await isExpectedModel(this.#modelPath, this.#expectedBytes, this.#expectedSha256);
    this.#setStatus({ phase: ready ? "ready" : "missing", progress: ready ? 100 : null, message: null });
    return this.#copyStatus();
  }

  prepare(): Promise<VoiceModelStatus> {
    if (this.#preparation) return this.#preparation;
    this.#preparation = this.#prepare().finally(() => {
      this.#preparation = null;
      this.#abortController = null;
    });
    return this.#preparation;
  }

  shutdown(): void {
    this.#abortController?.abort();
  }

  async #prepare(): Promise<VoiceModelStatus> {
    if (await isExpectedModel(this.#modelPath, this.#expectedBytes, this.#expectedSha256)) {
      this.#setStatus({ phase: "ready", progress: 100, message: null });
      return this.#copyStatus();
    }
    await rm(this.#modelPath, { force: true });
    if (!this.#downloadUrl) {
      this.#setStatus({
        phase: "error",
        progress: null,
        message: "Local voice transcription assets are unavailable. Run `bun run voice:prepare` and restart OpenBot.",
      });
      return this.#copyStatus();
    }

    const partialPath = `${this.#modelPath}.part`;
    this.#abortController = new AbortController();
    this.#setStatus({ phase: "downloading", progress: 0, message: null });
    try {
      await mkdir(dirname(this.#modelPath), { recursive: true, mode: 0o700 });
      await rm(partialPath, { force: true });
      const response = await this.#fetch(this.#downloadUrl, { signal: this.#abortController.signal });
      if (!response.ok || !response.body) throw new Error(`download-status-${response.status}`);

      const hash = createHash("sha256");
      let receivedBytes = 0;
      let lastProgress = -1;
      const destination = await open(partialPath, "wx", 0o600);
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedBytes += value.byteLength;
          if (receivedBytes > this.#expectedBytes) {
            throw new Error("download-too-large");
          }
          hash.update(value);
          let writtenBytes = 0;
          while (writtenBytes < value.byteLength) {
            const result = await destination.write(value, writtenBytes, value.byteLength - writtenBytes);
            writtenBytes += result.bytesWritten;
          }
          const progress = Math.min(100, Math.floor((receivedBytes / this.#expectedBytes) * 100));
          if (progress !== lastProgress) {
            lastProgress = progress;
            this.#setStatus({ phase: "downloading", progress, message: null });
          }
        }
      } finally {
        await destination.close();
      }
      if (receivedBytes !== this.#expectedBytes || hash.digest("hex") !== this.#expectedSha256) {
        throw new Error("download-integrity-failed");
      }
      await rename(partialPath, this.#modelPath);
      this.#setStatus({ phase: "ready", progress: 100, message: null });
    } catch (error) {
      await rm(partialPath, { force: true });
      const stopped = error instanceof Error && error.name === "AbortError";
      this.#setStatus({
        phase: "error",
        progress: null,
        message: stopped ? "Voice model download was stopped." : "Could not download the voice model. Try again.",
      });
    }
    return this.#copyStatus();
  }

  #setStatus(status: VoiceModelStatus): void {
    this.#status = status;
    this.emit("status", this.#copyStatus());
  }

  #copyStatus(): VoiceModelStatus {
    return { ...this.#status };
  }
}

async function isExpectedModel(path: string, expectedBytes: number, expectedSha256: string): Promise<boolean> {
  if (!existsSync(path) || (await stat(path)).size !== expectedBytes) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex") === expectedSha256;
}
