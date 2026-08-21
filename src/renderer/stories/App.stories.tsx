import { onCleanup } from "solid-js";
import { expect, fireEvent, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { App } from "../src/App";
import type { MockOpenBotOptions } from "../src/preview/mock-openbot";
import { OpenBotPlayground } from "../src/preview/OpenBotPlayground";
import { STORY_AGENT_STATUS, STORY_APP_INFO, STORY_BOT_SUMMARIES } from "./fixtures";

const meta = {
  title: "App",
  component: App,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

function SidebarStatePlayground(props: { compact: boolean; options?: MockOpenBotOptions }) {
  const key = "openbot:left-panel-collapsed";
  const previous = window.localStorage.getItem(key);
  window.localStorage.setItem(key, props.compact ? "true" : "false");
  onCleanup(() => {
    if (previous === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, previous);
  });
  return <OpenBotPlayground options={props.options} />;
}

export const Playground: Story = {
  render: () => <OpenBotPlayground />,
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
  render: () => <OpenBotPlayground />,
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
  render: () => <OpenBotPlayground />,
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

export const AccountMenu: Story = {
  render: () => <SidebarStatePlayground compact={false} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await canvas.findByRole("heading", { name: "Chief" });
    const dock = canvasElement.querySelector<HTMLElement>(".account-dock");
    const rail = canvasElement.querySelector<HTMLElement>(".server-rail");
    const sidebar = canvasElement.querySelector<HTMLElement>(".sidebar");
    if (!dock || !rail || !sidebar) throw new Error("The combined account dock is incomplete.");

    const dockWidth = dock.getBoundingClientRect().width;
    const navigationWidth = rail.getBoundingClientRect().width + sidebar.getBoundingClientRect().width;
    await expect(Math.abs(dockWidth - navigationWidth)).toBeLessThan(1);

    const trigger = canvas.getByRole("button", { name: "Open account menu" });
    await userEvent.click(trigger);
    const popover = await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Account" });
    await expect(Math.abs(popover.getBoundingClientRect().width - trigger.getBoundingClientRect().width)).toBeLessThan(
      1,
    );
    await expect(within(popover).getByRole("button", { name: "Upload photo" })).toBeInTheDocument();
    await expect(within(popover).getByRole("button", { name: "Providers & permissions" })).toBeInTheDocument();
    await expect(within(popover).getByRole("button", { name: "Send feedback" })).toBeInTheDocument();
    await expect(within(popover).getByRole("button", { name: "Message" })).toBeInTheDocument();
    await expect(within(popover).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  },
};

export const CompactAccountMenu: Story = {
  render: () => <SidebarStatePlayground compact={true} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await canvas.findByRole("heading", { name: "Chief" });
    const dock = canvasElement.querySelector<HTMLElement>(".account-dock");
    const rail = canvasElement.querySelector<HTMLElement>(".server-rail");
    const sidebar = canvasElement.querySelector<HTMLElement>(".sidebar");
    if (!dock || !rail || !sidebar) throw new Error("The compact account dock is incomplete.");

    await waitFor(() => {
      expect(dock).toHaveClass("account-dock-compact");
      const dockWidth = dock.getBoundingClientRect().width;
      const navigationWidth = rail.getBoundingClientRect().width + sidebar.getBoundingClientRect().width;
      expect(Math.abs(dockWidth - navigationWidth)).toBeLessThan(1);
    });

    const trigger = canvas.getByRole("button", { name: "Open account menu" });
    await userEvent.click(trigger);
    const popover = await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Account" });
    await expect(popover.getBoundingClientRect().width).toBeGreaterThanOrEqual(280);
  },
};

export const LinuxAccountMenu: Story = {
  render: () => (
    <SidebarStatePlayground compact={false} options={{ appInfo: { ...STORY_APP_INFO, platform: "linux" } }} />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await canvas.findByRole("heading", { name: "Chief" });
    const dock = canvasElement.querySelector<HTMLElement>(".account-dock");
    const sidebar = canvasElement.querySelector<HTMLElement>(".sidebar");
    if (!dock || !sidebar) throw new Error("The Linux account dock is incomplete.");
    await expect(canvasElement.querySelector(".server-rail")).not.toBeInTheDocument();
    await expect(dock).not.toHaveClass("account-dock-with-server-rail");
    await expect(Math.abs(dock.getBoundingClientRect().width - sidebar.getBoundingClientRect().width)).toBeLessThan(1);

    await userEvent.click(canvas.getByRole("button", { name: "Open account menu" }));
    const popover = await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Account" });
    await expect(Math.abs(popover.getBoundingClientRect().width - dock.getBoundingClientRect().width)).toBeLessThan(1);
  },
};

export const LongAccountName: Story = {
  render: () => (
    <SidebarStatePlayground
      compact={false}
      options={{
        authState: {
          status: "signed_in",
          user: {
            id: "user-long-name",
            email: "norbert.bodziony@example.com",
            name: "Norbert Bodziony with a very long workspace profile name",
            avatarUrl: null,
          },
        },
      }}
    />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await canvas.findByRole("heading", { name: "Chief" });
    const accountName = canvasElement.querySelector<HTMLElement>(".account-dock-copy strong");
    if (!accountName) throw new Error("The account name is missing from the dock.");
    await expect(getComputedStyle(accountName).textOverflow).toBe("ellipsis");
    await expect(accountName.scrollWidth).toBeGreaterThan(accountName.clientWidth);

    await userEvent.click(canvas.getByRole("button", { name: "Open account menu" }));
    const popover = await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Account" });
    await expect(within(popover).getByText("Norbert Bodziony with a very long workspace profile name")).toBeVisible();
  },
};

export const EmptyWorkspace: Story = {
  render: () => <OpenBotPlayground options={{ bots: [] }} />,
};

export const Onboarding: Story = {
  render: () => <OpenBotPlayground options={{ setupState: { completed: false, preferredProvider: null } }} />,
};

export const SignedOut: Story = {
  render: () => <OpenBotPlayground options={{ authState: { status: "signed_out" } }} />,
};

export const AgentStarting: Story = {
  render: () => (
    <OpenBotPlayground
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
