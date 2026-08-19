import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { fn, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { SidebarAgentState } from "../src/components/Sidebar";
import { Sidebar } from "../src/components/Sidebar";
import {
  STORY_AGENT_STATUS,
  STORY_APP_INFO,
  STORY_BOTS,
  STORY_DIRECT_THREADS,
  STORY_PRESENCE,
  STORY_UPDATE_STATUS,
  STORY_USAGE,
} from "./fixtures";

const account: CentralAuthUser = {
  id: "user-1",
  email: "person@example.com",
  name: "Norbert",
  avatarUrl: null,
};

const agentStates: Record<string, SidebarAgentState> = {
  chief: { kind: "working" },
  research: { kind: "unread", count: 3 },
  sales: { kind: "responded" },
};

const args: Parameters<typeof Sidebar>[0] = {
  bots: STORY_BOTS,
  activeBotId: "chief",
  people: STORY_PRESENCE.members,
  directThreads: STORY_DIRECT_THREADS,
  activeDirectMemberId: null,
  account,
  appInfo: STORY_APP_INFO,
  agentStatus: STORY_AGENT_STATUS,
  accountUsage: STORY_USAGE,
  updateStatus: STORY_UPDATE_STATUS,
  agentStates,
  onSelectBot: fn(),
  onSelectPerson: fn(),
  onCreateBot: fn(),
  onEditBot: fn(),
  onDeleteBot: async () => undefined,
  onRefreshUsage: async () => STORY_USAGE,
  onUpdateAction: async () => undefined,
  onUpdateAccountAvatar: async () => undefined,
  onLogout: async () => undefined,
  onOpenExternal: async () => undefined,
  onOpenPermissions: fn(),
  compact: false,
  onCollapse: fn(),
  onExpand: fn(),
};

const meta = {
  title: "Navigation/Sidebar",
  component: Sidebar,
  args,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Compact: Story = {
  args: { compact: true },
};

export const Empty: Story = {
  args: {
    bots: [],
    people: [],
    directThreads: [],
    agentStates: {},
  },
};

export const AccountMenu: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Open account menu" }));
    await within(canvasElement.ownerDocument.body).findByRole("dialog", { name: "Account" });
  },
};

export const Linux: Story = {
  args: {
    appInfo: { ...STORY_APP_INFO, platform: "linux" },
  },
};
