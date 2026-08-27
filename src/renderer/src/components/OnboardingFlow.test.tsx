import type {
  AgentProviderId,
  AgentStatus,
  MacPermissionId,
  MacPermissionsState,
  ProviderRuntimeStatus,
} from "@openbot/contracts/ipc";
import { fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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
  it("supports provider selection and forward/back navigation", async () => {
    const view = renderFlow();
    const providers = view.getByRole("radiogroup", { name: "Default provider" });
    expect(within(providers).getByRole("radio", { name: /Grok/ })).toBeInTheDocument();
    const claude = within(providers).getByRole("radio", { name: /Claude/ });
    await fireEvent.click(claude);
    await fireEvent.click(view.getByRole("button", { name: "Next" }));

    expect(await view.findByRole("heading", { name: "OpenBot might control your computer" })).toBeInTheDocument();
    await fireEvent.click(view.getByRole("button", { name: "Back" }));
    expect(await view.findByRole("heading", { name: "Meet OpenBot" })).toBeInTheDocument();
    expect(claude).toBeChecked();
  });

  it("persists Grok as the default provider", async () => {
    const onSave = vi.fn(async (_provider: AgentProviderId) => undefined);
    const view = renderFlow({ onSave });
    const providers = view.getByRole("radiogroup", { name: "Default provider" });
    await fireEvent.click(within(providers).getByRole("radio", { name: /Grok/ }));
    await fireEvent.click(view.getByRole("button", { name: "Next" }));
    await fireEvent.click(view.getByRole("button", { name: "Next" }));
    await fireEvent.click(view.getByRole("button", { name: "Open OpenBot" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("grok"));
  });

  it("requests optional macOS permissions before continuing", async () => {
    const view = renderFlow({
      permissions: { screenRecording: "unknown", accessibility: "unknown" },
    });
    const requestPermission = vi.spyOn(activeMock?.api ?? window.openbot, "requestMacPermission");
    await fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(await view.findByRole("heading", { name: "OpenBot might control your computer" })).toBeInTheDocument();
    await waitFor(() => expect(view.getAllByRole("button", { name: "Open Settings" })).toHaveLength(2));

    await fireEvent.click(view.getAllByRole("button", { name: "Open Settings" })[0]);
    await waitFor(() => expect(requestPermission).toHaveBeenCalledWith("screen-recording" satisfies MacPermissionId));
    await waitFor(() => expect(view.getAllByRole("button", { name: "Allowed" })).toHaveLength(2));

    await fireEvent.click(view.getByRole("button", { name: "Next" }));
    expect(await view.findByRole("heading", { name: "Give each bot a job" })).toBeInTheDocument();
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

  it("keeps provider downloads independent and blocks Next until the selected provider connects", async () => {
    activeMock = createMockOpenBot();
    window.openbot = activeMock.api;
    const initialAgentStatus: AgentStatus = {
      ...STORY_AGENT_STATUS,
      providers: STORY_AGENT_STATUS.providers?.map((provider) => ({
        ...provider,
        state: "not-installed",
        connectionState: undefined,
        message: null,
      })),
    };
    const initialRuntimeStatuses: Record<AgentProviderId, ProviderRuntimeStatus> = {
      codex: { phase: "not-downloaded", progress: null, message: null, version: null },
      claude: { phase: "not-downloaded", progress: null, message: null, version: null },
      grok: { phase: "not-downloaded", progress: null, message: null, version: null },
    };
    const [agentStatus, setAgentStatus] = createSignal(initialAgentStatus);
    const [runtimeStatuses, setRuntimeStatuses] = createSignal(initialRuntimeStatuses);
    const onDownloadProvider = vi.fn((provider: AgentProviderId) => {
      setRuntimeStatuses((current) => ({
        ...current,
        [provider]: { phase: "downloading", progress: 20, message: null, version: null },
      }));
    });
    const onCancelProviderDownload = vi.fn((provider: AgentProviderId) => {
      setRuntimeStatuses((current) => ({
        ...current,
        [provider]: { phase: "not-downloaded", progress: null, message: null, version: null },
      }));
    });
    const onConnectProvider = vi.fn((provider: AgentProviderId) => {
      setAgentStatus((current) => ({
        ...current,
        providers: current.providers?.map((candidate) =>
          candidate.id === provider ? { ...candidate, state: "available", connectionState: undefined } : candidate,
        ),
      }));
    });
    const view = render(() => (
      <OnboardingFlow
        state={{ completed: false, preferredProvider: null }}
        agentStatus={agentStatus()}
        platform="darwin"
        providerRuntimeStatuses={runtimeStatuses()}
        onDownloadProvider={onDownloadProvider}
        onCancelProviderDownload={onCancelProviderDownload}
        onConnectProvider={onConnectProvider}
        onSave={async () => undefined}
      />
    ));

    const next = view.getByRole("button", { name: "Next" });
    expect(next).toBeDisabled();
    await fireEvent.click(view.getByRole("button", { name: "Download Grok" }));
    expect(
      within(view.getByRole("radiogroup", { name: "Default provider" })).getByRole("radio", { name: /Grok/ }),
    ).toBeChecked();
    expect(onDownloadProvider).toHaveBeenCalledWith("grok");

    await fireEvent.click(view.getByRole("button", { name: "Download Claude" }));
    await fireEvent.click(view.getByRole("button", { name: "Cancel Grok" }));
    expect(onCancelProviderDownload).toHaveBeenCalledWith("grok");
    expect(view.getByRole("button", { name: "Cancel Claude" })).toBeEnabled();
    expect(next).toBeDisabled();

    setRuntimeStatuses((current) => ({
      ...current,
      claude: { phase: "ready", progress: 100, message: null, version: "2.1.246" },
    }));
    await fireEvent.click(await view.findByRole("button", { name: "Connect Claude" }));
    await waitFor(() => expect(next).toBeEnabled());
    await fireEvent.click(view.getByRole("button", { name: "Reconnect Claude" }));
    expect(onConnectProvider).toHaveBeenCalledTimes(2);
  });
});
