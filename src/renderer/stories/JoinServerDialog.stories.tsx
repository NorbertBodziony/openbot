import { expect, fn, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { JoinServerDialog } from "../src/components/JoinServerDialog";

const args: Parameters<typeof JoinServerDialog>[0] = {
  inviteUrl:
    "https://openbot.run/join?api=https%3A%2F%2Fstory-host.openbot.run%2F&server=00000000-0000-4000-8000-000000000000&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&invite=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  accountEmail: "person@example.com",
  onClose: fn(),
  onPreview: fn(async () => ({
    serverId: "00000000-0000-4000-8000-000000000000",
    serverName: "Studio host",
    apiHostname: "story-host.openbot.run",
    role: "member" as const,
    expiresAt: "2026-08-21T10:00:00.000Z",
    emailBound: false,
  })),
  onJoin: fn(async () => undefined),
};

const meta = {
  title: "Team/JoinServerDialog",
  component: JoinServerDialog,
  args,
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    viewport: {
      options: {
        joinServerNarrow: {
          name: "Join server — 360 × 640",
          styles: { width: "360px", height: "640px" },
        },
      },
    },
  },
} satisfies Meta<typeof JoinServerDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const VerifiedInvite: Story = {};

export const InviteReady: Story = {
  play: async ({ args: storyArgs, userEvent }) => {
    const body = within(document.body);
    await expect(body.findByText("Studio host")).resolves.toBeTruthy();
    await userEvent.click(body.getByRole("button", { name: "Connect to host" }));
    await expect(storyArgs.onJoin).toHaveBeenCalledWith({ inviteUrl: args.inviteUrl });
  },
};

export const EmptyInvite: Story = {
  args: { inviteUrl: "" },
};

export const ErrorState: Story = {
  args: {
    inviteUrl: "",
    onPreview: async () => {
      throw new Error("The OpenBot invitation link is invalid.");
    },
  },
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await userEvent.type(body.getByRole("textbox", { name: "Invitation link" }), "https://openbot.run/join?bad");
    await userEvent.click(body.getByRole("button", { name: "Review invitation" }));
    await expect(body.getByRole("alert")).toHaveTextContent("The OpenBot invitation link is invalid.");
  },
};

export const Joining: Story = {
  args: {
    onJoin: () => new Promise<void>(() => undefined),
  },
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await expect(body.findByText("Studio host")).resolves.toBeTruthy();
    await userEvent.click(body.getByRole("button", { name: "Connect to host" }));
    await expect(body.getByRole("button", { name: "Connecting…" })).toBeDisabled();
  },
};

export const Narrow: Story = {
  args: { inviteUrl: "" },
  parameters: { viewport: { defaultViewport: "joinServerNarrow" } },
};
