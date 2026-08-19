import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { HostPanel } from "../src/components/HostPanel";
import {
  STORY_HOST_STATUS,
  STORY_INVITES,
  STORY_PRESENCE,
  STORY_SESSIONS,
  STORY_TEAM_MEMBERS,
} from "./fixtures";

const args: Parameters<typeof HostPanel>[0] = {
  platform: "darwin",
  status: STORY_HOST_STATUS,
  members: STORY_TEAM_MEMBERS,
  invites: STORY_INVITES,
  sessions: STORY_SESSIONS,
  presence: STORY_PRESENCE,
  accountEmail: "person@example.com",
  onClose: fn(),
  onConfigure: async () => undefined,
  onConfigureRemoteDesktop: async () => undefined,
  onStart: async () => undefined,
  onStop: async () => undefined,
  onCreateInvite: async (input) => ({
    id: "invite-created",
    role: input.role,
    expiresAt: "2026-09-19T10:00:00.000Z",
    usedAt: null,
    inviteUrl: "openbot://invite/created",
    email: input.email ?? null,
  }),
  onUpdateMember: async () => undefined,
  onRemoveMember: async () => undefined,
  onRevokeSession: async () => undefined,
  onRevokeInvite: async () => undefined,
  onCopyAddressUpdate: async () => undefined,
};

const meta = {
  title: "Team/HostPanel",
  component: HostPanel,
  args,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HostPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Published: Story = {};

export const Overview: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "People" }));
    await canvas.findByText("Alice Chen");
  },
};

export const Unconfigured: Story = {
  args: {
    status: {
      ...STORY_HOST_STATUS,
      phase: "unconfigured",
      configured: false,
      serverName: null,
      apiUrl: null,
      vncHostname: null,
      apiOnline: false,
      vncOnline: false,
    },
  },
};
