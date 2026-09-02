import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { STORY_BOTS, STORY_DIRECT_THREADS, STORY_PRESENCE } from "../../stories/fixtures";
import type { SidebarPinnedItem } from "../sidebar-pins";
import { defaultSidebarLayout } from "../sidebar-sections";
import { Sidebar } from "./Sidebar";

function sidebarProps(pinnedItems: SidebarPinnedItem[] = []) {
  return {
    serverName: "Local",
    onOpenServerSettings: vi.fn(),
    bots: STORY_BOTS,
    activeBotId: "chief",
    people: STORY_PRESENCE.members,
    directThreads: STORY_DIRECT_THREADS,
    activeDirectMemberId: null,
    agentStates: {
      chief: { kind: "working" as const },
      research: { kind: "unread" as const, count: 3 },
    },
    layout: defaultSidebarLayout(),
    collapsedSectionIds: [],
    onMutateLayout: vi.fn(async () => undefined),
    onToggleSection: vi.fn(),
    pinnedItems,
    peopleOrder: [],
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onReorderPinned: vi.fn(),
    onReorderPeople: vi.fn(),
    onSelectBot: vi.fn(),
    onSelectPerson: vi.fn(),
    onCreateBot: vi.fn(),
    onEditBot: vi.fn(),
    onDuplicateBot: vi.fn(async () => undefined),
    onDeleteBot: vi.fn(async () => undefined),
    compact: false,
    onExpand: vi.fn(),
    onOpenMarketplace: vi.fn(),
  };
}

function sidebarPropsWithExtraAgents(pinnedItems: SidebarPinnedItem[], count: number) {
  const props = sidebarProps(pinnedItems);
  props.bots = [
    ...STORY_BOTS,
    ...Array.from({ length: count }, (_, index) => ({
      ...STORY_BOTS[2],
      id: `extra-${index + 1}`,
      name: `Extra ${index + 1}`,
      threadId: `thread-extra-${index + 1}`,
      avatarSeed: `extra-${index + 1}`,
    })),
  ];
  return props;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

interface DragTestDataTransfer {
  dropEffect: string;
  effectAllowed: string;
  setData: ReturnType<typeof vi.fn>;
  setDragImage: ReturnType<typeof vi.fn>;
}

async function dragOverFrame(
  element: Element,
  dataTransfer: DragTestDataTransfer,
  point: { clientX: number; clientY: number },
): Promise<void> {
  fireEvent(element, nativeDragEvent("dragover", dataTransfer, point));
  await nextAnimationFrame();
}

function dragStartAt(
  element: Element,
  dataTransfer: DragTestDataTransfer,
  point: { clientX: number; clientY: number },
): void {
  fireEvent(element, nativeDragEvent("dragstart", dataTransfer, point));
}

function dropAt(
  element: Element,
  dataTransfer: DragTestDataTransfer,
  point: { clientX: number; clientY: number },
): void {
  fireEvent(element, nativeDragEvent("drop", dataTransfer, point));
}

function nativeDragEvent(
  type: string,
  dataTransfer: DragTestDataTransfer,
  point: { clientX: number; clientY: number },
): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...point });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

describe("Sidebar pinned chats", () => {
  it("shows agent pins, ignores legacy person pins, and filters with search", async () => {
    const props = sidebarProps([
      { kind: "agent", id: "chief" },
      { kind: "person", id: "member-alice" },
      { kind: "agent", id: "missing" },
    ]);
    render(() => <Sidebar {...props} />);

    await fireEvent.click(screen.getByRole("button", { name: "Open settings for Local" }));
    expect(props.onOpenServerSettings).toHaveBeenCalledWith(expect.any(HTMLElement));

    await fireEvent.click(screen.getByRole("button", { name: "Open Marketplace" }));
    expect(props.onOpenMarketplace).toHaveBeenCalledOnce();

    expect(screen.getByRole("region", { name: "Pinned chats" })).toBeInTheDocument();
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chief, pinned agent" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Alice Chen, pinned person" })).not.toBeInTheDocument();

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "Sales" },
    });
    expect(screen.queryByRole("region", { name: "Pinned chats" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sales/ })).toBeInTheDocument();
  });

  it("does not offer pin actions for people and keeps full actions for pinned agents", async () => {
    const props = sidebarProps([{ kind: "agent", id: "chief" }]);
    render(() => <Sidebar {...props} />);

    await fireEvent.contextMenu(screen.getByRole("button", { name: /Alice Chen/ }));
    expect(screen.queryByRole("menu", { name: "Person actions" })).not.toBeInTheDocument();
    expect(props.onPin).not.toHaveBeenCalled();

    await fireEvent.contextMenu(screen.getByRole("button", { name: "Chief, pinned agent" }));
    const agentMenu = await screen.findByRole("menu", { name: "Agent actions" });
    expect(within(agentMenu).getByRole("menuitem", { name: "Duplicate agent" })).toBeInTheDocument();
    expect(within(agentMenu).getByRole("menuitem", { name: "Delete agent" })).toBeInTheDocument();
    await fireEvent.pointerUp(within(agentMenu).getByRole("menuitem", { name: "Unpin" }), { button: 0 });
    expect(props.onUnpin).toHaveBeenCalledWith({ kind: "agent", id: "chief" });

    await fireEvent.contextMenu(screen.getByRole("button", { name: /Sales Outbound/ }));
    const reopenedMenu = await screen.findByRole("menu", { name: "Agent actions" });
    await fireEvent.pointerUp(within(reopenedMenu).getByRole("menuitem", { name: "Edit agent" }), { button: 0 });
    expect(props.onEditBot).toHaveBeenCalledWith("sales");
  });

  it("disables duplication while it runs and hides it for an old host", async () => {
    const props = sidebarProps();
    const { unmount } = render(() => <Sidebar {...props} duplicatingBotIds={new Set(["chief"])} />);

    await fireEvent.contextMenu(screen.getByRole("button", { name: /Chief/ }));
    expect(screen.getByRole("menuitem", { name: "Duplicating…" })).toHaveAttribute("aria-disabled", "true");
    expect(props.onDuplicateBot).not.toHaveBeenCalled();
    unmount();

    render(() => <Sidebar {...props} duplicateSupported={false} />);
    await fireEvent.contextMenu(screen.getByRole("button", { name: /Chief/ }));
    expect(screen.queryByRole("menuitem", { name: "Duplicate agent" })).not.toBeInTheDocument();
  });

  it("disables agent pin actions after six chats are pinned", async () => {
    const props = sidebarPropsWithExtraAgents(
      [
        { kind: "agent", id: "chief" },
        { kind: "agent", id: "research" },
        { kind: "agent", id: "sales" },
        { kind: "agent", id: "extra-1" },
        { kind: "agent", id: "extra-2" },
        { kind: "agent", id: "extra-3" },
      ],
      4,
    );
    render(() => <Sidebar {...props} />);

    await fireEvent.contextMenu(screen.getByRole("button", { name: /Extra 4/ }));
    const agentMenu = await screen.findByRole("menu", { name: "Agent actions" });
    const pinItem = within(agentMenu).getByRole("menuitem", { name: "Pin" });

    await fireEvent.pointerUp(pinItem, { button: 0 });
    expect(props.onPin).not.toHaveBeenCalled();
  });

  it("reorders pinned chats by keyboard and constrained horizontal drag", async () => {
    const props = sidebarProps([
      { kind: "agent", id: "chief" },
      { kind: "agent", id: "research" },
      { kind: "agent", id: "sales" },
    ]);
    const view = render(() => <Sidebar {...props} />);
    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".sidebar-pinned-item"));

    await fireEvent.keyDown(within(rows[1]).getByRole("button"), { key: "ArrowLeft", altKey: true });
    expect(props.onReorderPinned).toHaveBeenLastCalledWith([
      { kind: "agent", id: "research" },
      { kind: "agent", id: "chief" },
      { kind: "agent", id: "sales" },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("Moved pinned chat to position 1 of 3.");

    for (const [index, row] of rows.entries()) {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top: 0,
        bottom: 94,
        left: index * 80,
        right: index * 80 + 72,
        width: 72,
        height: 94,
        x: index * 80,
        y: 0,
        toJSON: () => ({}),
      });
    }
    const list = view.container.querySelector<HTMLElement>(".sidebar-pinned-list");
    const root = view.container.querySelector<HTMLElement>(".bot-list");
    const pinned = screen.getByRole("region", { name: "Pinned chats" });
    if (!list || !root) throw new Error("Pinned list is missing.");
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 600,
      left: 0,
      right: 280,
      width: 280,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(pinned, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 120));

    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };
    dragStartAt(rows[0], dataTransfer, { clientX: 36, clientY: 20 });
    await dragOverFrame(rows[2], dataTransfer, { clientX: 200, clientY: 20 });
    dropAt(rows[2], dataTransfer, { clientX: 200, clientY: 20 });

    expect(props.onReorderPinned).toHaveBeenLastCalledWith([
      { kind: "agent", id: "research" },
      { kind: "agent", id: "sales" },
      { kind: "agent", id: "chief" },
    ]);
    expect(dataTransfer.setDragImage).toHaveBeenCalledOnce();
  });
});

describe("Sidebar people", () => {
  it("reorders people with immediate row movement and keeps the order controlled", async () => {
    const props = sidebarProps();
    const view = render(() => <Sidebar {...props} />);
    const peopleItems = Array.from(view.container.querySelectorAll<HTMLElement>("[data-person-id]"));
    const sourceItem = peopleItems[0];
    const targetItem = peopleItems[1];
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    if (!sourceItem || !targetItem || !list) throw new Error("Sidebar person drag targets are missing.");
    const source = within(sourceItem).getByRole("button");
    const peopleSection = screen.getByRole("button", { name: "People" }).closest<HTMLElement>("section");
    const initialIds = peopleItems.map((item) => item.dataset.personId ?? "");
    for (const [index, item] of peopleItems.entries()) {
      vi.spyOn(item, "getBoundingClientRect").mockReturnValue(rect(12, 120 + index * 58, 256, 54));
    }
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue(rect(12, 120, 256, 54));
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 600));
    if (!peopleSection) throw new Error("People section is missing.");
    vi.spyOn(peopleSection, "getBoundingClientRect").mockReturnValue(rect(0, 90, 280, 300));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(sourceItem, dataTransfer, { clientX: 30, clientY: 140 });
    await dragOverFrame(targetItem, dataTransfer, { clientX: 30, clientY: 190 });

    dropAt(targetItem, dataTransfer, { clientX: 30, clientY: 190 });

    expect(props.onReorderPeople).toHaveBeenCalledWith([initialIds[1], initialIds[0], ...initialIds.slice(2)]);
    expect(props.onMutateLayout).not.toHaveBeenCalled();
  });

  it("does not pin a dragged person and supports keyboard reordering", async () => {
    const props = sidebarProps([{ kind: "agent", id: "chief" }]);
    const view = render(() => <Sidebar {...props} />);
    const peopleItems = Array.from(view.container.querySelectorAll<HTMLElement>("[data-person-id]"));
    const sourceItem = peopleItems[0];
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    const pinned = screen.getByRole("region", { name: "Pinned chats" });
    if (!sourceItem || !list) throw new Error("Sidebar person drag source is missing.");
    const source = within(sourceItem).getByRole("button");
    for (const [index, item] of peopleItems.entries()) {
      vi.spyOn(item, "getBoundingClientRect").mockReturnValue(rect(12, 120 + index * 58, 256, 54));
    }
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue(rect(12, 120, 256, 54));
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 600));
    vi.spyOn(pinned, "getBoundingClientRect").mockReturnValue(rect(0, 20, 280, 90));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(sourceItem, dataTransfer, { clientX: 30, clientY: 140 });
    await dragOverFrame(pinned, dataTransfer, { clientX: 100, clientY: 70 });
    dropAt(pinned, dataTransfer, { clientX: 100, clientY: 70 });

    expect(props.onPin).not.toHaveBeenCalled();
    expect(props.onReorderPeople).not.toHaveBeenCalled();

    const nextSource = within(peopleItems[1]).getByRole("button");
    fireEvent.keyDown(nextSource, { altKey: true, key: "ArrowDown" });
    const currentIds = peopleItems.map((item) => item.dataset.personId ?? "");
    expect(props.onReorderPeople).toHaveBeenCalledWith([
      currentIds[0],
      currentIds[2],
      currentIds[1],
      ...currentIds.slice(3),
    ]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Moved .+ to position 3 of 4\./));
  });
});

describe("Sidebar sections", () => {
  const demoId = "11111111-1111-4111-8111-111111111111";
  const emptyId = "22222222-2222-4222-8222-222222222222";
  const productId = "33333333-3333-4333-8333-333333333333";

  function sectionLayout() {
    return {
      revision: 1,
      sections: [
        { id: demoId, name: "Demo" },
        { id: emptyId, name: "Empty" },
      ],
      order: [demoId, "people", "unassigned", emptyId],
      agentAssignments: { chief: demoId, research: demoId },
      agentOrder: ["chief", "research", "sales"],
    };
  }

  function multiSectionLayout() {
    return {
      revision: 1,
      sections: [
        { id: demoId, name: "Demo" },
        { id: productId, name: "Product" },
      ],
      order: [demoId, "people", productId, "unassigned"],
      agentAssignments: { chief: demoId, research: demoId, sales: productId },
      agentOrder: ["chief", "research", "sales"],
    };
  }

  it("keeps sidebar layout controls unavailable when the host lacks the capability", async () => {
    const props = sidebarProps();
    const view = render(() => <Sidebar {...props} layout={sectionLayout()} layoutMutable={false} />);

    const section = screen.getByRole("button", { name: "Demo" });
    expect(section).toHaveAttribute("draggable", "false");
    expect(view.container.querySelector("[data-agent-id='chief']")).toHaveAttribute("draggable", "false");
    expect(screen.queryByLabelText("Sidebar free area")).not.toBeInTheDocument();

    await fireEvent.contextMenu(section);
    expect(screen.queryByRole("menu", { name: "Section actions" })).not.toBeInTheDocument();
    await fireEvent.contextMenu(screen.getByRole("button", { name: /Chief/ }));
    const agentMenu = await screen.findByRole("menu", { name: "Agent actions" });
    expect(within(agentMenu).queryByText("Move to")).not.toBeInTheDocument();
    expect(props.onMutateLayout).not.toHaveBeenCalled();
  });

  it("removes an agent row when the controlled bot list changes", async () => {
    const props = sidebarProps();
    const [bots, setBots] = createSignal(STORY_BOTS);
    render(() => <Sidebar {...props} bots={bots()} />);

    const sales = screen.getByRole("button", { name: /Sales/ });
    setBots((current) => current.filter((bot) => bot.id !== "sales"));

    await waitFor(() => expect(sales).not.toBeInTheDocument());
  });

  it("moves through empty custom sections and disables movement at the visible edge", async () => {
    const props = sidebarProps();
    const layout = sectionLayout();
    const layoutWithHiddenGap = { ...layout, order: [demoId, emptyId, "people", "unassigned"] };
    render(() => <Sidebar {...props} layout={layoutWithHiddenGap} />);

    await fireEvent.contextMenu(screen.getByRole("button", { name: "Demo" }));
    let sectionMenu = await screen.findByRole("menu", { name: "Section actions" });
    await fireEvent.pointerUp(within(sectionMenu).getByRole("menuitem", { name: "Move down" }), { button: 0 });
    expect(props.onMutateLayout).toHaveBeenCalledWith({
      type: "move",
      sectionId: demoId,
      direction: "down",
      steps: 1,
    });

    await fireEvent.contextMenu(screen.getByRole("button", { name: "Unassigned" }));
    sectionMenu = await screen.findByRole("menu", { name: "Section actions" });
    expect(within(sectionMenu).getByRole("menuitem", { name: "Move down" })).toHaveAttribute("aria-disabled", "true");
  });

  it("assigns agents to sections with bounded vertical drag and drop", async () => {
    const props = sidebarProps();
    const view = render(() => <Sidebar {...props} layout={sectionLayout()} />);
    const research = screen.getByRole("button", { name: /Research/ });
    const researchItem = research.closest<HTMLElement>("[data-agent-id]");
    const unassigned = screen.getByRole("button", { name: "Unassigned" }).closest<HTMLElement>("section");
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    if (!researchItem || !unassigned || !list) throw new Error("Sidebar drag targets are missing.");
    vi.spyOn(researchItem, "getBoundingClientRect").mockReturnValue(rect(12, 80, 256, 54));
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 600));
    vi.spyOn(unassigned, "getBoundingClientRect").mockReturnValue(rect(12, 300, 256, 100));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(researchItem, dataTransfer, { clientX: 30, clientY: 100 });
    await dragOverFrame(unassigned, dataTransfer, { clientX: 250, clientY: 330 });
    dropAt(unassigned, dataTransfer, { clientX: 250, clientY: 330 });

    expect(props.onMutateLayout).toHaveBeenCalledWith({
      type: "move-agent",
      agentId: "research",
      sectionId: null,
      beforeAgentId: null,
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved Research to Unassigned."));
  });

  it("unpins a pinned agent when it is dragged back into the sidebar", async () => {
    const props = sidebarProps([{ kind: "agent", id: "chief" }]);
    const view = render(() => <Sidebar {...props} layout={sectionLayout()} />);
    const pinnedItem = view.container.querySelector<HTMLElement>(".sidebar-pinned-item");
    const demoSection = screen.getByRole("button", { name: "Demo" }).closest<HTMLElement>("section");
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    if (!pinnedItem || !demoSection || !list) throw new Error("Pinned drag targets are missing.");
    vi.spyOn(pinnedItem, "getBoundingClientRect").mockReturnValue(rect(16, 20, 72, 94));
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 600));
    vi.spyOn(demoSection, "getBoundingClientRect").mockReturnValue(rect(12, 200, 256, 100));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(pinnedItem, dataTransfer, { clientX: 52, clientY: 48 });
    await dragOverFrame(demoSection, dataTransfer, { clientX: 250, clientY: 300 });

    dropAt(demoSection, dataTransfer, { clientX: 250, clientY: 300 });

    expect(props.onUnpin).toHaveBeenCalledWith({ kind: "agent", id: "chief" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved Chief to Demo."));
  });

  it("tracks every valid section for a pinned agent and clears the target over People", async () => {
    const props = sidebarProps([{ kind: "agent", id: "chief" }]);
    const view = render(() => <Sidebar {...props} layout={multiSectionLayout()} />);
    const pinnedItem = view.container.querySelector<HTMLElement>(".sidebar-pinned-item");
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    const people = screen.getByRole("button", { name: "People" }).closest<HTMLElement>("section");
    const demo = screen.getByRole("button", { name: "Demo" }).closest<HTMLElement>("section");
    const product = screen.getByRole("button", { name: "Product" }).closest<HTMLElement>("section");
    const sales = screen.getByRole("button", { name: /Sales/ }).closest<HTMLElement>("[data-agent-id]");
    const pinned = screen.getByRole("region", { name: "Pinned chats" });
    if (!pinnedItem || !list || !people || !demo || !product || !sales) {
      throw new Error("Multi-section drag targets are missing.");
    }
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 700));
    vi.spyOn(pinned, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 100));
    const peopleBounds = vi.spyOn(people, "getBoundingClientRect").mockReturnValue(rect(12, 110, 256, 180));
    const demoBounds = vi.spyOn(demo, "getBoundingClientRect").mockReturnValue(rect(12, 300, 256, 90));
    const productBounds = vi.spyOn(product, "getBoundingClientRect").mockReturnValue(rect(12, 400, 256, 90));
    vi.spyOn(pinnedItem, "getBoundingClientRect").mockReturnValue(rect(16, 8, 72, 94));
    vi.spyOn(sales, "getBoundingClientRect").mockReturnValue(rect(12, 432, 256, 54));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(pinnedItem, dataTransfer, { clientX: 40, clientY: 40 });
    await dragOverFrame(demo, dataTransfer, { clientX: 120, clientY: 340 });

    await dragOverFrame(people, dataTransfer, { clientX: 120, clientY: 180 });

    for (let index = 0; index < 50; index += 1) {
      fireEvent(product, nativeDragEvent("dragover", dataTransfer, { clientX: 120, clientY: 440 }));
    }
    await nextAnimationFrame();
    expect(peopleBounds).toHaveBeenCalledTimes(1);
    expect(demoBounds).toHaveBeenCalledTimes(1);
    expect(productBounds).toHaveBeenCalledTimes(1);

    dropAt(sales, dataTransfer, { clientX: 120, clientY: 440 });
    await waitFor(() =>
      expect(props.onMutateLayout).toHaveBeenCalledWith({
        type: "move-agent",
        agentId: "chief",
        sectionId: productId,
        beforeAgentId: "sales",
      }),
    );
    await waitFor(() => expect(props.onUnpin).toHaveBeenCalledWith({ kind: "agent", id: "chief" }));
  });

  it("keeps a pinned agent pinned when the target section mutation fails", async () => {
    const props = sidebarProps([{ kind: "agent", id: "chief" }]);
    props.onMutateLayout.mockRejectedValueOnce(new Error("Section move failed"));
    const view = render(() => <Sidebar {...props} layout={multiSectionLayout()} />);
    const pinnedItem = view.container.querySelector<HTMLElement>(".sidebar-pinned-item");
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    const product = screen.getByRole("button", { name: "Product" }).closest<HTMLElement>("section");
    const pinned = screen.getByRole("region", { name: "Pinned chats" });
    if (!pinnedItem || !list || !product) throw new Error("Pinned failure targets are missing.");
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 700));
    vi.spyOn(pinned, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 100));
    vi.spyOn(product, "getBoundingClientRect").mockReturnValue(rect(12, 400, 256, 90));
    vi.spyOn(pinnedItem, "getBoundingClientRect").mockReturnValue(rect(16, 8, 72, 94));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(pinnedItem, dataTransfer, { clientX: 40, clientY: 40 });
    await dragOverFrame(product, dataTransfer, { clientX: 120, clientY: 440 });
    dropAt(product, dataTransfer, { clientX: 120, clientY: 440 });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Section move failed"));
    expect(props.onUnpin).not.toHaveBeenCalled();
  });

  it("reorders sections by dropping onto an empty custom section", async () => {
    const props = sidebarProps();
    const layout = sectionLayout();
    const layoutWithHiddenGap = { ...layout, order: [demoId, emptyId, "people", "unassigned"] };
    const view = render(() => <Sidebar {...props} layout={layoutWithHiddenGap} />);
    const demo = screen.getByRole("button", { name: "Demo" });
    const demoSection = demo.closest<HTMLElement>("section");
    const emptySection = screen.getByRole("button", { name: "Empty" }).closest<HTMLElement>("section");
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    if (!demoSection || !emptySection || !list) throw new Error("Sidebar section drag targets are missing.");
    vi.spyOn(demo, "getBoundingClientRect").mockReturnValue(rect(12, 80, 256, 32));
    vi.spyOn(demoSection, "getBoundingClientRect").mockReturnValue(rect(12, 80, 256, 86));
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 600));
    const emptyBounds = vi.spyOn(emptySection, "getBoundingClientRect").mockReturnValue(rect(12, 180, 256, 36));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(demo, dataTransfer, { clientX: 30, clientY: 96 });
    for (let index = 0; index < 50; index += 1) {
      fireEvent(emptySection, nativeDragEvent("dragover", dataTransfer, { clientX: 250, clientY: 210 }));
    }
    await nextAnimationFrame();
    expect(emptyBounds).toHaveBeenCalledTimes(1);
    dropAt(emptySection, dataTransfer, { clientX: 250, clientY: 210 });

    expect(props.onMutateLayout).toHaveBeenCalledWith({
      type: "move",
      sectionId: demoId,
      direction: "down",
      steps: 1,
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved Demo to position 2 of 4."));
  });

  it("reorders agents inside one section with live row movement", async () => {
    const props = sidebarProps();
    const view = render(() => <Sidebar {...props} layout={sectionLayout()} />);
    const chief = screen.getByRole("button", { name: /Chief/ });
    const research = screen.getByRole("button", { name: /Research/ });
    const chiefItem = chief.closest<HTMLElement>("[data-agent-id]");
    const researchItem = research.closest<HTMLElement>("[data-agent-id]");
    const demoSection = screen.getByRole("button", { name: "Demo" }).closest<HTMLElement>("section");
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    if (!list || !chiefItem || !researchItem || !demoSection) throw new Error("Sidebar list is missing.");
    vi.spyOn(chief, "getBoundingClientRect").mockReturnValue(rect(12, 120, 256, 54));
    vi.spyOn(research, "getBoundingClientRect").mockReturnValue(rect(12, 174, 256, 54));
    vi.spyOn(chiefItem, "getBoundingClientRect").mockReturnValue(rect(12, 120, 256, 54));
    vi.spyOn(researchItem, "getBoundingClientRect").mockReturnValue(rect(12, 174, 256, 54));
    vi.spyOn(demoSection, "getBoundingClientRect").mockReturnValue(rect(12, 80, 256, 180));
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 600));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(researchItem, dataTransfer, { clientX: 30, clientY: 190 });
    const dragOver = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 30, clientY: 125 });
    Object.defineProperty(dragOver, "dataTransfer", { value: dataTransfer });
    fireEvent(chiefItem, dragOver);
    await nextAnimationFrame();

    const drop = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 30, clientY: 125 });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    fireEvent(chiefItem, drop);
    expect(props.onMutateLayout).toHaveBeenCalledWith({
      type: "move-agent",
      agentId: "research",
      sectionId: demoId,
      beforeAgentId: "chief",
    });
  });

  it("keeps collapsed private and expands matching search results temporarily", async () => {
    const props = sidebarProps();
    const [collapsed, setCollapsed] = createSignal([demoId]);
    render(() => (
      <Sidebar
        {...props}
        layout={sectionLayout()}
        collapsedSectionIds={collapsed()}
        onToggleSection={(sectionId) =>
          setCollapsed((current) =>
            current.includes(sectionId)
              ? current.filter((candidate) => candidate !== sectionId)
              : [...current, sectionId],
          )
        }
      />
    ));

    expect(screen.getByRole("button", { name: "Demo" })).toHaveAttribute("aria-expanded", "false");

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "Research" },
    });
    expect(screen.getByRole("button", { name: /Research/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Demo" })).toHaveAttribute("aria-expanded", "true");

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search chats" }), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Demo" })).toHaveAttribute("aria-expanded", "false");
  });

  it("creates and renames sections inline, with duplicate-name validation", async () => {
    const props = sidebarProps();
    render(() => <Sidebar {...props} layout={sectionLayout()} />);

    await fireEvent.contextMenu(screen.getByLabelText("Sidebar free area"));
    const sidebarMenu = await screen.findByRole("menu", { name: "Sidebar actions" });
    const newSection = within(sidebarMenu).getByRole("menuitem", { name: "New section" });
    await fireEvent.pointerUp(newSection, { button: 0 });
    let createInput = await screen.findByRole("textbox", { name: "New section name" });
    await fireEvent.input(createInput, { target: { value: "Draft" } });
    await fireEvent.blur(createInput);
    expect(screen.queryByRole("textbox", { name: "New section name" })).not.toBeInTheDocument();
    expect(props.onMutateLayout).not.toHaveBeenCalled();

    await fireEvent.contextMenu(screen.getByLabelText("Sidebar free area"));
    await fireEvent.pointerUp(
      within(await screen.findByRole("menu", { name: "Sidebar actions" })).getByRole("menuitem", {
        name: "New section",
      }),
      { button: 0 },
    );
    createInput = await screen.findByRole("textbox", { name: "New section name" });
    await fireEvent.input(createInput, { target: { value: "Product" } });
    await fireEvent.keyDown(createInput, { key: "Enter" });
    expect(props.onMutateLayout).toHaveBeenCalledWith({ type: "create", name: "Product" });

    await fireEvent.contextMenu(screen.getByRole("button", { name: "Demo" }));
    const sectionMenu = await screen.findByRole("menu", { name: "Section actions" });
    await fireEvent.pointerUp(within(sectionMenu).getByRole("menuitem", { name: "Rename" }), { button: 0 });
    const renameInput = await screen.findByRole("textbox", { name: "Rename section" });
    await fireEvent.input(renameInput, { target: { value: "Empty" } });
    await fireEvent.keyDown(renameInput, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Section names must be unique");

    await fireEvent.input(renameInput, { target: { value: "Core" } });
    await fireEvent.keyDown(renameInput, { key: "Enter" });
    expect(props.onMutateLayout).toHaveBeenCalledWith({ type: "rename", sectionId: demoId, name: "Core" });
  });

  it("confirms section deletion and moves system sections through shared actions", async () => {
    const props = sidebarProps();
    render(() => <Sidebar {...props} layout={sectionLayout()} />);

    await fireEvent.contextMenu(screen.getByRole("button", { name: "Demo" }));
    let sectionMenu = await screen.findByRole("menu", { name: "Section actions" });
    await fireEvent.pointerUp(within(sectionMenu).getByRole("menuitem", { name: "Delete" }), { button: 0 });
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Demo?" });
    expect(dialog).toHaveTextContent("Agents in this section will move to Unassigned");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(props.onMutateLayout).toHaveBeenCalledWith({ type: "delete", sectionId: demoId });
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Delete Demo?" })).not.toBeInTheDocument());

    await fireEvent.contextMenu(screen.getByRole("button", { name: "People" }));
    sectionMenu = await screen.findByRole("menu", { name: "Section actions" });
    expect(within(sectionMenu).queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    expect(within(sectionMenu).queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
    await fireEvent.pointerUp(within(sectionMenu).getByRole("menuitem", { name: "Move up" }), { button: 0 });
    expect(props.onMutateLayout).toHaveBeenCalledWith({
      type: "move",
      sectionId: "people",
      direction: "up",
      steps: 1,
    });
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}
