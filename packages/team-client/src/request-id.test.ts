import { describe, expect, it } from "vitest";

import { createTeamRequestId } from "./request-id";

describe("portable Team request ids", () => {
  it("creates a protocol identifier without secure-context Crypto APIs", () => {
    const requestId = createTeamRequestId((size) => {
      expect(size).toBe(16);
      return Uint8Array.from({ length: size }, (_, index) => index);
    });

    expect(requestId).toBe("000102030405060708090a0b0c0d0e0f");
  });

  it("rejects an invalid random source", () => {
    expect(() => createTeamRequestId(() => new Uint8Array(15))).toThrow("16 random bytes");
  });
});
