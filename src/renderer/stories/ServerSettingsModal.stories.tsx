import { expect, fireEvent, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ServerSettingsModal } from "../src/components/ServerSettingsModal";
import { STORY_HOST_STATUS, STORY_INVITES, STORY_PRESENCE, STORY_SERVERS } from "../src/preview/fixtures";

const localServer = STORY_SERVERS.find((server) => server.kind === "local") ?? STORY_SERVERS[0];
const remoteServer = STORY_SERVERS.find((server) => server.kind === "remote") ?? STORY_SERVERS[1];
const denseMembers = Array.from({ length: 4 }, (_, group) =>
  STORY_PRESENCE.members.map((member, index) => ({
    ...member,
    id: `${member.id}-${group}`,
    name: group === 0 ? member.name : `${member.name} ${group + 1}`,
    username: `${member.username}-${group}`,
    email: `member-${group}-${index}@example.com`,
    role: group === 0 ? member.role : "member",
    online: (group + index) % 3 === 0,
  })),
).flat();

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
        serverMobile: {
          name: "Server settings — 640 × 720",
          styles: { width: "640px", height: "720px" },
        },
        serverNarrow: {
          name: "Server settings — 480 × 720",
          styles: { width: "480px", height: "720px" },
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
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog", { name: "General" });
    const name = within(dialog).getByRole("textbox", { name: "Server name" });
    await expect(name).toHaveValue("");
    await expect(name).toHaveAttribute("placeholder", "e.g. Design studio");
  },
};

export const FirstSetupInvalidName: Story = {
  args: LocalFirstSetup.args,
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog", { name: "General" });
    const name = within(dialog).getByRole("textbox", { name: "Server name" });
    await fireEvent.input(name, { target: { value: "Tiny" } });
    await fireEvent.blur(name);
    await expect(within(dialog).getByText("Enter at least 6 characters.")).toBeVisible();
  },
};

export const FirstSetupValidFooter: Story = {
  args: LocalFirstSetup.args,
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog", { name: "General" });
    await fireEvent.input(within(dialog).getByRole("textbox", { name: "Server name" }), {
      target: { value: "First server" },
    });
    await expect(within(dialog).getByRole("button", { name: "Set up server" })).toBeVisible();
  },
};

export const FirstSetupInvalidNameSmallViewport: Story = {
  args: LocalFirstSetup.args,
  parameters: {
    viewport: { defaultViewport: "serverMobile" },
  },
  play: FirstSetupInvalidName.play,
};

export const LocalOnline: Story = {
  args: {
    hostStatus: {
      ...STORY_HOST_STATUS,
      apiUrl: "https://eu-west-1.gateway.example.com/openbot/servers/team_7f3c19a2",
    },
  },
  play: async ({ userEvent }) => {
    const dialog = await within(document.body).findByRole("dialog", { name: "General" });
    const name = within(dialog).getByRole("textbox", { name: "Server name" });
    await expect(name).toHaveValue("Local");
    await fireEvent.input(name, { target: { value: "Local studio" } });
    await expect(name).toHaveValue("Local studio");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await expect(name).toHaveValue("Local");
    await expect(within(dialog).getByRole("switch", { name: "Publish this server" })).toBeChecked();
  },
};

export const FocusedInput: Story = {
  play: async ({ userEvent }) => {
    const dialog = await within(document.body).findByRole("dialog", { name: "General" });
    const name = within(dialog).getByRole("textbox", { name: "Server name" });
    await userEvent.click(name);
    await expect(name).toHaveFocus();
  },
};

export const DirtyFooter: Story = {
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog", { name: "General" });
    const name = within(dialog).getByRole("textbox", { name: "Server name" });
    await fireEvent.input(name, { target: { value: "OpenBot production" } });
    await waitFor(() => expect(within(dialog).getByRole("region", { name: "Unsaved changes" })).toBeVisible());
  },
};

export const ActionError: Story = {
  args: {
    loadError: "The server did not respond. Check the connection and try again.",
  },
};

export const RemoteAdministrator: Story = {
  args: {
    server: { ...remoteServer, role: "admin" },
    hostStatus: null,
  },
};

export const Members: Story = {
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await body.findByRole("dialog", { name: "General" });
    await userEvent.click(body.getByRole("tab", { name: "Members" }));
    await expect(body.getByTestId("server-members-list")).toBeVisible();
  },
};

export const InviteLinkReady: Story = {
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await body.findByRole("dialog", { name: "General" });
    await userEvent.click(body.getByRole("tab", { name: "Members" }));
    await userEvent.click(body.getByRole("tab", { name: "Invite link" }));
    await userEvent.click(body.getByRole("button", { name: "Create link" }));
    await expect(await body.findByRole("textbox", { name: "Invitation link" })).toHaveValue(
      "https://team.example.com/invite/story",
    );
  },
};

export const MembersEmptyResults: Story = {
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await body.findByRole("dialog", { name: "General" });
    await userEvent.click(body.getByRole("tab", { name: "Members" }));
    await userEvent.type(body.getByRole("searchbox", { name: "Search members" }), "nobody");
    await expect(body.getByText("No members match this search.")).toBeVisible();
  },
};

export const MembersUnpublished: Story = {
  args: {
    server: { ...remoteServer, state: "offline", role: "admin" },
    hostStatus: null,
  },
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await body.findByRole("dialog", { name: "General" });
    await userEvent.click(body.getByRole("tab", { name: "Members" }));
    await expect(body.getByRole("status")).toBeVisible();
    await expect(body.getByRole("button", { name: "Send invite" })).toBeDisabled();
  },
};

export const MembersSmallViewport: Story = {
  parameters: {
    viewport: { defaultViewport: "serverNarrow" },
  },
  play: Members.play,
};

export const DenseMemberList: Story = {
  args: {
    server: { ...remoteServer, role: "admin" },
    hostStatus: null,
    members: denseMembers,
  },
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await body.findByRole("dialog", { name: "General" });
    await userEvent.click(body.getByRole("tab", { name: "Members" }));
    await expect(body.getByTestId("server-members-list")).toBeVisible();
  },
};

export const RemoveMemberConfirmation: Story = {
  args: {
    server: { ...remoteServer, role: "admin" },
    hostStatus: null,
  },
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await body.findByRole("dialog", { name: "General" });
    await userEvent.click(body.getByRole("tab", { name: "Members" }));
    await userEvent.click(body.getByRole("button", { name: "Actions for Jon Bell" }));
    await userEvent.click(await body.findByRole("menuitem", { name: "Remove member" }));
    await expect(await body.findByRole("alertdialog", { name: "Remove Jon Bell?" })).toBeVisible();
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
    await waitFor(() =>
      expect(body.getByText(remoteServer.name, { selector: ".server-settings-readonly-value" })).toBeVisible(),
    );
    body.getByRole("tab", { name: "Members" }).click();
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
    body.getByRole("tab", { name: "Remote desktop" }).click();
    await expect(body.getByText("Service available")).toBeVisible();
    await expect(body.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  },
};

export const SmallViewport: Story = {
  parameters: {
    viewport: { defaultViewport: "serverMobile" },
  },
};
