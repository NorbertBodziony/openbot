import { fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockOpenBot, type MockOpenBotControls } from "../preview/mock-openbot";
import { ComputerUseMacSetup } from "./ComputerUseMacSetup";

let mock: MockOpenBotControls | undefined;
const previousApi = window.openbot;

afterEach(() => {
  mock?.dispose();
  mock = undefined;
  window.openbot = previousApi;
  vi.restoreAllMocks();
});

describe("ComputerUseMacSetup", () => {
  it("opens each macOS permission setup and reports that System Settings opened", async () => {
    mock = createMockOpenBot();
    window.openbot = mock.api;
    const openSetup = vi.spyOn(mock.api, "openComputerUsePermissionSetup");
    const view = render(() => <ComputerUseMacSetup platform="darwin" variant="settings" />);

    expect(await view.findByText("Codex Computer Use")).toBeInTheDocument();
    const permissions = view.getByRole("heading", { name: "System permissions" }).closest("section");
    if (!permissions) throw new Error("System permissions section is missing.");
    const actions = within(permissions).getAllByRole("button", { name: "Open settings" });
    await fireEvent.click(actions[0]);

    await waitFor(() => expect(openSetup).toHaveBeenCalledWith("screen-recording"));
    expect(await view.findByText("System Settings opened")).toBeInTheDocument();
  });

  it("shows an actionable unavailable state without permission buttons", async () => {
    mock = createMockOpenBot();
    mock.api.getComputerUseMacSetupState = vi.fn().mockResolvedValue({
      status: "unavailable",
      helperName: "Codex Computer Use",
      helperIconDataUrl: null,
      message: "Install or enable Computer Use.",
    });
    window.openbot = mock.api;
    const view = render(() => <ComputerUseMacSetup platform="darwin" variant="compact" />);

    expect(await view.findByText("Computer Use isn’t available yet")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Set up" })).not.toBeInTheDocument();
  });

  it("does not query Computer Use setup on other platforms", async () => {
    mock = createMockOpenBot();
    window.openbot = mock.api;
    const getState = vi.spyOn(mock.api, "getComputerUseMacSetupState");
    const view = render(() => <ComputerUseMacSetup platform="win32" variant="compact" />);

    expect(view.container).toBeEmptyDOMElement();
    expect(getState).not.toHaveBeenCalled();
  });
});
