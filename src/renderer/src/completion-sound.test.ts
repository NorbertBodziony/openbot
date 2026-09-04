import type { AgentEvent, AgentSummary } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { playCompletionSoundForAgentEvent, shouldPlayCompletionSound } from "./completion-sound";

const agent = { id: "chief", notifications: true } satisfies Pick<AgentSummary, "id" | "notifications">;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("completion sound", () => {
  it("plays only for successful turns from notification-enabled agents", () => {
    expect(shouldPlayCompletionSound(completed("completed"), [agent], storage())).toBe(true);
    expect(shouldPlayCompletionSound(completed("failed"), [agent], storage())).toBe(false);
    expect(shouldPlayCompletionSound(completed("interrupted"), [agent], storage())).toBe(false);
    expect(shouldPlayCompletionSound(completed("completed"), [{ ...agent, notifications: false }], storage())).toBe(
      false,
    );
    expect(shouldPlayCompletionSound(completed("completed"), [], storage())).toBe(false);
    expect(shouldPlayCompletionSound({ type: "agents-changed", agents: [] }, [agent], storage())).toBe(false);
  });

  it("defaults to enabled and honors the persisted opt-out", () => {
    expect(shouldPlayCompletionSound(completed("completed"), [agent], storage())).toBe(true);
    expect(shouldPlayCompletionSound(completed("completed"), [agent], storage("false"))).toBe(false);
  });

  it("schedules one short descending plop and releases its nodes", async () => {
    const frequency = audioParam();
    const volume = audioParam();
    const oscillator = {
      type: "square",
      frequency,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn((_event: string, listener: () => void) => listener()),
    };
    const gain = { gain: volume, connect: vi.fn(), disconnect: vi.fn() };
    const context = {
      state: "running",
      currentTime: 2,
      destination: {},
      resume: vi.fn(),
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gain),
    };
    const AudioContextMock = vi.fn(function AudioContextMock() {
      return context;
    });
    vi.stubGlobal("AudioContext", AudioContextMock);

    playCompletionSoundForAgentEvent(completed("completed"), [agent], storage());
    await vi.waitFor(() => expect(oscillator.start).toHaveBeenCalledWith(2));

    expect(oscillator.type).toBe("sine");
    expect(frequency.setValueAtTime).toHaveBeenCalledWith(420, 2);
    expect(frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(160, 2.18);
    expect(volume.exponentialRampToValueAtTime).toHaveBeenLastCalledWith(0.0001, 2.22);
    expect(oscillator.stop).toHaveBeenCalledWith(2.22);
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
  });
});

function completed(status: string): AgentEvent {
  return {
    type: "turn-completed",
    agentId: "chief",
    threadId: "thread-chief",
    turnId: "turn-1",
    status,
  };
}

function storage(value: string | null = null): Pick<Storage, "getItem"> {
  return { getItem: vi.fn(() => value) };
}

function audioParam() {
  return {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}
