import { isString } from "@openbot/contracts/runtime-values";
import { describe, expect, it } from "vitest";
import { encodeTeamWebRtcPayload, TeamWebRtcPayloadDecoder } from "./team-webrtc-framing";

describe("Team WebRTC payload framing", () => {
  it("fragments and restores text within the negotiated SCTP limit", () => {
    const frames = encodeTeamWebRtcPayload("remote payload ".repeat(100), 128, 7);
    const decoder = new TeamWebRtcPayloadDecoder();
    let decoded: string | ArrayBuffer | undefined;
    for (const frame of frames) {
      expect(isString(frame) ? frame.length : frame.byteLength).toBeLessThanOrEqual(128);
      decoded = decoder.push(frame);
    }
    expect(decoded).toBe("remote payload ".repeat(100));
  });

  it("frames binary payloads without changing their bytes", () => {
    const input = new Uint8Array(400);
    for (let index = 0; index < input.byteLength; index += 1) input[index] = index % 251;
    const decoder = new TeamWebRtcPayloadDecoder();
    let decoded: string | ArrayBuffer | undefined;
    for (const frame of encodeTeamWebRtcPayload(input.buffer, 96, 8)) decoded = decoder.push(frame);
    if (!(decoded instanceof ArrayBuffer)) throw new Error("Expected a binary WebRTC payload.");
    expect(new Uint8Array(decoded)).toEqual(input);
  });

  it("rejects non-contiguous fragments", () => {
    const frames = encodeTeamWebRtcPayload("x".repeat(300), 96, 9);
    const decoder = new TeamWebRtcPayloadDecoder();
    expect(decoder.push(requiredBinaryFrame(frames, 0))).toBeUndefined();
    expect(() => decoder.push(requiredBinaryFrame(frames, 2))).toThrow("contiguous");
  });
});

function requiredBinaryFrame(frames: Array<string | ArrayBuffer>, index: number): ArrayBuffer {
  const frame = frames[index];
  if (!(frame instanceof ArrayBuffer)) throw new Error("Expected a binary WebRTC frame.");
  return frame;
}
