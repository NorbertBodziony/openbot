import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { expect, fireEvent, fn, within } from "storybook/test";
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

export const AgentTiles: Story = {
  args: {
    people: [],
    directThreads: [],
    agentStates: {},
  },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvas }) => {
    const tile = canvas.getByRole("button", { name: /Chief, Chief of staff/ });
    const avatar = tile.querySelector<HTMLElement>(".bot-row-avatar");
    const title = tile.querySelector<HTMLElement>(".bot-row-title strong");
    const preview = tile.querySelector<HTMLElement>(".bot-row-preview");
    const time = tile.querySelector<HTMLElement>(".bot-row-time");
    if (!avatar || !title || !preview || !time) throw new Error("Agent tile anatomy is incomplete.");
    await expect(tile.getBoundingClientRect().height).toBe(54);
    await expect(avatar.getBoundingClientRect().width).toBe(36);
    await expect(getComputedStyle(title).fontSize).toBe("14px");
    await expect(getComputedStyle(preview).fontSize).toBe("13px");
    await expect(getComputedStyle(time).fontSize).toBe("12px");
  },
};

export const AgentContextMenu: Story = {
  args: {
    people: [],
    directThreads: [],
    agentStates: {},
  },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvas, canvasElement }) => {
    const tile = canvas.getByRole("button", { name: /Chief, Chief of staff/ });
    const tileRect = tile.getBoundingClientRect();
    fireEvent.contextMenu(tile, {
      clientX: tileRect.left + tileRect.width / 2,
      clientY: tileRect.top + tileRect.height / 2,
    });

    const menu = await within(canvasElement.ownerDocument.body).findByRole("menu", { name: "Agent actions" });
    const items = within(menu).getAllByRole("menuitem");
    const menuStyle = getComputedStyle(menu);
    const itemStyle = getComputedStyle(items[0]);

    await expect(menu.getBoundingClientRect().width).toBe(200);
    await expect(menuStyle.padding).toBe("4px");
    await expect(menuStyle.outlineStyle).toBe("none");
    await expect(items[0].getBoundingClientRect().height).toBe(26);
    await expect(itemStyle.padding).toBe("4px 8px");
    await expect(itemStyle.gap).toBe("8px");
    await expect(itemStyle.borderRadius).toBe("4px");
    await expect(itemStyle.fontSize).toBe("13px");
    await expect(itemStyle.lineHeight).toBe("18px");
  },
};

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
