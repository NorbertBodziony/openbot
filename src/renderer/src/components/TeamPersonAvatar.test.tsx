import type { TeamPresenceMember } from "@openbot/contracts/ipc";
import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { TeamPersonAvatar } from "./TeamPersonAvatar";

const member: TeamPresenceMember = {
  id: "member-1",
  username: "alice@example.com",
  email: "alice@example.com",
  name: "Alice",
  avatarUrl: "https://api.openbot.run/v1/avatars/member-1?v=image-1",
  role: "member",
  createdAt: "2026-08-19T08:00:00.000Z",
  disabled: false,
  online: true,
  typingBotId: null,
};

describe("TeamPersonAvatar", () => {
  it("uses an agent avatar when the account image cannot load", async () => {
    const view = render(() => <TeamPersonAvatar member={member} />);

    const image = view.container.querySelector("img");
    if (!(image instanceof HTMLImageElement)) throw new Error("Avatar image is missing.");
    await fireEvent.error(image);

    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector(".person-avatar-generated.bot-avatar-bloub > svg")).not.toBeNull();
  });

  it("uses an agent avatar when the member has no account image", () => {
    const view = render(() => <TeamPersonAvatar member={{ ...member, avatarUrl: null }} />);

    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector(".person-avatar-generated.bot-avatar-bloub > svg")).not.toBeNull();
  });
});
