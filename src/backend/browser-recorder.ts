import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserRecordingArtifact } from "@openbot/contracts/ipc";
import { BrowserWindow, type WebContents } from "electron";
import { z } from "zod";

const MAX_RECORDING_MS = 5 * 60 * 1_000;
const MAX_RECORDING_BYTES = 100 * 1024 * 1024;
const RECORDING_STOP_BYTES = MAX_RECORDING_BYTES - 10 * 1024 * 1024;
const stoppedReasonSchema = z.enum(["requested", "duration-limit", "size-limit", "tab-closed", "error"]);
const recorderResultSchema = z.object({
  base64: z.string(),
  durationMs: z.number(),
  reason: stoppedReasonSchema,
});
const recorderStartErrorSchema = z.object({
  __openbotRecorderError: z.literal(true),
  name: z.string(),
  message: z.string(),
});

interface RecorderSession {
  tabId: string;
  window: BrowserWindow;
  startedAt: number;
  stoppedReason: BrowserRecordingArtifact["stoppedReason"] | null;
}

export class BrowserRecorder {
  readonly #downloadsRoot: string;
  readonly #sessions = new Map<string, RecorderSession>();
  readonly #onStateChanged: (tabId: string, recording: boolean) => void;

  constructor(downloadsRoot: string, onStateChanged: (tabId: string, recording: boolean) => void) {
    this.#downloadsRoot = downloadsRoot;
    this.#onStateChanged = onStateChanged;
  }

  isRecording(tabId: string): boolean {
    return this.#sessions.get(tabId)?.stoppedReason === null;
  }

  async start(tabId: string, contents: WebContents): Promise<void> {
    if (this.#sessions.has(tabId)) throw new Error("This browser tab already has a recording.");
    if (contents.isDestroyed()) throw new Error("Browser tab was closed.");
    const recorderPartition = `openbot-recorder-${randomUUID()}`;
    const recorderWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        webSecurity: true,
        partition: recorderPartition,
      },
    });
    recorderWindow.webContents.session.setPermissionCheckHandler((_webContents, permission) => permission === "media");
    recorderWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) =>
      callback(permission === "media" || permission === "display-capture"),
    );
    recorderWindow.webContents.session.setDisplayMediaRequestHandler(
      (_request, callback) => callback({ video: contents.mainFrame }),
      { useSystemPicker: false },
    );
    const session: RecorderSession = {
      tabId,
      window: recorderWindow,
      startedAt: Date.now(),
      stoppedReason: null,
    };
    this.#sessions.set(tabId, session);
    recorderWindow.on("closed", () => {
      if (this.#sessions.get(tabId) !== session) return;
      this.#sessions.delete(tabId);
      this.#onStateChanged(tabId, false);
    });
    recorderWindow.webContents.on("page-title-updated", (_event, title) => {
      if (!title.startsWith("openbot-recorder:stopped:")) return;
      const reason = title.slice("openbot-recorder:stopped:".length);
      session.stoppedReason = parseStoppedReason(reason);
      this.#onStateChanged(tabId, false);
    });
    try {
      await recorderWindow.webContents.session.protocol.handle(
        "https",
        () =>
          new Response("<!doctype html><title>openbot-recorder:ready</title>", {
            headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" },
          }),
      );
      await recorderWindow.loadURL("https://recorder.openbot.invalid/");
      const sourceId = contents.getMediaSourceId(recorderWindow.webContents);
      const started = recorderStartErrorSchema.safeParse(
        await recorderWindow.webContents.executeJavaScript(startScript(sourceId), true),
      );
      if (started.success) throw new Error(`${started.data.name}: ${started.data.message}`);
      this.#onStateChanged(tabId, true);
    } catch (error) {
      this.#sessions.delete(tabId);
      if (!recorderWindow.isDestroyed()) recorderWindow.destroy();
      throw new Error(`Unable to start browser recording: ${String(error)}`);
    }
  }

  async stop(
    tabId: string,
    requestedReason: BrowserRecordingArtifact["stoppedReason"] = "requested",
  ): Promise<BrowserRecordingArtifact> {
    const session = this.#sessions.get(tabId);
    if (!session) throw new Error("This browser tab is not being recorded.");
    try {
      const result = recorderResultSchema.safeParse(
        await session.window.webContents.executeJavaScript(stopScript(requestedReason), true),
      );
      if (!result.success) throw new Error("Recorder returned invalid video data.");
      const bytes = Buffer.from(result.data.base64, "base64");
      if (bytes.length === 0) throw new Error("Recorder produced an empty video.");
      if (bytes.length > MAX_RECORDING_BYTES) throw new Error("Recorder output exceeds 100 MB.");
      const path = join(
        this.#downloadsRoot,
        `openbot-browser-${new Date(session.startedAt).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.webm`,
      );
      await mkdir(this.#downloadsRoot, { recursive: true });
      await writeFile(path, bytes, { mode: 0o600 });
      return {
        path,
        mimeType: "video/webm",
        bytes: bytes.length,
        durationMs: Math.max(0, result.data.durationMs),
        stoppedReason: session.stoppedReason ?? result.data.reason,
      };
    } finally {
      this.#sessions.delete(tabId);
      if (!session.window.isDestroyed()) session.window.destroy();
      this.#onStateChanged(tabId, false);
    }
  }

  async discard(tabId: string, reason: BrowserRecordingArtifact["stoppedReason"] = "tab-closed"): Promise<void> {
    const session = this.#sessions.get(tabId);
    if (!session) return;
    try {
      await session.window.webContents.executeJavaScript(
        `globalThis.__openbotRecorder?.stop(${JSON.stringify(reason)})`,
        true,
      );
    } catch {
      // Closing a tab or the app must still clean up a failed recorder.
    } finally {
      this.#sessions.delete(tabId);
      if (!session.window.isDestroyed()) session.window.destroy();
      this.#onStateChanged(tabId, false);
    }
  }

  async destroy(): Promise<void> {
    await Promise.allSettled([...this.#sessions.keys()].map((tabId) => this.discard(tabId, "tab-closed")));
  }
}

function startScript(sourceId: string): string {
  return `(async () => {
    let stage = 'initialization';
    try {
    const STOP_BYTES = ${RECORDING_STOP_BYTES};
    const MAX_MS = ${MAX_RECORDING_MS};
    const sourceId = ${JSON.stringify(sourceId)};
    stage = 'getUserMedia';
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: sourceId } },
      });
    } catch {
      stage = 'getDisplayMedia';
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : 'video/webm';
    stage = 'MediaRecorder';
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2500000 });
    const state = {
      chunks: [], bytes: 0, startedAt: performance.now(), reason: null, stopped: null,
      stop(reason) {
        if (this.reason === null) this.reason = reason;
        if (recorder.state !== 'inactive') recorder.stop();
      },
    };
    state.stopped = new Promise(resolve => recorder.addEventListener('stop', () => {
      stream.getTracks().forEach(track => track.stop());
      document.title = 'openbot-recorder:stopped:' + (state.reason || 'requested');
      resolve(true);
    }, { once: true }));
    recorder.addEventListener('dataavailable', event => {
      if (!event.data || event.data.size === 0) return;
      state.chunks.push(event.data); state.bytes += event.data.size;
      if (state.bytes >= STOP_BYTES) state.stop('size-limit');
    });
    globalThis.__openbotRecorder = state;
    stage = 'start'; recorder.start(1000);
    setTimeout(() => state.stop('duration-limit'), MAX_MS);
    return true;
    } catch (error) {
      return { __openbotRecorderError: true, name: String(error?.name || 'Error'), message: stage + ': ' + String(error?.message || error) };
    }
  })()`;
}

function stopScript(reason: BrowserRecordingArtifact["stoppedReason"]): string {
  return `(async () => {
    const state = globalThis.__openbotRecorder;
    if (!state) throw new Error('Recorder is not initialized.');
    state.stop(${JSON.stringify(reason)});
    await state.stopped;
    const blob = new Blob(state.chunks, { type: 'video/webm' });
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
    });
    return {
      base64: String(dataUrl).slice(String(dataUrl).indexOf(',') + 1),
      durationMs: Math.round(performance.now() - state.startedAt),
      reason: state.reason || ${JSON.stringify(reason)},
    };
  })()`;
}

function parseStoppedReason(value: string): BrowserRecordingArtifact["stoppedReason"] {
  return value === "duration-limit" || value === "size-limit" || value === "tab-closed" || value === "error"
    ? value
    : "requested";
}
