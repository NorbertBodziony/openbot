// @vitest-environment node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceModelService } from "./voice-model-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixturePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-voice-model-"));
  roots.push(root);
  const directory = join(root, "runtimes", "whisper");
  await mkdir(directory, { recursive: true });
  return join(directory, "model.bin");
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function serviceFor(
  path: string,
  data: Uint8Array,
  fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): VoiceModelService {
  return new VoiceModelService({
    modelPath: path,
    downloadUrl: "https://downloads.example/model.bin",
    fetch: fetchMock,
    expectedBytes: data.byteLength,
    expectedSha256: digest(data),
  });
}

describe("VoiceModelService", () => {
  it("uses a verified cached model without network access", async () => {
    const path = await fixturePath();
    const data = new TextEncoder().encode("verified model");
    await writeFile(path, data);
    const fetchMock = vi.fn(async () => new Response());
    const service = serviceFor(path, data, fetchMock);

    expect(await service.prepare()).toEqual({ phase: "ready", progress: 100, message: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams one verified download for concurrent requests and reports progress", async () => {
    const path = await fixturePath();
    const data = new TextEncoder().encode("downloaded model content");
    const fetchMock = vi.fn(async () => new Response(data));
    const service = serviceFor(path, data, fetchMock);
    const progress: Array<number | null> = [];
    service.on("status", (status) => progress.push(status.progress));

    const first = service.prepare();
    const second = service.prepare();
    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ phase: "ready", progress: 100, message: null });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await readFile(path)).toEqual(Buffer.from(data));
    expect(progress).toContain(100);
  });

  it("removes downloads with a bad size or hash and supports a successful retry", async () => {
    const path = await fixturePath();
    const expected = new TextEncoder().encode("expected model");
    const wrongSize = new TextEncoder().encode("short");
    const wrongHash = new TextEncoder().encode("expected modeL");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(wrongSize))
      .mockResolvedValueOnce(new Response(wrongHash))
      .mockResolvedValueOnce(new Response(expected));
    const service = serviceFor(path, expected, fetchMock);

    await expect(service.prepare()).resolves.toMatchObject({ phase: "error" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
    await expect(service.prepare()).resolves.toMatchObject({ phase: "error" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
    await expect(service.prepare()).resolves.toMatchObject({ phase: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cancels an active download during shutdown and removes the partial file", async () => {
    const path = await fixturePath();
    const expected = new TextEncoder().encode("expected model");
    const fetchMock = vi.fn(
      (_url: string | URL | Request, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), {
            once: true,
          });
        }),
    );
    const service = serviceFor(path, expected, fetchMock);
    const preparation = service.prepare();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    service.shutdown();

    await expect(preparation).resolves.toEqual({
      phase: "error",
      progress: null,
      message: "Voice model download was stopped.",
    });
    expect(existsSync(`${path}.part`)).toBe(false);
  });
});
