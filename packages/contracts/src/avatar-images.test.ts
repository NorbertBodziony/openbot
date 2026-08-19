import { describe, expect, it } from "vitest";
import { avatarFileExtension, isValidAvatarImage } from "./avatar-images";

describe("avatar images", () => {
  it("accepts supported image signatures", () => {
    expect(isValidAvatarImage("image/png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true);
    expect(isValidAvatarImage("image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(isValidAvatarImage("image/webp", bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe(
      true,
    );
  });

  it("rejects mismatched or unsupported image data", () => {
    expect(isValidAvatarImage("image/png", bytes(0xff, 0xd8, 0xff))).toBe(false);
    expect(isValidAvatarImage("image/gif", bytes(0x47, 0x49, 0x46))).toBe(false);
    expect(isValidAvatarImage("image/webp", new Uint8Array())).toBe(false);
  });

  it("maps MIME types to stable file extensions", () => {
    expect(avatarFileExtension("image/png")).toBe("png");
    expect(avatarFileExtension("image/jpeg")).toBe("jpg");
    expect(avatarFileExtension("image/webp")).toBe("webp");
  });
});

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}
