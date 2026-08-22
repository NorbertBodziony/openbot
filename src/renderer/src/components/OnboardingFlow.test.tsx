import type { AgentProviderId, MacPermissionId, MacPermissionsState } from "@openbot/contracts/ipc";
import { fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STORY_AGENT_STATUS } from "../preview/fixtures";
import { createMockOpenBot, type MockOpenBotControls } from "../preview/mock-openbot";
import { OnboardingFlow } from "./OnboardingFlow";

let activeMock: MockOpenBotControls | undefined;
const previousApi = window.openbot;

afterEach(() => {
  activeMock?.dispose();
  activeMock = undefined;
  window.openbot = previousApi;
  vi.restoreAllMocks();
});

function renderFlow(
  options: {
    onSave?: (provider: AgentProviderId) => Promise<void>;
    platform?: "darwin" | "win32" | "linux";
    permissions?: MacPermissionsState;
  } = {},
) {
  activeMock = createMockOpenBot();
  if (options.permissions) {
    activeMock.api.getMacPermissions = async () =>
      options.permissions ?? { screenRecording: "unknown", accessibility: "unknown" };
  }
  window.openbot = activeMock.api;
  const view = render(() => (
    <OnboardingFlow
      state={{ completed: false, preferredProvider: null }}
      agentStatus={STORY_AGENT_STATUS}
      platform={options.platform ?? "darwin"}
      onSave={options.onSave ?? (async (_provider: AgentProviderId) => undefined)}
    />
  ));
  return view;
}

describe("OnboardingFlow", () => {
  it("starts with Meet OpenBot and removes the old connection-choice screen", () => {
    const view = renderFlow();

    expect(view.getByRole("heading", { name: "Meet OpenBot" })).toBeInTheDocument();
    expect(view.queryByRole("heading", { name: "Where will OpenBot run?" })).not.toBeInTheDocument();
    expect(view.container.querySelector(".onboarding-account-row")).not.toBeInTheDocument();
    expect(view.getByRole("radiogroup", { name: "Default provider" })).toBeInTheDocument();
    expect(view.container.querySelectorAll(".provider-picker-logo")).toHaveLength(2);
    expect(view.container.querySelector('.provider-picker-logo[data-provider="codex"]')).toBeInTheDocument();
    expect(view.container.querySelector('.provider-picker-logo[data-provider="claude"]')).toBeInTheDocument();
    const composer = view.getByRole("region", { name: "Example task handoff" });
    expect(within(composer).getByRole("button", { name: "Add to prompt" })).toBeDisabled();
    expect(within(composer).getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("supports provider selection and forward/back navigation", async () => {
    const view = renderFlow();
    const providers = view.getByRole("radiogroup", { name: "Default provider" });
    const claude = within(providers).getByRole("radio", { name: /Claude/ });
    await fireEvent.click(claude);
    await fireEvent.click(view.getByRole("button", { name: "Next" }));

    expect(await view.findByRole("heading", { name: "OpenBot might control your computer" })).toBeInTheDocument();
    await fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(await view.findByRole("heading", { name: "Meet OpenBot" })).toBeInTheDocument();
    expect(claude).toBeChecked();
  });

  it("offers optional macOS permissions and finishes with the selected provider", async () => {
    const view = renderFlow({
      permissions: { screenRecording: "unknown", accessibility: "unknown" },
    });
    const requestPermission = vi.spyOn(activeMock?.api ?? window.openbot, "requestMacPermission");
    await fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(await view.findByRole("heading", { name: "OpenBot might control your computer" })).toBeInTheDocument();
    expect(view.queryByText(/Let your Bots work on this Mac/)).not.toBeInTheDocument();
    expect(view.queryByText("This computer")).not.toBeInTheDocument();
    expect(view.queryByText("Dedicated Mac mini")).not.toBeInTheDocument();
    expect(view.queryByText("Optional", { exact: true })).not.toBeInTheDocument();
    expect(view.container.querySelector(".onboarding-computer-desktop")).toBeInTheDocument();
    expect(view.container.querySelector(".onboarding-computer-desktop-highlight")).toBeInTheDocument();
    expect(view.container.querySelector(".onboarding-computer-desktop-beam")).toBeInTheDocument();
    expect(view.container.querySelectorAll(".onboarding-computer-window")).toHaveLength(1);
    expect(view.container.querySelector(".onboarding-computer-cursor")).toBeInTheDocument();
    expect(view.container.querySelector(".onboarding-computer-avatar")).toBeInTheDocument();
    expect(view.container.querySelector(".onboarding-computer-avatar .bot-avatar-motion-idle")).toBeInTheDocument();
    expect(view.getByRole("region", { name: "Computer permissions" })).toBeInTheDocument();
    expect(view.getByText("Let OpenBot see what is on your screen.")).toBeInTheDocument();
    await waitFor(() => expect(view.getAllByRole("button", { name: "Open Settings" })).toHaveLength(2));

    await fireEvent.click(view.getAllByRole("button", { name: "Open Settings" })[0]);
    await waitFor(() => expect(requestPermission).toHaveBeenCalledWith("screen-recording" satisfies MacPermissionId));
    await waitFor(() => expect(view.getAllByRole("button", { name: "Allowed" })).toHaveLength(2));

    await fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(await view.findByRole("heading", { name: "Give each bot a job" })).toBeInTheDocument();
    expect(view.container.querySelectorAll(".onboarding-job-avatar")).toHaveLength(3);
  });

  it("keeps onboarding open when saving setup fails", async () => {
    const onSave = vi.fn(async (_provider: AgentProviderId) => {
      throw new Error("Setup failed.");
    });
    const view = renderFlow({ onSave });
    await fireEvent.click(view.getByRole("button", { name: "Next" }));
    await fireEvent.click(view.getByRole("button", { name: "Next" }));
    await fireEvent.click(view.getByRole("button", { name: "Open OpenBot" }));

    expect(await view.findByRole("alert")).toHaveTextContent("Setup failed.");
    expect(view.getByRole("heading", { name: "Give each bot a job" })).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledWith("codex");
  });
});
