import { onCleanup } from "solid-js";
import { expect } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { App } from "../src/App";
import { STORY_AGENT_STATUS, STORY_BOT_SUMMARIES } from "./fixtures";
import type { MockOpenBotOptions } from "./mock-openbot";
import { createMockOpenBot } from "./mock-openbot";

function MockedApp(props: { options?: MockOpenBotOptions }) {
  const previousApi = window.openbot;
  const mock = createMockOpenBot(props.options);
  window.openbot = mock.api;
  onCleanup(() => {
    mock.dispose();
    window.openbot = previousApi;
  });
  return <App />;
}

const meta = {
  title: "App",
  component: App,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: () => <MockedApp />,
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByRole("navigation", { name: "Chat list" })).toBeInTheDocument();
    await expect(canvas.findByRole("heading", { name: "Agents" })).resolves.toBeInTheDocument();

    const editor = canvas.getByRole("textbox", { name: "Message Chief" });
    await userEvent.click(editor);
    await userEvent.type(editor, "Show me the next step");
    await userEvent.click(canvas.getByRole("button", { name: "Send message" }));

    await expect(canvas.findByText(/Mock reply from Chief: I received/)).resolves.toBeInTheDocument();
  },
};

export const EmptyWorkspace: Story = {
  render: () => <MockedApp options={{ bots: [] }} />,
};

export const Onboarding: Story = {
  render: () => <MockedApp options={{ setupState: { completed: false, preferredProvider: null } }} />,
};

export const SignedOut: Story = {
  render: () => <MockedApp options={{ authState: { status: "signed_out" } }} />,
};

export const AgentStarting: Story = {
  render: () => (
    <MockedApp
      options={{
        agentStatus: {
          ...STORY_AGENT_STATUS,
          phase: "starting",
          message: "Starting local agent CLIs…",
        },
        bots: STORY_BOT_SUMMARIES.slice(0, 1),
      }}
    />
  ),
};
