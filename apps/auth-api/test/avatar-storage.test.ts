import { describe, expect, it } from "vitest";
import {
  AvatarUploadError,
  avatarObjectKey,
  avatarVersion,
  readAvatarUpload,
} from "../src/server/avatar-storage";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const VERSION = "00000000-0000-4000-8000-000000000002";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("avatar storage", () => {
  it("accepts a bounded image and creates stable object keys", async () => {
    const upload = await readAvatarUpload(
      new Request("https://api.openbot.run/v1/me/avatar", {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: PNG,
      }),
    );
    expect(upload).toEqual({ mimeType: "image/png", bytes: PNG });
    expect(avatarObjectKey(USER_ID, VERSION)).toBe(`users/${USER_ID}/${VERSION}`);
    expect(avatarVersion(`/v1/avatars/${USER_ID}?v=${VERSION}`, USER_ID)).toBe(VERSION);
  });

  it("rejects invalid and unsupported image bodies", async () => {
    await expect(
      readAvatarUpload(
        new Request("https://api.openbot.run/v1/me/avatar", {
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          body: Uint8Array.from([0xff, 0xd8, 0xff]),
        }),
      ),
    ).rejects.toBeInstanceOf(AvatarUploadError);
    await expect(
      readAvatarUpload(
        new Request("https://api.openbot.run/v1/me/avatar", {
          method: "PUT",
          headers: { "Content-Type": "image/gif" },
          body: PNG,
        }),
      ),
    ).rejects.toMatchObject({ status: 415, code: "unsupported_avatar_type" });
  });
});
