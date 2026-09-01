import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserRecordingArtifact } from "@openbot/contracts/ipc";
import { BrowserWindow, type WebContents } from "electron";
import { z } from "zod";

const MAX_RECORDING_MS = 5 * 60 * 1_000;
const MAX_RECORDING_BYTES = 100 * 1024 * 1024;
const RECORDING_STOP_BYTES = MAX_RECORDING_BYTES - 10 * 1024 * 1024;
const stoppedReasonSchema = z.enum(["requested", "duration-limit", "size-limit", "tab-closed", "error"]);
const recorderResultSchema = z.object({
  durationMs: z.number(),
  reason: stoppedReasonSchema,
  error: z.string().nullable().optional(),
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
  path: string;
  file: FileHandle;
  bytes: number;
  writeQueue: Promise<void>;
  writeError: Error | null;
  stoppedReason: BrowserRecordingArtifact["stoppedReason"] | null;
  finalizing: Promise<BrowserRecordingArtifact> | null;
  discarding: boolean;
}

export class BrowserRecorder {
  readonly #downloadsRoot: string;
  readonly #sessions = new Map<string, RecorderSession>();
  readonly #artifacts = new Map<string, BrowserRecordingArtifact>();
  readonly #errors = new Map<string, Error>();
  readonly #onStateChanged: (tabId: string, recording: boolean) => void;
  readonly #maxRecordingMs: number;

  constructor(
    downloadsRoot: string,
    onStateChanged: (tabId: string, recording: boolean) => void,
    options: { maxRecordingMs?: number } = {},
  ) {
    this.#downloadsRoot = downloadsRoot;
    this.#onStateChanged = onStateChanged;
    this.#maxRecordingMs = options.maxRecordingMs ?? MAX_RECORDING_MS;
  }

  isRecording(tabId: string): boolean {
    return this.#sessions.get(tabId)?.stoppedReason === null;
  }

  async start(tabId: string, contents: WebContents): Promise<void> {
    const existing = this.#sessions.get(tabId);
    if (existing) {
      if (!existing.finalizing) throw new Error("This browser tab already has a recording.");
      await existing.finalizing.catch(() => undefined);
    }
    if (contents.isDestroyed()) throw new Error("Browser tab was closed.");
    const previousArtifact = this.#artifacts.get(tabId);
    if (previousArtifact) await rm(previousArtifact.path, { force: true }).catch(() => undefined);
    this.#artifacts.delete(tabId);
    this.#errors.delete(tabId);
    await mkdir(this.#downloadsRoot, { recursive: true });
    const startedAt = Date.now();
    const path = join(
      this.#downloadsRoot,
      `openbot-browser-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.webm`,
    );
    const file = await open(path, "wx", 0o600);
    const recorderPartition = `openbot-recorder-${randomUUID()}`;
    let recorderWindow: BrowserWindow;
    try {
      recorderWindow = new BrowserWindow({
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
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
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
      startedAt,
      path,
      file,
      bytes: 0,
      writeQueue: Promise.resolve(),
      writeError: null,
      stoppedReason: null,
      finalizing: null,
      discarding: false,
    };
    this.#sessions.set(tabId, session);
    recorderWindow.on("closed", () => {
      if (this.#sessions.get(tabId) !== session) return;
      void this.#discardSession(session, false);
    });
    recorderWindow.webContents.on("page-title-updated", (_event, title) => {
      if (!title.startsWith("openbot-recorder:stopped:")) return;
      const reason = title.slice("openbot-recorder:stopped:".length);
      session.stoppedReason = parseStoppedReason(reason);
      this.#onStateChanged(tabId, false);
      if (session.discarding || session.finalizing) return;
      session.finalizing = this.#finalizeSession(session, session.stoppedReason);
      void session.finalizing.catch(() => undefined);
    });
    try {
      await recorderWindow.webContents.session.protocol.handle("https", async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/chunk") {
          const chunk = Buffer.from(await request.arrayBuffer());
          const writing = session.writeQueue.then(() => this.#writeChunk(session, chunk));
          session.writeQueue = writing.catch(() => undefined);
          try {
            await writing;
            return new Response(null, { status: 204 });
          } catch (error) {
            session.writeError = error instanceof Error ? error : new Error(String(error));
            return new Response("Unable to save recording chunk.", { status: 500 });
          }
        }
        return new Response("<!doctype html><title>openbot-recorder:ready</title>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'none'; connect-src 'self'",
          },
        });
      });
      await recorderWindow.loadURL("https://recorder.openbot.invalid/");
      const sourceId = contents.getMediaSourceId(recorderWindow.webContents);
      const started = recorderStartErrorSchema.safeParse(
        await recorderWindow.webContents.executeJavaScript(startScript(sourceId, this.#maxRecordingMs), true),
      );
      if (started.success) throw new Error(`${started.data.name}: ${started.data.message}`);
      this.#onStateChanged(tabId, true);
    } catch (error) {
      this.#sessions.delete(tabId);
      if (!recorderWindow.isDestroyed()) recorderWindow.destroy();
      await file.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
      throw new Error(`Unable to start browser recording: ${String(error)}`);
    }
  }

  async stop(
    tabId: string,
    requestedReason: BrowserRecordingArtifact["stoppedReason"] = "requested",
  ): Promise<BrowserRecordingArtifact> {
    const artifact = this.#artifacts.get(tabId);
    if (artifact) {
      this.#artifacts.delete(tabId);
      return artifact;
    }
    const finalizationError = this.#errors.get(tabId);
    if (finalizationError) {
      this.#errors.delete(tabId);
      throw finalizationError;
    }
    const session = this.#sessions.get(tabId);
    if (!session) throw new Error("This browser tab is not being recorded.");
    session.finalizing ??= this.#finalizeSession(session, requestedReason);
    const result = await session.finalizing;
    this.#artifacts.delete(tabId);
    return result;
  }

  async discard(tabId: string, reason: BrowserRecordingArtifact["stoppedReason"] = "tab-closed"): Promise<void> {
    const session = this.#sessions.get(tabId);
    if (session) {
      if (session.finalizing) {
        const artifact = await session.finalizing.catch(() => null);
        if (artifact) await rm(artifact.path, { force: true }).catch(() => undefined);
      } else {
        session.discarding = true;
        try {
          await session.window.webContents.executeJavaScript(stopScript(reason), true);
        } catch {
          // Closing a tab or the app must still clean up a failed recorder.
        }
        await this.#discardSession(session, true);
      }
    }
    const artifact = this.#artifacts.get(tabId);
    if (artifact) await rm(artifact.path, { force: true }).catch(() => undefined);
    this.#artifacts.delete(tabId);
    this.#errors.delete(tabId);
  }

  async destroy(): Promise<void> {
    await Promise.allSettled([...this.#sessions.keys()].map((tabId) => this.discard(tabId, "tab-closed")));
    this.#artifacts.clear();
    this.#errors.clear();
  }

  async #writeChunk(session: RecorderSession, chunk: Buffer): Promise<void> {
    if (session.writeError) throw session.writeError;
    if (chunk.length === 0) return;
    if (session.bytes + chunk.length > MAX_RECORDING_BYTES) throw new Error("Recorder output exceeds 100 MB.");
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await session.file.write(chunk, offset, chunk.length - offset, null);
      if (bytesWritten <= 0) throw new Error("Recorder could not write the complete video chunk.");
      offset += bytesWritten;
    }
    session.bytes += chunk.length;
  }

  async #finalizeSession(
    session: RecorderSession,
    requestedReason: BrowserRecordingArtifact["stoppedReason"],
  ): Promise<BrowserRecordingArtifact> {
    try {
      const result = recorderResultSchema.safeParse(
        await session.window.webContents.executeJavaScript(stopScript(requestedReason), true),
      );
      if (!result.success) throw new Error("Recorder returned invalid video metadata.");
      await session.writeQueue;
      if (session.writeError) throw session.writeError;
      if (result.data.error) throw new Error(`Recorder failed: ${result.data.error}`);
      if (session.bytes === 0) throw new Error("Recorder produced an empty video.");
      await session.file.sync();
      await session.file.close();
      const artifact: BrowserRecordingArtifact = {
        path: session.path,
        mimeType: "video/webm",
        bytes: session.bytes,
        durationMs: Math.max(0, result.data.durationMs),
        stoppedReason: session.stoppedReason ?? result.data.reason,
      };
      this.#artifacts.set(session.tabId, artifact);
      return artifact;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#errors.set(session.tabId, failure);
      await session.file.close().catch(() => undefined);
      await rm(session.path, { force: true }).catch(() => undefined);
      throw failure;
    } finally {
      if (this.#sessions.get(session.tabId) === session) this.#sessions.delete(session.tabId);
      if (!session.window.isDestroyed()) session.window.destroy();
      this.#onStateChanged(session.tabId, false);
    }
  }

  async #discardSession(session: RecorderSession, destroyWindow: boolean): Promise<void> {
    if (this.#sessions.get(session.tabId) === session) this.#sessions.delete(session.tabId);
    await session.writeQueue.catch(() => undefined);
    await session.file.close().catch(() => undefined);
    await rm(session.path, { force: true }).catch(() => undefined);
    if (destroyWindow && !session.window.isDestroyed()) session.window.destroy();
    this.#onStateChanged(session.tabId, false);
  }
}

function startScript(sourceId: string, maxRecordingMs: number): string {
  return `(async () => {
    let stage = 'initialization';
    try {
    const STOP_BYTES = ${RECORDING_STOP_BYTES};
    const MAX_MS = ${maxRecordingMs};
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
      bytes: 0, startedAt: performance.now(), reason: null, stopped: null, pending: Promise.resolve(), error: null,
      stop(reason) {
        if (this.reason === null) this.reason = reason;
        if (recorder.state !== 'inactive') recorder.stop();
      },
    };
    state.stopped = new Promise(resolve => recorder.addEventListener('stop', async () => {
      await state.pending;
      stream.getTracks().forEach(track => track.stop());
      const reason = state.error ? 'error' : (state.reason || 'requested');
      const result = { durationMs: Math.round(performance.now() - state.startedAt), reason, error: state.error };
      document.title = 'openbot-recorder:stopped:' + reason;
      resolve(result);
    }, { once: true }));
    recorder.addEventListener('dataavailable', event => {
      if (!event.data || event.data.size === 0) return;
      state.bytes += event.data.size;
      state.pending = state.pending.then(async () => {
        const response = await fetch('/chunk', { method: 'POST', body: event.data });
        if (!response.ok) throw new Error(await response.text() || 'Unable to save recording chunk.');
      }).catch(error => {
        state.error = String(error?.message || error);
        state.stop('error');
      });
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
    return state.stopped;
  })()`;
}

function parseStoppedReason(value: string): BrowserRecordingArtifact["stoppedReason"] {
  return value === "duration-limit" || value === "size-limit" || value === "tab-closed" || value === "error"
    ? value
    : "requested";
}
