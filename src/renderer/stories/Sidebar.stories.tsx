import { createSignal } from "solid-js";
import { expect, fireEvent, fn, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { SidebarAgentState } from "../src/components/Sidebar";
import { Sidebar } from "../src/components/Sidebar";
import { MAX_SIDEBAR_PINNED_ITEMS, normalizeSidebarPinnedItems, type SidebarPinnedItem } from "../src/sidebar-pins";
import { STORY_BOTS, STORY_DIRECT_THREADS, STORY_PRESENCE } from "./fixtures";

const agentStates: Record<string, SidebarAgentState> = {
  chief: { kind: "working" },
  research: { kind: "unread", count: 3 },
  sales: { kind: "responded" },
};

const sidebarBots = STORY_BOTS.map((bot) => {
  if (bot.id === "chief") return { ...bot, title: "CEO" };
  if (bot.id === "research") return { ...bot, title: "Analyst" };
  if (bot.id === "sales") return { ...bot, name: "Sales", title: "Growth" };
  return bot;
});

const pinnedOne: SidebarPinnedItem[] = [{ kind: "agent", id: "chief" }];
const pinnedTwo: SidebarPinnedItem[] = [...pinnedOne, { kind: "person", id: "member-alice" }];
const pinnedThree: SidebarPinnedItem[] = [...pinnedTwo, { kind: "agent", id: "research" }];
const pinnedFour: SidebarPinnedItem[] = [...pinnedThree, { kind: "agent", id: "sales" }];
const pinnedFive: SidebarPinnedItem[] = [...pinnedFour, { kind: "person", id: "member-jon" }];
const pinnedSix: SidebarPinnedItem[] = [...pinnedFive, { kind: "person", id: "member-maya" }];
const longLabelBots = sidebarBots.map((bot) =>
  bot.id === "chief"
    ? {
        ...bot,
        name: "Strategic Operations Coordinator",
        title: "Executive Planning and Delivery Partner",
      }
    : bot,
);

const args: Parameters<typeof Sidebar>[0] = {
  serverName: "Local",
  bots: sidebarBots,
  activeBotId: "chief",
  people: STORY_PRESENCE.members,
  directThreads: STORY_DIRECT_THREADS,
  activeDirectMemberId: null,
  agentStates,
  pinnedItems: pinnedThree,
  onPin: fn(),
  onUnpin: fn(),
  onReorderPinned: fn(),
  onSelectBot: fn(),
  onSelectPerson: fn(),
  onCreateBot: fn(),
  onEditBot: fn(),
  onDeleteBot: async () => undefined,
  compact: false,
  onCollapse: fn(),
  onExpand: fn(),
};

function InteractiveSidebar(props: Parameters<typeof Sidebar>[0]) {
  const [pinnedItems, setPinnedItems] = createSignal(props.pinnedItems);
  return (
    <Sidebar
      {...props}
      pinnedItems={pinnedItems()}
      onPin={(item) => {
        setPinnedItems((current) =>
          current.some((candidate) => candidate.kind === item.kind && candidate.id === item.id)
            ? current
            : normalizeSidebarPinnedItems([...current, item]),
        );
        props.onPin(item);
      }}
      onUnpin={(item) => {
        setPinnedItems((current) =>
          current.filter((candidate) => candidate.kind !== item.kind || candidate.id !== item.id),
        );
        props.onUnpin(item);
      }}
      onReorderPinned={(items) => {
        setPinnedItems(items);
        props.onReorderPinned(items);
      }}
    />
  );
}

const meta = {
  title: "Navigation/Sidebar",
  component: Sidebar,
  render: (storyArgs) => <InteractiveSidebar {...storyArgs} />,
  args,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

async function expectPinnedLayout(canvasElement: HTMLElement, expectedCount: 1 | 2 | 3 | 4 | 5 | 6): Promise<void> {
  const list = canvasElement.querySelector<HTMLElement>(".sidebar-pinned-list");
  if (!list) throw new Error("Pinned list is missing.");
  const tiles = Array.from(list.querySelectorAll<HTMLElement>(".sidebar-pinned-row"));
  const avatars = tiles.map((tile) => tile.querySelector<HTMLElement>(".sidebar-pinned-avatar"));
  if (avatars.some((avatar) => !avatar)) throw new Error("A pinned avatar is missing.");

  await expect(tiles).toHaveLength(expectedCount);
  await expect(expectedCount).toBeLessThanOrEqual(MAX_SIDEBAR_PINNED_ITEMS);
  for (const tile of tiles) await expect(tile.getBoundingClientRect().height).toBe(94);
  for (const avatar of avatars) await expect(avatar?.getBoundingClientRect().width).toBe(48);

  const rects = tiles.map((tile) => tile.getBoundingClientRect());
  const listRect = list.getBoundingClientRect();
  const rowTops = [...new Set(rects.map((rect) => Math.round(rect.top)))].sort((left, right) => left - right);
  await expect(rowTops).toHaveLength(expectedCount <= 3 ? 1 : 2);
  await expect(list.scrollWidth).toBe(list.clientWidth);
  await expect(list.scrollHeight).toBe(list.clientHeight);
  for (const rect of rects) {
    await expect(rect.left).toBeGreaterThanOrEqual(listRect.left);
    await expect(rect.right).toBeLessThanOrEqual(listRect.right);
    await expect(rect.bottom).toBeLessThanOrEqual(listRect.bottom);
  }
  for (const rowTop of rowTops) {
    const row = rects.filter((rect) => Math.abs(rect.top - rowTop) < 1);
    const first = row[0];
    const last = row.at(-1);
    if (!first || !last) throw new Error("Pinned row is missing.");
    await expect(row.length).toBeLessThanOrEqual(3);
    const contentCenter = (first.left + last.right) / 2;
    await expect(Math.abs(contentCenter - (listRect.left + listRect.right) / 2)).toBeLessThanOrEqual(1);
  }
}

async function expectHiddenPinnedDragSource(canvasElement: HTMLElement): Promise<void> {
  const source = canvasElement.querySelector<HTMLElement>(".sidebar-pinned-item");
  if (!source) throw new Error("Pinned drag source is missing.");
  const dataTransfer = new DataTransfer();

  fireEvent.dragStart(source, { dataTransfer, clientX: 36, clientY: 36 });
  try {
    await expect(getComputedStyle(source).opacity).toBe("0");
    await expect(canvasElement.ownerDocument.querySelector(".sidebar-pinned-drag-preview")).toBeInTheDocument();
  } finally {
    fireEvent.dragEnd(source, { dataTransfer });
  }
  await expect(canvasElement.ownerDocument.querySelector(".sidebar-pinned-drag-preview")).not.toBeInTheDocument();
}

export const Populated: Story = {
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvas, canvasElement }) => {
    await expectPinnedLayout(canvasElement, 3);
    const pinnedRegion = canvas.getByRole("region", { name: "Pinned chats" });
    const peopleHeading = canvas.getByRole("heading", { name: "People" });
    const chief = canvas.getByRole("button", { name: "Chief, pinned agent" });
    const alice = canvas.getByRole("button", { name: "Alice Chen, pinned person" });

    await expect(chief.getBoundingClientRect().left).toBeLessThan(alice.getBoundingClientRect().left);
    await expect(pinnedRegion.getBoundingClientRect().top).toBeLessThan(peopleHeading.getBoundingClientRect().top);
    await expect(canvas.queryByText("Pinned")).not.toBeInTheDocument();
    await expect(canvas.getAllByText("Chief")).toHaveLength(1);
    await expect(canvas.getAllByText("Alice Chen")).toHaveLength(1);
  },
};

export const PinnedOne: Story = {
  args: { pinnedItems: pinnedOne },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => expectPinnedLayout(canvasElement, 1),
};

export const PinnedTwo: Story = {
  args: { pinnedItems: pinnedTwo },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => expectPinnedLayout(canvasElement, 2),
};

export const PinnedThree: Story = {
  args: { pinnedItems: pinnedThree },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => {
    await expectPinnedLayout(canvasElement, 3);
    await expectHiddenPinnedDragSource(canvasElement);
  },
};

export const PinnedFour: Story = {
  args: { pinnedItems: pinnedFour },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => expectPinnedLayout(canvasElement, 4),
};

export const PinnedFive: Story = {
  args: { pinnedItems: pinnedFive },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => expectPinnedLayout(canvasElement, 5),
};

export const PinnedSix: Story = {
  args: { pinnedItems: pinnedSix },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => expectPinnedLayout(canvasElement, 6),
};

export const PinnedLongLabels: Story = {
  args: { bots: longLabelBots, pinnedItems: pinnedOne },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => {
    await expectPinnedLayout(canvasElement, 1);
    const tile = canvasElement.querySelector<HTMLElement>(".sidebar-pinned-row");
    const name = tile?.querySelector<HTMLElement>(".sidebar-pinned-name");
    const title = tile?.querySelector<HTMLElement>(".sidebar-pinned-title > span");
    if (!tile || !name || !title) throw new Error("Pinned labels are missing.");
    await expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    await expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
    await expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
    await expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
    await expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(tile.getBoundingClientRect().right);
    await expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(tile.getBoundingClientRect().right);
  },
};

export const AgentTiles: Story = {
  args: {
    people: [],
    directThreads: [],
    agentStates: {},
    pinnedItems: [],
  },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvas }) => {
    const tile = canvas.getByRole("button", { name: /Chief, CEO/ });
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
    pinnedItems: [],
  },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvas, canvasElement }) => {
    const tile = canvas.getByRole("button", { name: /Chief, CEO/ });
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
    pinnedItems: [],
  },
};
