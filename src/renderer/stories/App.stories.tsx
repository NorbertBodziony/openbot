import { onCleanup } from "solid-js";
import { expect, fireEvent, within } from "storybook/test";
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
    editor.textContent = "Show me the next step";
    await fireEvent.input(editor);
    await expect(editor).toHaveTextContent("Show me the next step");
    await userEvent.click(canvas.getByRole("button", { name: "Send message" }));
    await expect(
      canvas.findByText("Show me the next step", undefined, { timeout: 3_000 }),
    ).resolves.toBeInTheDocument();

    await expect(
      canvas.findByText(/Mock reply from Chief: I received/, undefined, { timeout: 3_000 }),
    ).resolves.toBeInTheDocument();
  },
};

export const SettingsTyping: Story = {
  render: () => <MockedApp />,
  play: async ({ canvas, userEvent }) => {
    await canvas.findByRole("heading", { name: "Chief" });
    await userEvent.click(canvas.getByRole("button", { name: "View agent settings" }));

    const name = canvas.getByRole("textbox", { name: "Agent name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Rapid name editing");
    await expect(name).toHaveValue("Rapid name editing");
    await expect(name).toHaveFocus();
    const title = canvas.getByRole("textbox", { name: "Agent title" });
    await userEvent.clear(title);
    await userEvent.type(title, "Every character remains");
    const description = canvas.getByRole("textbox", { name: "Agent description" });
    await userEvent.clear(description);
    await userEvent.type(description, "Drafts survive reactive profile updates.");

    await expect(canvas.getByRole("textbox", { name: "Agent name" })).toHaveValue("Rapid name editing");
    await expect(canvas.getByRole("textbox", { name: "Agent title" })).toHaveValue("Every character remains");
    await expect(canvas.getByRole("textbox", { name: "Agent description" })).toHaveValue(
      "Drafts survive reactive profile updates.",
    );
  },
};

export const CommandSearch: Story = {
  render: () => <MockedApp />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await canvas.findByRole("heading", { name: "Chief" });
    await fireEvent.keyDown(window, { key: "k", metaKey: true });
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole("dialog", { name: "Search OpenBot" });
    const input = page.getByRole("combobox", { name: "Search OpenBot" });
    await expect(dialog).toBeVisible();
    await expect(input).toHaveFocus();

    await userEvent.click(page.getByRole("tab", { name: "Messages" }));
    await userEvent.type(input, "milestone");
    await expect(page.findByRole("option", { name: /launch milestones/i })).resolves.toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.click(page.getByRole("tab", { name: "Bots" }));
    await userEvent.type(input, "research");
    await expect(page.findByRole("option", { name: /Research/ })).resolves.toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.click(page.getByRole("tab", { name: "All" }));
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
