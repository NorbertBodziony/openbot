import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./AgentAvatar";

describe("AgentAvatar", () => {
  it("falls back to Bloub when a custom image fails", async () => {
    const view = render(() => <AgentAvatar seed="chief" hue={215} url="mock-avatar://missing" />);
    const image = view.container.querySelector("img");
    if (!(image instanceof HTMLImageElement)) throw new Error("Custom avatar image is missing.");

    await fireEvent.error(image);

    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector(".bot-avatar-bloub > svg")).not.toBeNull();
  });
});
