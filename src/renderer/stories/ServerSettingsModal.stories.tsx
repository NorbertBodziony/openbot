import { expect, fn, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ServerSettingsModal } from "../src/components/ServerSettingsModal";
import { STORY_HOST_STATUS, STORY_INVITES, STORY_PRESENCE, STORY_SERVERS } from "../src/preview/fixtures";

const localServer = STORY_SERVERS.find((server) => server.kind === "local") ?? STORY_SERVERS[0];
const remoteServer = STORY_SERVERS.find((server) => server.kind === "remote") ?? STORY_SERVERS[1];

const meta = {
  title: "Settings/ServerSettingsModal",
  component: ServerSettingsModal,
  args: {
    open: true,
    onOpenChange: fn(),
    platform: "darwin",
    server: localServer,
    hostStatus: STORY_HOST_STATUS,
    members: STORY_PRESENCE.members,
    invites: STORY_INVITES,
    loading: false,
    loadError: null,
    onRetry: fn(async () => undefined),
    onSaveIdentity: fn(async () => undefined),
    onSetPublished: fn(async () => undefined),
    onCreateInvite: fn(async (input) => ({
      id: "invite-story",
      inviteUrl: "https://team.example.com/invite/story",
      expiresAt: "2026-08-29T10:00:00.000Z",
      role: input.role,
      usedAt: null,
      email: input.email ?? null,
    })),
    onUpdateMember: fn(async () => undefined),
    onRemoveMember: fn(async () => undefined),
    onRevokeInvite: fn(async () => undefined),
  },
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    viewport: {
      options: {
        serverDesktop: {
          name: "Server settings — 1200 × 820",
          styles: { width: "1200px", height: "820px" },
        },
        serverMinimum: {
          name: "Server settings — 960 × 640",
          styles: { width: "960px", height: "640px" },
        },
      },
    },
  },
} satisfies Meta<typeof ServerSettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalFirstSetup: Story = {
  args: {
    server: { ...localServer, name: "Local", state: "online", apiUrl: null },
    hostStatus: {
      ...STORY_HOST_STATUS,
      phase: "unconfigured",
      configured: false,
      enabledOnLaunch: false,
      serverId: null,
      serverName: null,
      logoUrl: null,
      apiUrl: null,
      apiOnline: false,
      remoteDesktopReady: false,
      remoteDesktopUnattended: false,
      remoteDesktopActiveSessions: 0,
      remoteDesktopMaxSessions: 4,
    },
    members: [],
    invites: [],
  },
  play: async ({ userEvent }) => {
    const dialog = await within(document.body).findByRole("dialog", { name: "General" });
    const name = within(dialog).getByRole("textbox", { name: "Server name" });
    await expect(name).toHaveValue("");
    await userEvent.type(name, "First server");
    await expect(name).toHaveValue("First server");
  },
};

export const LocalOnline: Story = {
  play: async ({ userEvent }) => {
    const dialog = await within(document.body).findByRole("dialog", { name: "General" });
    const name = within(dialog).getByRole("textbox", { name: "Server name" });
    await expect(name).toHaveValue("Local");
    await userEvent.clear(name);
    await userEvent.type(name, "Local studio");
    await expect(name).toHaveValue("Local studio");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await expect(name).toHaveValue("Local");
    await expect(within(dialog).getByRole("switch", { name: "Publish this server" })).toBeChecked();
  },
};

export const RemoteAdministrator: Story = {
  args: {
    server: { ...remoteServer, role: "admin" },
    hostStatus: null,
  },
};

export const RemoteMember: Story = {
  args: {
    server: { ...remoteServer, role: "member" },
    hostStatus: null,
    invites: [],
  },
  play: async () => {
    const body = within(document.body);
    await body.findByRole("dialog", { name: "General" });
    await expect(body.queryByRole("textbox", { name: "Server name" })).not.toBeInTheDocument();
    await expect(body.getByText(remoteServer.name, { selector: ".server-settings-readonly-value" })).toBeVisible();
    body.getByRole("button", { name: "Members" }).click();
    await expect(body.queryByRole("button", { name: "Send invite" })).not.toBeInTheDocument();
  },
};

export const RemoteDesktop: Story = {
  args: {
    server: { ...remoteServer, role: "admin" },
    hostStatus: null,
  },
  play: async () => {
    const body = within(document.body);
    await body.findByRole("dialog", { name: "General" });
    body.getByRole("button", { name: "Remote desktop" }).click();
    await expect(body.getByText("Service available")).toBeVisible();
    await expect(body.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  },
};
