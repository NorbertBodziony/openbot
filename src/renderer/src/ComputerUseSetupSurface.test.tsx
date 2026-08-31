import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseSetupSurface } from "./ComputerUseSetupSurface";
import { createMockOpenBot, type MockOpenBotControls } from "./preview/mock-openbot";

let mock: MockOpenBotControls | undefined;
const previousApi = window.openbot;

afterEach(() => {
  mock?.dispose();
  mock = undefined;
  window.openbot = previousApi;
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("ComputerUseSetupSurface", () => {
  it("supports drag, keyboard fallback, and Escape", async () => {
    window.history.replaceState(null, "", "/?surface=computer-use-setup&permission=accessibility");
    mock = createMockOpenBot();
    window.openbot = mock.api;
    const startDrag = vi.spyOn(mock.api, "startComputerUseHelperDrag");
    const reveal = vi.spyOn(mock.api, "revealComputerUseHelper");
    const close = vi.spyOn(mock.api, "closeComputerUsePermissionSetup");
    const view = render(() => <ComputerUseSetupSurface />);

    const dragCard = await view.findByRole("button", { name: /Drag Codex Computer Use into System Settings/ });
    await fireEvent.dragStart(dragCard);
    expect(startDrag).toHaveBeenCalledTimes(1);

    await fireEvent.click(dragCard);
    expect(reveal).toHaveBeenCalledTimes(1);

    await fireEvent.keyDown(view.getByRole("main"), { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
