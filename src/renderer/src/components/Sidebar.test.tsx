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
    onDeleteBot: vi.fn(async () => undefined),
    compact: false,
    onCollapse: vi.fn(),
    onExpand: vi.fn(),
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
  it("opens the active server settings from the server title", async () => {
    const props = sidebarProps();
    render(() => <Sidebar {...props} />);

    await fireEvent.click(screen.getByRole("button", { name: "Open settings for Local" }));

    expect(props.onOpenServerSettings).toHaveBeenCalledWith(expect.any(HTMLElement));
  });

  it("shows agent pins, ignores legacy person pins, and filters with search", async () => {
    const props = sidebarProps([
      { kind: "agent", id: "chief" },
      { kind: "person", id: "member-alice" },
      { kind: "agent", id: "missing" },
    ]);
    render(() => <Sidebar {...props} />);

    expect(screen.getByRole("region", { name: "Pinned chats" })).toBeInTheDocument();
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chief, pinned agent" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Alice Chen, pinned person" })).not.toBeInTheDocument();
    expect(screen.getByTitle("Chief of staff")).toHaveTextContent("Chief of staff");
    expect(screen.getAllByText("Chief")).toHaveLength(1);
    expect(screen.getAllByText("Alice Chen")).toHaveLength(1);

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
    const editItem = within(agentMenu).getByRole("menuitem", { name: "Edit agent" });
    const deleteItem = within(agentMenu).getByRole("menuitem", { name: "Delete agent" });
    const divider = within(agentMenu).getByRole("separator");
    expect(editItem).toBeInTheDocument();
    expect(deleteItem).toBeInTheDocument();
    expect(divider.nextElementSibling).toBe(deleteItem);
    await fireEvent.pointerUp(within(agentMenu).getByRole("menuitem", { name: "Unpin" }), { button: 0 });
    expect(props.onUnpin).toHaveBeenCalledWith({ kind: "agent", id: "chief" });
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
    expect(pinItem).toHaveAttribute("data-disabled");
    expect(pinItem).toHaveAttribute("title", "Maximum 6 pinned chats");

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
    await waitFor(() => expect(rows[0]).toHaveClass("sidebar-pinned-item-dragging"));
    await dragOverFrame(rows[2], dataTransfer, { clientX: 200, clientY: 20 });
    expect(rows[2]).toHaveClass("sidebar-pinned-item-drag-over");
    expect(document.querySelector(".sidebar-pinned-drag-preview")).toBeInTheDocument();
    dropAt(rows[2], dataTransfer, { clientX: 200, clientY: 20 });

    expect(props.onReorderPinned).toHaveBeenLastCalledWith([
      { kind: "agent", id: "research" },
      { kind: "agent", id: "sales" },
      { kind: "agent", id: "chief" },
    ]);
    expect(dataTransfer.setDragImage).toHaveBeenCalledOnce();
    expect(document.querySelector(".sidebar-pinned-drag-preview")).not.toBeInTheDocument();
  });

  it("pins an agent dropped on the pinned area with the same native drag path", async () => {
    const props = sidebarProps([{ kind: "agent", id: "research" }]);
    const view = render(() => <Sidebar {...props} />);
    const chief = screen.getByRole("button", { name: /Chief/ });
    const chiefItem = chief.closest<HTMLElement>("[data-agent-id]");
    const pinned = screen.getByRole("region", { name: "Pinned chats" });
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    if (!chiefItem || !list) throw new Error("Sidebar list is missing.");
    vi.spyOn(chiefItem, "getBoundingClientRect").mockReturnValue(rect(12, 180, 256, 54));
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 600));
    vi.spyOn(pinned, "getBoundingClientRect").mockReturnValue(rect(0, 20, 280, 120));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(chiefItem, dataTransfer, { clientX: 30, clientY: 200 });
    expect(screen.queryByText("Drag here to pin")).not.toBeInTheDocument();
    await dragOverFrame(pinned, dataTransfer, { clientX: 100, clientY: 100 });
    expect(pinned).toHaveClass("sidebar-pinned-group-agent-drop-target");
    expect(list).toHaveAttribute("data-sidebar-dragging");

    dropAt(pinned, dataTransfer, { clientX: 100, clientY: 100 });

    expect(props.onPin).toHaveBeenCalledWith({ kind: "agent", id: "chief" });
    expect(pinned).not.toHaveClass("sidebar-pinned-group-agent-drop-target");
    await waitFor(() => expect(list).not.toHaveAttribute("data-sidebar-dragging"));
    expect(document.querySelector(".sidebar-agent-drag-preview")).not.toBeInTheDocument();
  });

  it("keeps the animated empty pin field as a live drop target", async () => {
    const props = sidebarProps();
    const view = render(() => <Sidebar {...props} />);
    const chief = screen.getByRole("button", { name: /Chief/ });
    const chiefItem = chief.closest<HTMLElement>("[data-agent-id]");
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    if (!chiefItem || !list) throw new Error("Sidebar agent drag source is missing.");
    vi.spyOn(chiefItem, "getBoundingClientRect").mockReturnValue(rect(12, 180, 256, 54));
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 600));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(chiefItem, dataTransfer, { clientX: 30, clientY: 200 });
    await dragOverFrame(list, dataTransfer, { clientX: 32, clientY: 196 });
    const pinned = screen.getByRole("region", { name: "Pinned chats" });
    const field = screen.getByText("Drag here to pin");
    vi.spyOn(pinned, "getBoundingClientRect").mockReturnValue(rect(0, 20, 280, 6));
    vi.spyOn(field, "getBoundingClientRect").mockReturnValue(rect(12, 24, 256, 104));

    await fireEvent.transitionEnd(pinned, { propertyName: "grid-template-rows" });
    await dragOverFrame(field, dataTransfer, { clientX: 100, clientY: 72 });
    expect(pinned).toHaveClass("sidebar-pinned-group-agent-drop-target");

    vi.mocked(field.getBoundingClientRect).mockReturnValue(rect(12, 200, 256, 104));
    fireEvent(chiefItem, nativeDragEvent("dragend", dataTransfer, { clientX: 100, clientY: 72 }));
    expect(props.onPin).toHaveBeenCalledWith({ kind: "agent", id: "chief" });
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
    expect(screen.queryByText("Drag here to pin")).not.toBeInTheDocument();
    await dragOverFrame(targetItem, dataTransfer, { clientX: 30, clientY: 190 });

    expect(targetItem.style.getPropertyValue("--sidebar-person-drag-y")).toBe("-58px");
    const preview = document.querySelector<HTMLElement>(".sidebar-person-drag-preview");
    expect(preview).toBeInTheDocument();
    expect(preview).toHaveStyle({ height: "94px", width: "72px" });
    expect(preview).toHaveTextContent(source.textContent?.match(/Alice Chen|Maya|Norbert|Jon/)?.[0] ?? "");
    expect(preview?.querySelector(".bot-row-preview")).not.toBeInTheDocument();

    dropAt(targetItem, dataTransfer, { clientX: 30, clientY: 190 });

    expect(props.onReorderPeople).toHaveBeenCalledWith([initialIds[1], initialIds[0], ...initialIds.slice(2)]);
    expect(props.onMutateLayout).not.toHaveBeenCalled();
    expect(document.querySelector(".sidebar-person-drag-preview")).not.toBeInTheDocument();
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
    expect(pinned).not.toHaveClass("sidebar-pinned-group-agent-drop-target");
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

  it("removes an agent row when the controlled bot list changes", async () => {
    const props = sidebarProps();
    const [bots, setBots] = createSignal(STORY_BOTS);
    render(() => <Sidebar {...props} bots={bots()} />);

    const sales = screen.getByRole("button", { name: /Sales/ });
    setBots((current) => current.filter((bot) => bot.id !== "sales"));

    await waitFor(() => expect(sales).not.toBeInTheDocument());
  });

  it("moves across hidden sections and disables movement at the visible edge", async () => {
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
      steps: 2,
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
    await waitFor(() => expect(research).toHaveClass("sidebar-agent-row-dragging"));
    expect(document.querySelector(".sidebar-agent-drag-preview")).toBeInTheDocument();
    await dragOverFrame(unassigned, dataTransfer, { clientX: 250, clientY: 330 });
    expect(unassigned).toHaveClass("sidebar-section-agent-drop-target");
    dropAt(unassigned, dataTransfer, { clientX: 250, clientY: 330 });

    expect(props.onMutateLayout).toHaveBeenCalledWith({
      type: "move-agent",
      agentId: "research",
      sectionId: null,
      beforeAgentId: null,
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved Research to Unassigned."));
    expect(document.querySelector(".sidebar-agent-drag-preview")).not.toBeInTheDocument();
  });

  it("unpins a pinned agent when it is dragged back into the sidebar", async () => {
    const props = sidebarProps([{ kind: "agent", id: "chief" }]);
    const view = render(() => <Sidebar {...props} layout={sectionLayout()} />);
    const pinnedItem = view.container.querySelector<HTMLElement>(".sidebar-pinned-item");
    const pinned = screen.getByRole("region", { name: "Pinned chats" });
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

    expect(demoSection).toHaveClass("sidebar-section-agent-drop-target");
    expect(pinned).not.toHaveClass("sidebar-pinned-group-agent-drop-target");
    expect(list).toHaveAttribute("data-sidebar-dragging");
    expect(document.querySelector(".sidebar-pinned-drag-preview")).toBeInTheDocument();

    dropAt(demoSection, dataTransfer, { clientX: 250, clientY: 300 });

    expect(props.onUnpin).toHaveBeenCalledWith({ kind: "agent", id: "chief" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved Chief to Demo."));
    expect(demoSection).not.toHaveClass("sidebar-section-agent-drop-target");
    expect(list).not.toHaveAttribute("data-sidebar-dragging");
    expect(document.querySelector(".sidebar-pinned-drag-preview")).not.toBeInTheDocument();
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
    expect(demo).toHaveClass("sidebar-section-agent-drop-target");

    await dragOverFrame(people, dataTransfer, { clientX: 120, clientY: 180 });
    expect(demo).not.toHaveClass("sidebar-section-agent-drop-target");
    expect(people).not.toHaveClass("sidebar-section-agent-drop-target");

    for (let index = 0; index < 50; index += 1) {
      fireEvent(product, nativeDragEvent("dragover", dataTransfer, { clientX: 120, clientY: 440 }));
    }
    await nextAnimationFrame();
    expect(product).toHaveClass("sidebar-section-agent-drop-target");
    expect(demo).not.toHaveClass("sidebar-section-agent-drop-target");
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

  it("reorders visible sections by drag and drop across hidden sections", async () => {
    const props = sidebarProps();
    const layout = sectionLayout();
    const layoutWithHiddenGap = { ...layout, order: [demoId, emptyId, "people", "unassigned"] };
    const view = render(() => <Sidebar {...props} layout={layoutWithHiddenGap} />);
    const demo = screen.getByRole("button", { name: "Demo" });
    const demoSection = demo.closest<HTMLElement>("section");
    const peopleSection = screen.getByRole("button", { name: "People" }).closest<HTMLElement>("section");
    const list = view.container.querySelector<HTMLElement>(".bot-list");
    if (!demoSection || !peopleSection || !list) throw new Error("Sidebar section drag targets are missing.");
    vi.spyOn(demo, "getBoundingClientRect").mockReturnValue(rect(12, 80, 256, 32));
    vi.spyOn(demoSection, "getBoundingClientRect").mockReturnValue(rect(12, 80, 256, 86));
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 280, 600));
    const peopleBounds = vi.spyOn(peopleSection, "getBoundingClientRect").mockReturnValue(rect(12, 180, 256, 180));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    dragStartAt(demo, dataTransfer, { clientX: 30, clientY: 96 });
    await waitFor(() => expect(demoSection).toHaveClass("sidebar-section-dragging"));
    for (let index = 0; index < 50; index += 1) {
      fireEvent(peopleSection, nativeDragEvent("dragover", dataTransfer, { clientX: 250, clientY: 320 }));
    }
    await nextAnimationFrame();
    expect(peopleSection).toHaveClass("sidebar-section-drop-after");
    expect(peopleSection.style.getPropertyValue("--sidebar-section-drag-y")).toBe("-100px");
    expect(peopleBounds).toHaveBeenCalledTimes(1);
    const preview = document.querySelector<HTMLElement>(".sidebar-section-drag-preview");
    expect(preview).toBeInTheDocument();
    expect(preview?.style.transform).toContain("translate3d(12px,");
    dropAt(peopleSection, dataTransfer, { clientX: 250, clientY: 320 });

    expect(props.onMutateLayout).toHaveBeenCalledWith({
      type: "move",
      sectionId: demoId,
      direction: "down",
      steps: 2,
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved Demo to position 2 of 3."));
    expect(document.querySelector(".sidebar-section-drag-preview")).not.toBeInTheDocument();
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

    await waitFor(() => expect(chiefItem.style.getPropertyValue("--sidebar-agent-drag-y")).toBe("54px"));
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
    const view = render(() => (
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

    const body = view.container.querySelector<HTMLElement>(`#sidebar-section-body-${demoId}`)?.parentElement;
    expect(body).toHaveAttribute("data-collapsed");
    expect(body).toHaveAttribute("inert");

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "Research" },
    });
    expect(body).not.toHaveAttribute("data-collapsed");
    expect(screen.getByRole("button", { name: /Research/ })).toBeInTheDocument();

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search chats" }), { target: { value: "" } });
    expect(body).toHaveAttribute("data-collapsed");
  });

  it("creates and renames sections inline, with duplicate-name validation", async () => {
    const props = sidebarProps();
    render(() => <Sidebar {...props} layout={sectionLayout()} />);

    await fireEvent.contextMenu(screen.getByLabelText("Sidebar free area"));
    const sidebarMenu = await screen.findByRole("menu", { name: "Sidebar actions" });
    const newSection = within(sidebarMenu).getByRole("menuitem", { name: "New section" });
    await fireEvent.pointerUp(newSection, { button: 0 });
    const createInput = await screen.findByRole("textbox", { name: "New section name" });
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
