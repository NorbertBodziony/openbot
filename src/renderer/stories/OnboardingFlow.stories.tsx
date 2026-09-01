import type { AgentProviderId, AgentStatus, AppSetupState, ProviderRuntimeStatus } from "@openbot/contracts/ipc";
import { createSignal, onCleanup } from "solid-js";
import { expect, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { OnboardingFlow } from "../src/components/OnboardingFlow";
import { Toaster, toast } from "../src/components/ui";
import { STORY_AGENT_STATUS } from "./fixtures";
import { createMockOpenBot } from "./mock-openbot";

const setupState: AppSetupState = { completed: false, preferredProvider: null };

const noProvidersConnectedAgentStatus: AgentStatus = {
  ...STORY_AGENT_STATUS,
  phase: "blocked",
  cliVersion: null,
  auth: { kind: "unknown" },
  providers: [
    {
      id: "codex",
      state: "sign-in-required",
      version: "0.149.1",
      message: "Connect ChatGPT to continue.",
    },
    {
      id: "claude",
      state: "sign-in-required",
      version: "2.1.246",
      message: "Connect Claude to continue.",
    },
    {
      id: "grok",
      state: "sign-in-required",
      version: "1.0.5",
      message: "Connect Grok to continue.",
    },
  ],
  capabilities: { ...STORY_AGENT_STATUS.capabilities, chat: "unavailable" },
  message: "Connect ChatGPT or Claude to create a local Bot.",
};

const checkingProvidersAgentStatus: AgentStatus = {
  ...noProvidersConnectedAgentStatus,
  phase: "starting",
  providers: noProvidersConnectedAgentStatus.providers?.map((provider) => ({
    ...provider,
    state: "checking",
    message: null,
  })),
  message: "Checking local AI providers…",
};

const bothConnectingAgentStatus: AgentStatus = {
  ...noProvidersConnectedAgentStatus,
  providers: noProvidersConnectedAgentStatus.providers?.map((provider) => ({
    ...provider,
    connectionState: "connecting" as const,
    message: null,
  })),
};

const lazyProviderAgentStatus: AgentStatus = {
  ...noProvidersConnectedAgentStatus,
  providers: noProvidersConnectedAgentStatus.providers?.map((provider) => ({
    ...provider,
    state: "not-installed",
    connectionState: undefined,
    message: null,
  })),
};

const initialRuntimeStatuses = (): Record<AgentProviderId, ProviderRuntimeStatus> => ({
  codex: { phase: "not-downloaded", progress: null, message: null, version: null },
  claude: { phase: "not-downloaded", progress: null, message: null, version: null },
  grok: { phase: "not-downloaded", progress: null, message: null, version: null },
});

function MockedOnboardingFlow(props: { args: Parameters<typeof OnboardingFlow>[0]; permissions?: boolean }) {
  const previousApi = window.openbot;
  const mock = createMockOpenBot();
  if (props.permissions) {
    mock.api.getComputerUseMacSetupState = async () => ({
      status: "available",
      helperName: "Codex Computer Use",
      helperIconDataUrl: null,
      message: null,
    });
  }
  window.openbot = mock.api;
  onCleanup(() => {
    mock.dispose();
    toast.dismiss();
    window.openbot = previousApi;
  });
  return (
    <>
      <OnboardingFlow {...props.args} />
      <Toaster />
    </>
  );
}

function RefreshResettingFlow(props: { args: Parameters<typeof OnboardingFlow>[0] }) {
  const [agentStatus, setAgentStatus] = createSignal(bothConnectingAgentStatus);
  const [refreshingProviders, setRefreshingProviders] = createSignal(false);
  return (
    <MockedOnboardingFlow
      args={{
        ...props.args,
        agentStatus: agentStatus(),
        refreshingProviders: refreshingProviders(),
        onRefreshProviders: async () => {
          setRefreshingProviders(true);
          await props.args.onRefreshProviders?.();
          await new Promise((resolve) => setTimeout(resolve, 100));
          setAgentStatus(noProvidersConnectedAgentStatus);
          setRefreshingProviders(false);
        },
      }}
    />
  );
}

function LazyProviderDownloadsFlow(props: { args: Parameters<typeof OnboardingFlow>[0]; failGrokOnce?: boolean }) {
  const [agentStatus, setAgentStatus] = createSignal(lazyProviderAgentStatus);
  const [runtimeStatuses, setRuntimeStatuses] = createSignal(initialRuntimeStatuses());
  const [grokFailed, setGrokFailed] = createSignal(false);
  const providerTimers = new Map<AgentProviderId, Set<number>>();

  function rememberTimer(provider: AgentProviderId, timer: number): number {
    const timers = providerTimers.get(provider) ?? new Set<number>();
    timers.add(timer);
    providerTimers.set(provider, timers);
    return timer;
  }

  function clearProviderTimers(provider: AgentProviderId): void {
    for (const timer of providerTimers.get(provider) ?? []) {
      window.clearInterval(timer);
      window.clearTimeout(timer);
    }
    providerTimers.delete(provider);
  }

  function updateRuntime(provider: AgentProviderId, status: Partial<ProviderRuntimeStatus>): void {
    setRuntimeStatuses((current) => ({ ...current, [provider]: { ...current[provider], ...status } }));
  }

  function updateProvider(
    provider: AgentProviderId,
    update: Partial<NonNullable<AgentStatus["providers"]>[number]>,
  ): void {
    setAgentStatus((current) => ({
      ...current,
      providers: current.providers?.map((candidate) =>
        candidate.id === provider ? { ...candidate, ...update } : candidate,
      ),
    }));
  }

  function finishDownload(provider: AgentProviderId): void {
    updateRuntime(provider, { phase: "finishing", progress: 100 });
    rememberTimer(
      provider,
      window.setTimeout(() => {
        providerTimers.delete(provider);
        updateRuntime(provider, { phase: "ready", progress: 100 });
        updateProvider(provider, { state: "sign-in-required", message: `Connect ${provider} to continue.` });
      }, 700),
    );
  }

  function downloadProvider(provider: AgentProviderId): void {
    clearProviderTimers(provider);
    updateProvider(provider, { state: "not-installed", connectionState: undefined, message: null });
    updateRuntime(provider, { phase: "downloading", progress: 0 });
    let progress = 0;
    const interval = window.setInterval(() => {
      progress = Math.min(100, progress + 4);
      if (props.failGrokOnce && provider === "grok" && !grokFailed() && progress >= 56) {
        window.clearInterval(interval);
        providerTimers.delete(provider);
        setGrokFailed(true);
        updateRuntime(provider, {
          phase: "download-error",
          progress: 55,
          message: "The download was interrupted. Try again.",
        });
        return;
      }
      updateRuntime(provider, { phase: "downloading", progress });
      if (progress < 100) return;
      window.clearInterval(interval);
      providerTimers.delete(provider);
      finishDownload(provider);
    }, 160);
    rememberTimer(provider, interval);
  }

  function cancelProviderDownload(provider: AgentProviderId): void {
    clearProviderTimers(provider);
    updateRuntime(provider, { phase: "not-downloaded", progress: null });
  }

  function connectProvider(provider: AgentProviderId): void {
    clearProviderTimers(provider);
    updateProvider(provider, { connectionState: "connecting", message: null });
    rememberTimer(
      provider,
      window.setTimeout(() => {
        providerTimers.delete(provider);
        updateProvider(provider, { state: "available", connectionState: undefined, message: null });
      }, 1_200),
    );
  }

  onCleanup(() => {
    for (const provider of ["codex", "claude", "grok"] as const) clearProviderTimers(provider);
  });

  return (
    <MockedOnboardingFlow
      args={{
        ...props.args,
        agentStatus: agentStatus(),
        providerRuntimeStatuses: runtimeStatuses(),
        onDownloadProvider: downloadProvider,
        onCancelProviderDownload: cancelProviderDownload,
        onConnectProvider: connectProvider,
        onRefreshProviders: undefined,
      }}
    />
  );
}

const args: Parameters<typeof OnboardingFlow>[0] = {
  state: setupState,
  agentStatus: STORY_AGENT_STATUS,
  platform: "darwin",
  onSave: async (_provider: AgentProviderId) => undefined,
};

const meta = {
  title: "Setup/OnboardingFlow",
  component: OnboardingFlow,
  args,
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        onboardingNarrow: {
          name: "Onboarding — 420 × 760",
          styles: { width: "420px", height: "760px" },
        },
      },
    },
  },
  render: (storyArgs) => <MockedOnboardingFlow args={storyArgs} />,
} satisfies Meta<typeof OnboardingFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Initial: Story = {};

export const OptionalPermissions: Story = {
  render: (storyArgs) => <MockedOnboardingFlow args={storyArgs} permissions />,
};

export const NoProvidersConnected: Story = {
  args: {
    agentStatus: noProvidersConnectedAgentStatus,
    onConnectProvider: fn(),
    onRefreshProviders: fn(),
  },
  play: async ({ args: storyArgs, canvas, userEvent }) => {
    const providers = canvas.getByRole("radiogroup", { name: "Default provider" });
    await expect(within(providers).getByRole("radio", { name: /ChatGPT/ })).not.toBeChecked();
    await expect(within(providers).getByRole("radio", { name: /Claude/ })).toBeEnabled();
    await expect(within(providers).getByRole("radio", { name: /Grok/ })).toBeEnabled();

    await userEvent.click(canvas.getByRole("button", { name: "Connect ChatGPT" }));
    await userEvent.click(canvas.getByRole("button", { name: "Connect Claude" }));
    await userEvent.click(canvas.getByRole("button", { name: "Connect Grok" }));
    await userEvent.click(canvas.getByRole("button", { name: "Refresh providers" }));

    await expect(storyArgs.onConnectProvider).toHaveBeenCalledWith("codex");
    await expect(storyArgs.onConnectProvider).toHaveBeenCalledWith("claude");
    await expect(storyArgs.onConnectProvider).toHaveBeenCalledWith("grok");
    await expect(storyArgs.onRefreshProviders).toHaveBeenCalledOnce();
    await expect(canvas.getByRole("button", { name: "Next" })).toBeDisabled();
  },
};

export const RefreshingProviders: Story = {
  args: {
    agentStatus: checkingProvidersAgentStatus,
    refreshingProviders: true,
    onConnectProvider: fn(),
    onRefreshProviders: fn(),
  },
  play: async ({ canvas }) => {
    const providers = canvas.getByRole("radiogroup", { name: "Default provider" });
    await expect(canvas.getByRole("button", { name: "Checking providers" })).toBeDisabled();
    await expect(canvas.queryByRole("button", { name: /^Install / })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Connect ChatGPT" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Connect Claude" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Connect Grok" })).toBeDisabled();
    await expect(within(providers).getByRole("radio", { name: /ChatGPT/ })).toBeEnabled();
    await expect(within(providers).getByRole("radio", { name: /Claude/ })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Next" })).toBeDisabled();
  },
};

export const ConnectedWithRefreshWarning: Story = {
  args: {
    agentStatus: {
      ...STORY_AGENT_STATUS,
      providers: STORY_AGENT_STATUS.providers?.map((provider) =>
        provider.id === "codex"
          ? {
              ...provider,
              checkError: "Could not verify ChatGPT. Keeping the existing connection.",
            }
          : provider,
      ),
    },
    onConnectProvider: fn(),
    onRefreshProviders: fn(),
  },
};

export const ConnectingChatGPT: Story = {
  args: {
    agentStatus: {
      ...noProvidersConnectedAgentStatus,
      providers: noProvidersConnectedAgentStatus.providers?.map((provider) =>
        provider.id === "codex" ? { ...provider, connectionState: "connecting", message: null } : provider,
      ),
    },
    onConnectProvider: fn(),
    onRefreshProviders: fn(),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Restart ChatGPT" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Connect Claude" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Refresh providers" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Next" })).toBeDisabled();
  },
};

export const ConnectingClaude: Story = {
  args: {
    agentStatus: {
      ...noProvidersConnectedAgentStatus,
      providers: noProvidersConnectedAgentStatus.providers?.map((provider) =>
        provider.id === "claude" ? { ...provider, connectionState: "connecting", message: null } : provider,
      ),
    },
    onConnectProvider: fn(),
    onRefreshProviders: fn(),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Restart Claude" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Connect ChatGPT" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Refresh providers" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Next" })).toBeDisabled();
  },
};

export const ConnectingBoth: Story = {
  args: {
    agentStatus: bothConnectingAgentStatus,
    onConnectProvider: fn(),
    onRefreshProviders: fn(),
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Restart ChatGPT" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Restart Claude" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Refresh providers" })).toBeEnabled();
  },
};

export const RefreshResettingConnections: Story = {
  args: {
    agentStatus: bothConnectingAgentStatus,
    onConnectProvider: fn(),
    onRefreshProviders: fn(),
  },
  render: (storyArgs) => <RefreshResettingFlow args={storyArgs} />,
  play: async ({ args: storyArgs, canvas, userEvent }) => {
    await expect(canvas.getByRole("button", { name: "Restart ChatGPT" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Restart Claude" })).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "Refresh providers" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Connect ChatGPT" })).toBeEnabled());
    await expect(canvas.getByRole("button", { name: "Connect Claude" })).toBeEnabled();
    await expect(storyArgs.onRefreshProviders).toHaveBeenCalledOnce();
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};

export const ConnectedWithReconnect: Story = {
  args: {
    agentStatus: STORY_AGENT_STATUS,
    onConnectProvider: fn(),
    onRefreshProviders: fn(),
  },
  play: async ({ canvas }) => {
    const providers = canvas.getByRole("radiogroup", { name: "Default provider" });
    await expect(within(providers).getByRole("radio", { name: /ChatGPT/ })).toBeChecked();
    await expect(canvas.getByRole("button", { name: "Reconnect ChatGPT" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Reconnect Claude" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Next" })).toBeEnabled();
  },
};

export const LazyProviderDownloads: Story = {
  args: {
    agentStatus: lazyProviderAgentStatus,
  },
  render: (storyArgs) => <LazyProviderDownloadsFlow args={storyArgs} />,
};

export const LazyProviderDownloadsWithFailure: Story = {
  args: {
    agentStatus: lazyProviderAgentStatus,
  },
  render: (storyArgs) => <LazyProviderDownloadsFlow args={storyArgs} failGrokOnce />,
};
