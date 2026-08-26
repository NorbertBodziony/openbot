import type { AgentProviderId, AgentStatus, AppSetupState } from "@openbot/contracts/ipc";
import { createSignal, onCleanup } from "solid-js";
import { expect, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { OnboardingFlow } from "../src/components/OnboardingFlow";
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

function MockedOnboardingFlow(props: { args: Parameters<typeof OnboardingFlow>[0]; permissions?: boolean }) {
  const previousApi = window.openbot;
  const mock = createMockOpenBot();
  if (props.permissions) {
    mock.api.getMacPermissions = async () => ({
      screenRecording: "unknown",
      accessibility: "unknown",
    });
  }
  window.openbot = mock.api;
  onCleanup(() => {
    mock.dispose();
    window.openbot = previousApi;
  });
  return <OnboardingFlow {...props.args} />;
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
