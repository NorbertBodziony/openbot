import type { AgentProviderId, AppSetupState } from "@openbot/contracts/ipc";
import { onCleanup } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { InitialSetup } from "../src/components/InitialSetup";
import { STORY_AGENT_STATUS } from "./fixtures";
import { createMockOpenBot } from "./mock-openbot";

const setupState: AppSetupState = { completed: false, preferredProvider: null };

function MockedInitialSetup(props: { args: Parameters<typeof InitialSetup>[0] }) {
  const previousApi = window.openbot;
  const mock = createMockOpenBot();
  window.openbot = mock.api;
  onCleanup(() => {
    mock.dispose();
    window.openbot = previousApi;
  });
  return <InitialSetup {...props.args} />;
}

const args: Parameters<typeof InitialSetup>[0] = {
  state: setupState,
  agentStatus: STORY_AGENT_STATUS,
  platform: "darwin",
  accountEmail: "person@example.com",
  onSave: async (_provider: AgentProviderId) => undefined,
  onJoinRemote: async () => undefined,
  onLogout: async () => undefined,
  onClose: fn(),
};

const meta = {
  title: "Setup/InitialSetup",
  component: InitialSetup,
  args,
  parameters: { layout: "fullscreen" },
  render: (storyArgs) => <MockedInitialSetup args={storyArgs} />,
} satisfies Meta<typeof InitialSetup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalSetup: Story = {};

export const ReviewingPermissions: Story = {
  args: {
    reviewing: true,
    state: { completed: true, preferredProvider: "codex" },
  },
};

export const AgentBlocked: Story = {
  args: {
    agentStatus: {
      ...STORY_AGENT_STATUS,
      phase: "blocked",
      message: "Claude CLI is not installed.",
      providers: STORY_AGENT_STATUS.providers?.map((provider) =>
        provider.id === "claude"
          ? { ...provider, state: "not-installed" as const, message: "Install Claude CLI." }
          : provider,
      ),
    },
  },
};
