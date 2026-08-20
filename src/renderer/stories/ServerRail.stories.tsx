import { expect, fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ServerRail } from "../src/components/ServerRail";
import { STORY_SERVERS } from "./fixtures";

const args: Parameters<typeof ServerRail>[0] = {
  platform: "darwin",
  servers: STORY_SERVERS,
  onSelect: fn(),
  onAdd: fn(),
  onOpenHost: fn(),
  onOpenRemoteMac: fn(),
};

const meta = {
  title: "Navigation/ServerRail",
  component: ServerRail,
  args,
  decorators: [(Story) => <div class="app-frame app-frame-with-server-rail">{Story()}</div>],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ServerRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvas }) => {
    const rail = canvas.getByRole("complementary", { name: "Servers" });
    const dividerStyle = getComputedStyle(rail, "::after");

    await expect(getComputedStyle(rail).borderRightWidth).toBe("0px");
    await expect(dividerStyle.top).toBe("38px");
    await expect(dividerStyle.bottom).toBe("0px");
  },
};

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
