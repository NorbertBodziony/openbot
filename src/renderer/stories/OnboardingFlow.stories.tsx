import type { AgentProviderId, AppSetupState } from "@openbot/contracts/ipc";
import { onCleanup } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { OnboardingFlow } from "../src/components/OnboardingFlow";
import { STORY_AGENT_STATUS } from "./fixtures";
import { createMockOpenBot } from "./mock-openbot";

const setupState: AppSetupState = { completed: false, preferredProvider: null };

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
  parameters: { layout: "fullscreen" },
  render: (storyArgs) => <MockedOnboardingFlow args={storyArgs} />,
} satisfies Meta<typeof OnboardingFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Initial: Story = {};

export const OptionalPermissions: Story = {
  render: (storyArgs) => <MockedOnboardingFlow args={storyArgs} permissions />,
};
