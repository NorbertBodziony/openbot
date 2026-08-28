import type { SidebarLayoutAction, SidebarLayoutSnapshot } from "@openbot/contracts/ipc";
import { createSignal, untrack } from "solid-js";
import { expect, fireEvent, fn, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { SidebarAgentState } from "../src/components/Sidebar";
import { Sidebar } from "../src/components/Sidebar";
import { MAX_SIDEBAR_PINNED_ITEMS, normalizeSidebarPinnedItems, type SidebarPinnedItem } from "../src/sidebar-pins";
import { defaultSidebarLayout } from "../src/sidebar-sections";
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
const pinnedTwo: SidebarPinnedItem[] = [...pinnedOne, { kind: "agent", id: "research" }];
const pinnedThree: SidebarPinnedItem[] = [...pinnedTwo, { kind: "agent", id: "sales" }];
const pinnedFour: SidebarPinnedItem[] = [...pinnedThree, { kind: "agent", id: "stress-agent-1" }];
const pinnedFive: SidebarPinnedItem[] = [...pinnedFour, { kind: "agent", id: "stress-agent-2" }];
const pinnedSix: SidebarPinnedItem[] = [...pinnedFive, { kind: "agent", id: "stress-agent-3" }];
const longLabelBots = sidebarBots.map((bot) =>
  bot.id === "chief"
    ? {
        ...bot,
        name: "Strategic Operations Coordinator",
        title: "Executive Planning and Delivery Partner",
      }
    : bot,
);
const demoSectionId = "11111111-1111-4111-8111-111111111111";
const emptySectionId = "22222222-2222-4222-8222-222222222222";
const sectionedLayout: SidebarLayoutSnapshot = {
  revision: 1,
  sections: [
    { id: demoSectionId, name: "Core team" },
    { id: emptySectionId, name: "Empty section" },
  ],
  order: ["people", demoSectionId, "unassigned", emptySectionId],
  agentAssignments: { chief: demoSectionId, research: demoSectionId },
  agentOrder: ["chief", "research", "sales"],
};
const longSectionLayout: SidebarLayoutSnapshot = {
  revision: 1,
  sections: [
    {
      id: demoSectionId,
      name: "International Research and Strategic Operations Group",
    },
  ],
  order: [demoSectionId, "people", "unassigned"],
  agentAssignments: { chief: demoSectionId },
  agentOrder: ["chief", "research", "sales"],
};
const stressSectionIds = Array.from({ length: 6 }, (_, index) => `44444444-4444-4444-8444-44444444444${index}`);
const stressBots = [
  ...sidebarBots,
  ...Array.from({ length: 27 }, (_, index) => {
    const source = sidebarBots[index % sidebarBots.length] ?? sidebarBots[0];
    return {
      ...source,
      id: `stress-agent-${index + 1}`,
      name: `Agent ${index + 1}`,
      threadId: `stress-thread-${index + 1}`,
      avatarSeed: `stress-agent-${index + 1}`,
      preview: `Active task ${index + 1}`,
    };
  }),
];
const stressLayout: SidebarLayoutSnapshot = {
  revision: 1,
  sections: stressSectionIds.map((id, index) => ({ id, name: `Team ${index + 1}` })),
  order: ["people", ...stressSectionIds, "unassigned"],
  agentAssignments: Object.fromEntries(
    stressBots.slice(0, -3).map((bot, index) => [bot.id, stressSectionIds[index % stressSectionIds.length]]),
  ),
  agentOrder: stressBots.map((bot) => bot.id),
};

const args: Parameters<typeof Sidebar>[0] = {
  serverName: "Local",
  onOpenServerSettings: fn(),
  bots: sidebarBots,
  activeBotId: "chief",
  people: STORY_PRESENCE.members,
  directThreads: STORY_DIRECT_THREADS,
  activeDirectMemberId: null,
  agentStates,
  layout: defaultSidebarLayout(),
  collapsedSectionIds: [],
  onMutateLayout: fn(async () => undefined),
  onToggleSection: fn(),
  pinnedItems: pinnedThree,
  peopleOrder: [],
  onPin: fn(),
  onUnpin: fn(),
  onReorderPinned: fn(),
  onReorderPeople: fn(),
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
  const [pinnedItems, setPinnedItems] = createSignal(untrack(() => props.pinnedItems));
  const [peopleOrder, setPeopleOrder] = createSignal(untrack(() => props.peopleOrder));
  const [layout, setLayout] = createSignal(untrack(() => props.layout));
  const [collapsedSectionIds, setCollapsedSectionIds] = createSignal(untrack(() => props.collapsedSectionIds));
  return (
    <Sidebar
      {...props}
      layout={layout()}
      collapsedSectionIds={collapsedSectionIds()}
      pinnedItems={pinnedItems()}
      peopleOrder={peopleOrder()}
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
      onReorderPeople={(memberIds) => {
        setPeopleOrder(memberIds);
        props.onReorderPeople(memberIds);
      }}
      onMutateLayout={async (action) => {
        setLayout((current) => applyStoryLayoutAction(current, action));
        await props.onMutateLayout(action);
      }}
      onToggleSection={(sectionId) => {
        setCollapsedSectionIds((current) =>
          current.includes(sectionId)
            ? current.filter((candidate) => candidate !== sectionId)
            : [...current, sectionId],
        );
        props.onToggleSection(sectionId);
      }}
    />
  );
}

function applyStoryLayoutAction(layout: SidebarLayoutSnapshot, action: SidebarLayoutAction): SidebarLayoutSnapshot {
  const revision = layout.revision + 1;
  if (action.type === "create") {
    const id = crypto.randomUUID();
    return {
      ...layout,
      revision,
      sections: [...layout.sections, { id, name: action.name.trim() }],
      order: [...layout.order, id],
      agentAssignments: action.agentId
        ? { ...layout.agentAssignments, [action.agentId]: id }
        : { ...layout.agentAssignments },
      agentOrder: [...layout.agentOrder],
    };
  }
  if (action.type === "rename") {
    return {
      ...layout,
      revision,
      sections: layout.sections.map((section) =>
        section.id === action.sectionId ? { ...section, name: action.name.trim() } : section,
      ),
    };
  }
  if (action.type === "delete") {
    return {
      ...layout,
      revision,
      sections: layout.sections.filter((section) => section.id !== action.sectionId),
      order: layout.order.filter((sectionId) => sectionId !== action.sectionId),
      agentAssignments: Object.fromEntries(
        Object.entries(layout.agentAssignments).filter(([, sectionId]) => sectionId !== action.sectionId),
      ),
      agentOrder: [...layout.agentOrder],
    };
  }
  if (action.type === "move") {
    const order = [...layout.order];
    const index = order.indexOf(action.sectionId);
    const target = index + (action.direction === "up" ? -1 : 1) * (action.steps ?? 1);
    if (index >= 0 && target >= 0 && target < order.length) {
      const [movedSectionId] = order.splice(index, 1);
      if (movedSectionId) order.splice(target, 0, movedSectionId);
    }
    return { ...layout, revision, order };
  }
  if (action.type === "move-agent") {
    const agentOrder = layout.agentOrder.filter((agentId) => agentId !== action.agentId);
    const insertionIndex = action.beforeAgentId === null ? agentOrder.length : agentOrder.indexOf(action.beforeAgentId);
    agentOrder.splice(insertionIndex < 0 ? agentOrder.length : insertionIndex, 0, action.agentId);
    const agentAssignments = { ...layout.agentAssignments };
    if (action.sectionId === null) delete agentAssignments[action.agentId];
    else agentAssignments[action.agentId] = action.sectionId;
    return { ...layout, revision, agentAssignments, agentOrder };
  }
  const agentAssignments = { ...layout.agentAssignments };
  if (action.sectionId === null) delete agentAssignments[action.agentId];
  else agentAssignments[action.agentId] = action.sectionId;
  return { ...layout, revision, agentAssignments };
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
    const peopleHeading = canvas.getByRole("button", { name: /People/ });
    const chief = canvas.getByRole("button", { name: "Chief, pinned agent" });
    const research = canvas.getByRole("button", { name: "Research, pinned agent" });

    await expect(chief.getBoundingClientRect().left).toBeLessThan(research.getBoundingClientRect().left);
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
  args: { bots: stressBots, pinnedItems: pinnedFour },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => expectPinnedLayout(canvasElement, 4),
};

export const PinnedFive: Story = {
  args: { bots: stressBots, pinnedItems: pinnedFive },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => expectPinnedLayout(canvasElement, 5),
};

export const PinnedSix: Story = {
  args: { bots: stressBots, pinnedItems: pinnedSix },
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

export const AgentLongLabels: Story = {
  args: {
    bots: longLabelBots,
    people: [],
    directThreads: [],
    agentStates: {},
    pinnedItems: [],
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: "240px",
          "min-width": "240px",
          "max-width": "400px",
          height: "100vh",
          overflow: "hidden",
          resize: "horizontal",
        }}
      >
        {Story()}
      </div>
    ),
  ],
};

export const AgentContextMenu: Story = {
  args: {
    people: [],
    directThreads: [],
    agentStates: {},
    layout: sectionedLayout,
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

    const moveTo = within(menu).getByRole("menuitem", { name: "Move to" });
    moveTo.focus();
    fireEvent.keyDown(moveTo, { key: "Enter" });
    const assignmentMenu = await within(canvasElement.ownerDocument.body).findByRole("menu", { name: "Move to" });
    const coreTeam = within(assignmentMenu).getByRole("menuitem", { name: "Core team" });
    const emptySection = within(assignmentMenu).getByRole("menuitem", { name: "Empty section" });
    const unassigned = within(assignmentMenu).getByRole("menuitem", { name: "Unassigned" });
    const assignmentDivider = within(assignmentMenu).getByRole("separator");
    const newSection = within(assignmentMenu).getByRole("menuitem", { name: "New section" });

    await expect(moveTo).toHaveAttribute("aria-expanded", "true");
    await expect(getComputedStyle(moveTo).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    await expect(getComputedStyle(items[0]).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    await expect(coreTeam.querySelector(".lucide-check")).toBeInTheDocument();
    await expect(unassigned.querySelector(".lucide-folder")).toBeInTheDocument();
    await expect(emptySection).toBeInTheDocument();
    await expect(assignmentDivider.nextElementSibling).toBe(newSection);
    await expect(assignmentMenu.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      menu.getBoundingClientRect().right - 4,
    );
  },
};

export const Sections: Story = {
  args: { layout: sectionedLayout, pinnedItems: pinnedOne },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("button", { name: /People/ })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Core team" })).toHaveAttribute("draggable", "true");
    await expect(canvas.getByRole("button", { name: "Unassigned" })).toBeInTheDocument();
    const researchButton = canvas.getByRole("button", { name: /Research/ });
    const researchItem = researchButton.closest<HTMLElement>(".sidebar-agent-item");
    if (!researchItem) throw new Error("Research drag source is missing.");
    await expect(researchItem).toHaveAttribute("draggable", "true");
    await expect(researchButton).not.toHaveAttribute("draggable");
    const bounds = researchItem.getBoundingClientRect();
    const DataTransferConstructor = canvasElement.ownerDocument.defaultView?.DataTransfer;
    if (!DataTransferConstructor) throw new Error("DataTransfer is unavailable.");
    const dataTransfer = new DataTransferConstructor();
    fireEvent.dragStart(researchItem, {
      clientX: bounds.left + 24,
      clientY: bounds.top + 24,
      dataTransfer,
    });
    const preview = canvasElement.ownerDocument.body.querySelector<HTMLElement>(".sidebar-agent-drag-preview");
    if (!preview) throw new Error("Agent drag preview is missing.");
    await expect(getComputedStyle(preview).transitionProperty).toBe("none");
    await expect(getComputedStyle(preview).transitionDuration).toBe("0s");
    fireEvent.dragEnd(researchItem, { dataTransfer });
    await expect(canvas.getByRole("button", { name: "Empty section" })).toBeInTheDocument();
  },
};

export const DragStress: Story = {
  args: { bots: stressBots, layout: stressLayout, pinnedItems: pinnedSix },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-pinned-key]")).toHaveLength(6);
    await expect(canvasElement.querySelectorAll("[data-section-id]").length).toBeGreaterThanOrEqual(7);
    await expect(canvasElement.querySelectorAll("[data-agent-id]").length).toBeGreaterThanOrEqual(24);
  },
};

export const SectionsCollapsed: Story = {
  args: { layout: sectionedLayout, collapsedSectionIds: [demoSectionId], pinnedItems: [] },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole("button", { name: "Core team" })).toHaveAttribute("aria-expanded", "false");
    const body = canvasElement.querySelector(`#sidebar-section-body-${demoSectionId}`)?.parentElement;
    await expect(body).toHaveAttribute("data-collapsed");
    await expect(body).toHaveAttribute("inert");
  },
};

export const SectionLongLabels: Story = {
  args: { layout: longSectionLayout, people: [], directThreads: [], pinnedItems: [] },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvasElement }) => {
    const label = canvasElement.querySelector<HTMLElement>(".sidebar-section-name");
    const toggle = canvasElement.querySelector<HTMLElement>(".sidebar-section-toggle");
    if (!label || !toggle) throw new Error("Long section heading is missing.");
    await expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    await expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    await expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(toggle.getBoundingClientRect().right);
  },
};

export const SectionRename: Story = {
  args: { layout: sectionedLayout, pinnedItems: [] },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvas, canvasElement }) => {
    const heading = canvas.getByRole("button", { name: "Core team" });
    fireEvent.contextMenu(heading);
    const menu = await within(canvasElement.ownerDocument.body).findByRole("menu", { name: "Section actions" });
    fireEvent.pointerUp(within(menu).getByRole("menuitem", { name: "Rename" }), { button: 0 });
    await expect(await canvas.findByRole("textbox", { name: "Rename section" })).toHaveValue("Core team");
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

export const EmptyPinDropTarget: Story = {
  args: {
    people: [],
    directThreads: [],
    pinnedItems: [],
  },
  decorators: [(Story) => <div style={{ width: "280px", height: "100vh" }}>{Story()}</div>],
  play: async ({ canvas, canvasElement }) => {
    const chief = canvas.getByRole("button", { name: /Chief/ });
    const source = chief.closest<HTMLElement>("[data-agent-id]");
    const DataTransferConstructor = canvasElement.ownerDocument.defaultView?.DataTransfer;
    if (!source || !DataTransferConstructor) throw new Error("Agent drag source is unavailable.");
    const bounds = source.getBoundingClientRect();
    const dataTransfer = new DataTransferConstructor();
    fireEvent.dragStart(source, {
      clientX: bounds.left + 24,
      clientY: bounds.top + 24,
      dataTransfer,
    });
    await expect(canvas.queryByText("Drag here to pin")).not.toBeInTheDocument();
    fireEvent.dragOver(source, {
      clientX: bounds.left + 26,
      clientY: bounds.top + 26,
      dataTransfer,
    });
    await expect(canvas.getByText("Drag here to pin")).toBeInTheDocument();
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
