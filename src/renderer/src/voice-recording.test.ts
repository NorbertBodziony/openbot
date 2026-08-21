import { describe, expect, it } from "vitest";
import { appendVoiceTranscript, encodePcmWav } from "./voice-recording";

describe("voice recording", () => {
  it("appends transcripts without replacing an existing draft", () => {
    expect(appendVoiceTranscript("", "  Hello world. ")).toBe("Hello world.");
    expect(appendVoiceTranscript("Existing", "Hello world.")).toBe("Existing Hello world.");
    expect(appendVoiceTranscript("Existing\n", "Hello world.")).toBe("Existing\nHello world.");
    expect(appendVoiceTranscript("Existing", "   ")).toBe("Existing");
  });

  it("encodes canonical mono PCM WAV audio", () => {
    const wav = encodePcmWav(new Float32Array([-1, 0, 1]), 16_000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32_767);
  });
});
