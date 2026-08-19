import { describe, expect, it } from "vitest";
import { avatarCrop } from "./avatar-image";

describe("avatar image crop", () => {
  it("centers landscape and portrait images in a square", () => {
    expect(avatarCrop(1200, 800)).toEqual({ sourceX: 200, sourceY: 0, sourceSize: 800 });
    expect(avatarCrop(600, 900)).toEqual({ sourceX: 0, sourceY: 150, sourceSize: 600 });
  });

  it("keeps square images unchanged", () => {
    expect(avatarCrop(512, 512)).toEqual({ sourceX: 0, sourceY: 0, sourceSize: 512 });
  });
});
