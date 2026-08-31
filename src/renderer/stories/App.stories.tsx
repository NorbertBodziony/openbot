import { onCleanup } from "solid-js";
import { expect, fireEvent, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { App } from "../src/App";
import type { MockOpenBotOptions } from "../src/preview/mock-openbot";
import { OpenBotPlayground } from "../src/preview/OpenBotPlayground";
import { STORY_AGENT_STATUS, STORY_APP_INFO, STORY_BOT_SUMMARIES, STORY_SERVERS } from "./fixtures";

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
    const trigger = await canvas.findByRole("button", { name: "Open account actions" });
    const usageTrigger = await canvas.findByRole("button", { name: /Weekly usage/ });
    const settingsTrigger = await canvas.findByRole("button", { name: "Settings" });
    const dock = canvasElement.querySelector<HTMLElement>(".account-dock");
    const rail = canvasElement.querySelector<HTMLElement>(".server-rail");
    const sidebar = canvasElement.querySelector<HTMLElement>(".sidebar");
    if (!dock || !rail || !sidebar) throw new Error("The combined account dock is incomplete.");

    await waitFor(() => {
      const dockWidth = dock.getBoundingClientRect().width;
      const navigationWidth = rail.getBoundingClientRect().width + sidebar.getBoundingClientRect().width;
      expect(Math.abs(dockWidth - navigationWidth)).toBeLessThan(1);
    });

    await userEvent.click(usageTrigger);
    const usagePopover = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Weekly usage",
    });
    await expect(within(usagePopover).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(usageTrigger).toHaveFocus());

    await userEvent.click(trigger);
    const popover = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Account actions",
    });
    await expect(within(popover).getByRole("button", { name: "Marketplace" })).toBeInTheDocument();
    await expect(within(popover).getByRole("button", { name: "Providers & permissions" })).toBeInTheDocument();
    await expect(within(popover).getByRole("button", { name: "Send feedback" })).toBeInTheDocument();
    await expect(within(popover).getByRole("button", { name: "Message" })).toBeInTheDocument();
    await expect(within(popover).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    await expect(within(popover).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        within(canvasElement.ownerDocument.body).queryByRole("dialog", { name: "Account actions" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.keyboard("{Enter}");
    await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Account actions" });
    await userEvent.click(canvas.getByRole("main", { name: "Conversation" }));
    await waitFor(() =>
      expect(
        within(canvasElement.ownerDocument.body).queryByRole("dialog", { name: "Account actions" }),
      ).not.toBeInTheDocument(),
    );

    await userEvent.click(settingsTrigger);
    await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "General" });
  },
};

export const CompactAccountMenu: Story = {
  render: () => <SidebarStatePlayground compact={true} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await canvas.findByRole("heading", { name: "Chief" });
    const trigger = await canvas.findByRole("button", { name: "Open account menu" });
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

    await userEvent.click(trigger);
    const popover = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Account actions",
    });
    await expect(within(popover).getByRole("button", { name: "Marketplace" })).toBeInTheDocument();
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

    await userEvent.click(await canvas.findByRole("button", { name: "Open account menu" }));
    const popover = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "Account actions",
    });
    await expect(within(popover).getByRole("button", { name: "Marketplace" })).toBeInTheDocument();
  },
};

export const LongAccountEmail: Story = {
  render: () => (
    <SidebarStatePlayground
      compact={false}
      options={{
        authState: {
          status: "signed_in",
          user: {
            id: "user-long-name",
            email: "norbert.bodziony.with.a.very.long.workspace.profile@example.com",
            name: "Norbert Bodziony",
            avatarUrl: null,
          },
        },
      }}
    />
  ),
  play: async ({ canvas }) => {
    const trigger = await canvas.findByRole("button", { name: "Open account actions" });
    const accountName = trigger.querySelector<HTMLElement>("strong");
    const accountEmail = trigger.querySelector<HTMLElement>(".account-dock-copy > span:not(.sr-only)");
    if (!accountName) throw new Error("The account name is missing from the dock.");
    if (!accountEmail) throw new Error("The account email is missing from the dock.");
    await expect(accountName).toHaveTextContent("Norbert Bodziony");
    await expect(accountEmail).toHaveTextContent("norbert.bodziony.with.a.very.long.workspace.profile@example.com");
    await expect(getComputedStyle(accountEmail).textOverflow).toBe("ellipsis");
    await expect(accountEmail.scrollWidth).toBeGreaterThan(accountEmail.clientWidth);
  },
};

export const EmptyWorkspace: Story = {
  render: () => (
    <OpenBotPlayground
      options={{
        bots: [],
        servers: STORY_SERVERS.filter((server) => server.kind === "local"),
        presence: { serverId: "local", updatedAt: "2026-08-24T12:00:00.000Z", members: [] },
        directThreads: [],
        teamMembers: [],
        browserTabs: [],
        remoteDesktopSessions: [],
      }}
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.findByText("No chats yet")).resolves.toBeInTheDocument();
    await expect(canvas.queryByRole("heading", { name: "People" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "OpenBot team server" })).not.toBeInTheDocument();
    await expect(canvas.getAllByRole("listitem")).toHaveLength(6);

    const createButton = canvas.getByRole("button", { name: "Create Bot" });
    await expect(createButton).toBeDisabled();
    const nameInput = canvas.getByRole("textbox", { name: "Name" });
    const purposeInput = canvas.getByRole("textbox", { name: "What should this Bot help with?" });
    await expect(nameInput).toHaveValue("New Bot");
    await expect(purposeInput).toHaveValue("");
  },
};

export const IncompatibleRemoteHost: Story = {
  render: () => (
    <OpenBotPlayground
      options={{
        servers: [
          { ...STORY_SERVERS[0], active: false },
          {
            ...STORY_SERVERS[1],
            active: true,
            state: "incompatible",
            compatibility: {
              localAppVersion: "44.0.0",
              hostAppVersion: "42.0.0",
              localProtocol: { minimum: 2, maximum: 2 },
              hostProtocol: { minimum: 1, maximum: 1 },
              negotiatedProtocol: null,
              capabilities: [],
            },
            issue: {
              code: "host_update_required",
              message: "Update OpenBot on the host.",
              retryable: true,
            },
          },
        ],
      }}
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.findByRole("heading", { name: "Update OpenBot on OpenBot team" })).resolves.toBeInTheDocument();
    await expect(canvas.getByText("44.0.0")).toBeInTheDocument();
    await expect(canvas.getByText("42.0.0")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeEnabled();
  },
};

export const DifferentRemoteVersions: Story = {
  render: () => (
    <OpenBotPlayground
      options={{
        servers: [
          { ...STORY_SERVERS[0], active: false },
          {
            ...STORY_SERVERS[1],
            active: true,
            compatibility: {
              localAppVersion: "44.0.0",
              hostAppVersion: "43.0.0",
              localProtocol: { minimum: 1, maximum: 1 },
              hostProtocol: { minimum: 1, maximum: 1 },
              negotiatedProtocol: 1,
              capabilities: [
                "agent-runtime-snapshots",
                "browser-control",
                "conversation-pagination",
                "direct-messages",
                "remote-desktop",
                "sidebar-layout",
              ],
            },
            connectionSequence: 1,
          },
        ],
      }}
    />
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.findByRole("heading", { name: "Chief" })).resolves.toBeInTheDocument();
    await expect(
      within(canvasElement.ownerDocument.body).findByText("Different OpenBot versions on OpenBot team"),
    ).resolves.toBeInTheDocument();
  },
};

export const Onboarding: Story = {
  render: () => <OpenBotPlayground options={{ setupState: { completed: false, preferredProvider: null } }} />,
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.findByRole("heading", { name: "Meet OpenBot" })).resolves.toBeInTheDocument();
    await expect(canvas.getByRole("radiogroup", { name: "Default provider" })).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    await expect(
      canvas.findByRole("heading", { name: "OpenBot might control your computer" }),
    ).resolves.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await expect(canvas.findByRole("heading", { name: "Meet OpenBot" })).resolves.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    await userEvent.click(canvas.getByRole("button", { name: "Next" }));
    await expect(canvas.findByRole("heading", { name: "Give each bot a job" })).resolves.toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Example bot jobs" })).toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "Open OpenBot" }));
    await expect(canvas.findByRole("heading", { name: "Chief" })).resolves.toBeInTheDocument();
  },
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
