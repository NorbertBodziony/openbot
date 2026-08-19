import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { RemoteMacPanel } from "../src/components/RemoteMacPanel";
import { STORY_SERVERS } from "./fixtures";

const args: Parameters<typeof RemoteMacPanel>[0] = {
  server: { ...STORY_SERVERS[1], state: "offline" },
  session: undefined,
  width: 520,
  maxWidth: () => 760,
  onResize: () => undefined,
  onResizeEnd: () => undefined,
  onClose: () => undefined,
  onConnect: async () => undefined,
  onDisconnect: async () => undefined,
};

const meta = {
  title: "Team/RemoteMacPanel",
  component: RemoteMacPanel,
  args,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RemoteMacPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {};

export const NoServer: Story = {
  args: { server: undefined },
};
