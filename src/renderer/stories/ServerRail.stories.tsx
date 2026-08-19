import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ServerRail } from "../src/components/ServerRail";
import { STORY_HOST_STATUS, STORY_SERVERS } from "./fixtures";

const args: Parameters<typeof ServerRail>[0] = {
  platform: "darwin",
  servers: STORY_SERVERS,
  hostStatus: STORY_HOST_STATUS,
  onSelect: fn(),
  onAdd: fn(),
  onOpenHost: fn(),
  onOpenRemoteMac: fn(),
};

const meta = {
  title: "Navigation/ServerRail",
  component: ServerRail,
  args,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ServerRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Linux: Story = {
  args: { platform: "linux" },
};

export const OfflineRemote: Story = {
  args: {
    servers: STORY_SERVERS.map((server) =>
      server.kind === "remote" ? { ...server, state: "offline" as const } : server,
    ),
  },
};
