import { expect, fireEvent, fn, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { SidebarAgentState } from "../src/components/Sidebar";
import { Sidebar } from "../src/components/Sidebar";
import { STORY_BOTS, STORY_DIRECT_THREADS, STORY_PRESENCE } from "./fixtures";

const agentStates: Record<string, SidebarAgentState> = {
  chief: { kind: "working" },
  research: { kind: "unread", count: 3 },
  sales: { kind: "responded" },
};

const args: Parameters<typeof Sidebar>[0] = {
  serverName: "Local",
  bots: STORY_BOTS,
  activeBotId: "chief",
  people: STORY_PRESENCE.members,
  directThreads: STORY_DIRECT_THREADS,
  activeDirectMemberId: null,
  agentStates,
  onSelectBot: fn(),
  onSelectPerson: fn(),
  onCreateBot: fn(),
  onEditBot: fn(),
  onDeleteBot: async () => undefined,
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
    const badge = tile.querySelector<HTMLElement>(".bot-role-badge");
    const preview = tile.querySelector<HTMLElement>(".bot-row-preview");
    const time = tile.querySelector<HTMLElement>(".bot-row-time");
    if (!avatar || !title || !badge || !preview || !time) throw new Error("Agent tile anatomy is incomplete.");
    await expect(tile.getBoundingClientRect().height).toBe(54);
    await expect(avatar.getBoundingClientRect().width).toBe(36);
    await expect(getComputedStyle(title).fontSize).toBe("14px");
    const titleRect = title.getBoundingClientRect();
    const badgeRect = badge.getBoundingClientRect();
    await expect(Math.abs(titleRect.top + titleRect.height / 2 - (badgeRect.top + badgeRect.height / 2))).toBeLessThan(
      1,
    );
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

    await expect(menu).toHaveClass("ui-action-menu");
    await expect(menu.getBoundingClientRect().width).toBe(160);
    await expect(menuStyle.padding).toBe("4px");
    await expect(menuStyle.outlineStyle).toBe("none");
    await expect(items[0].getBoundingClientRect().height).toBe(32);
    await expect(itemStyle.padding).toBe("6px 8px");
    await expect(itemStyle.gap).toBe("8px");
    await expect(itemStyle.borderRadius).toBe("6px");
    await expect(itemStyle.fontSize).toBe("14px");
    await expect(itemStyle.lineHeight).toBe("20px");
    await expect(items[0].querySelector("svg")?.getBoundingClientRect().width).toBe(16);
  },
};

export const Compact: Story = {
  args: { compact: true },
};

export const LongServerName: Story = {
  args: { serverName: "Synthetify production workspace with a long name" },
  decorators: [(Story) => <div style={{ width: "240px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvas }) => {
    const name = canvas.getByText("Synthetify production workspace with a long name");
    const actions = canvas.getByRole("button", { name: "Collapse sidebar" }).parentElement;
    if (!actions) throw new Error("Sidebar header actions are missing.");
    await expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
    await expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    await expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(actions.getBoundingClientRect().left);
  },
};

export const Empty: Story = {
  args: {
    bots: [],
    people: [],
    directThreads: [],
    agentStates: {},
  },
};
