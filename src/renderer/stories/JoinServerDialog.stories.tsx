import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { JoinServerDialog } from "../src/components/JoinServerDialog";

const args: Parameters<typeof JoinServerDialog>[0] = {
  inviteUrl: "openbot://invite/team-demo",
  accountEmail: "person@example.com",
  onClose: fn(),
  onJoin: async () => undefined,
};

const meta = {
  title: "Team/JoinServerDialog",
  component: JoinServerDialog,
  args,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof JoinServerDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InviteReady: Story = {};

export const EmptyInvite: Story = {
  args: { inviteUrl: "" },
};
