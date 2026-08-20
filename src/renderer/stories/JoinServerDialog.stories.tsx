import { expect, fn, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { JoinServerDialog } from "../src/components/JoinServerDialog";

const args: Parameters<typeof JoinServerDialog>[0] = {
  inviteUrl: "openbot://join?invite=team-demo",
  accountEmail: "person@example.com",
  onClose: fn(),
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

export const InviteReady: Story = {
  play: async ({ args: storyArgs, userEvent }) => {
    const body = within(document.body);
    await userEvent.click(body.getByRole("textbox", { name: "Invitation link" }));
    await userEvent.keyboard("{Enter}");
    await expect(storyArgs.onJoin).toHaveBeenCalledWith({ inviteUrl: "openbot://join?invite=team-demo" });
  },
};

export const EmptyInvite: Story = {
  args: { inviteUrl: "" },
};

export const ErrorState: Story = {
  args: {
    onJoin: async () => {
      throw new Error("The OpenBot invitation link is invalid.");
    },
  },
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await userEvent.click(body.getByRole("button", { name: "Join server" }));
    await expect(body.getByRole("alert")).toHaveTextContent("The OpenBot invitation link is invalid.");
  },
};

export const Joining: Story = {
  args: {
    onJoin: () => new Promise<void>(() => undefined),
  },
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await userEvent.click(body.getByRole("button", { name: "Join server" }));
    await expect(body.getByRole("button", { name: "Joining…" })).toBeDisabled();
    await expect(body.getByRole("textbox", { name: "Invitation link" })).toBeDisabled();
  },
};

export const Narrow: Story = {
  args: { inviteUrl: "" },
  parameters: { viewport: { defaultViewport: "joinServerNarrow" } },
};
