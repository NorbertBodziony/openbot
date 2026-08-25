import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { STORY_BOTS, STORY_DIRECT_THREADS, STORY_PRESENCE } from "../../stories/fixtures";
import type { SidebarPinnedItem } from "../sidebar-pins";
import { Sidebar } from "./Sidebar";

function sidebarProps(pinnedItems: SidebarPinnedItem[] = []) {
  return {
    serverName: "Local",
    bots: STORY_BOTS,
    activeBotId: "chief",
    people: STORY_PRESENCE.members,
    directThreads: STORY_DIRECT_THREADS,
    activeDirectMemberId: null,
    agentStates: {
      chief: { kind: "working" as const },
      research: { kind: "unread" as const, count: 3 },
    },
    pinnedItems,
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onReorderPinned: vi.fn(),
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

describe("Sidebar pinned chats", () => {
  it("shows mixed pinned chats once and filters them with search", async () => {
    const props = sidebarProps([
      { kind: "agent", id: "chief" },
      { kind: "person", id: "member-alice" },
      { kind: "agent", id: "missing" },
    ]);
    render(() => <Sidebar {...props} />);

    expect(screen.getByRole("region", { name: "Pinned chats" })).toBeInTheDocument();
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chief, pinned agent" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Alice Chen, pinned person" })).toBeInTheDocument();
    expect(screen.getByTitle("Chief of staff")).toHaveTextContent("Chief of staff");
    expect(screen.getAllByText("Chief")).toHaveLength(1);
    expect(screen.getAllByText("Alice Chen")).toHaveLength(1);

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search chats" }), {
      target: { value: "Sales" },
    });
    expect(screen.queryByRole("region", { name: "Pinned chats" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sales/ })).toBeInTheDocument();
  });

  it("offers pin actions for people and full agent actions for pinned agents", async () => {
    const props = sidebarProps([{ kind: "agent", id: "chief" }]);
    render(() => <Sidebar {...props} />);

    await fireEvent.contextMenu(screen.getByRole("button", { name: /Alice Chen/ }));
    const personMenu = await screen.findByRole("menu", { name: "Person actions" });
    await fireEvent.pointerUp(within(personMenu).getByRole("menuitem", { name: "Pin" }), { button: 0 });
    expect(props.onPin).toHaveBeenCalledWith({ kind: "person", id: "member-alice" });

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

  it("disables pin actions after six chats are pinned", async () => {
    const props = sidebarProps([
      { kind: "agent", id: "chief" },
      { kind: "agent", id: "research" },
      { kind: "agent", id: "sales" },
      { kind: "person", id: "member-alice" },
      { kind: "person", id: "member-jon" },
      { kind: "person", id: "member-maya" },
    ]);
    render(() => <Sidebar {...props} />);

    await fireEvent.contextMenu(screen.getByRole("button", { name: /^Norbert\./ }));
    const personMenu = await screen.findByRole("menu", { name: "Person actions" });
    const pinItem = within(personMenu).getByRole("menuitem", { name: "Pin" });
    expect(pinItem).toHaveAttribute("data-disabled");
    expect(pinItem).toHaveAttribute("title", "Maximum 6 pinned chats");

    await fireEvent.pointerUp(pinItem, { button: 0 });
    expect(props.onPin).not.toHaveBeenCalled();
  });

  it("reorders pinned chats by keyboard and constrained horizontal drag", async () => {
    const props = sidebarProps([
      { kind: "agent", id: "chief" },
      { kind: "agent", id: "research" },
      { kind: "person", id: "member-alice" },
    ]);
    const view = render(() => <Sidebar {...props} />);
    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".sidebar-pinned-item"));

    await fireEvent.keyDown(within(rows[1]).getByRole("button"), { key: "ArrowLeft", altKey: true });
    expect(props.onReorderPinned).toHaveBeenLastCalledWith([
      { kind: "agent", id: "research" },
      { kind: "agent", id: "chief" },
      { kind: "person", id: "member-alice" },
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
    if (!list) throw new Error("Pinned list is missing.");
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 80,
      left: 0,
      right: 256,
      width: 256,
      height: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };
    await fireEvent.dragStart(rows[0], { dataTransfer, clientX: 36, clientY: 20 });
    expect(rows[0]).toHaveClass("sidebar-pinned-item-dragging");
    await fireEvent.dragOver(rows[2], { dataTransfer, clientX: 800, clientY: 20 });
    expect(rows[2]).toHaveClass("sidebar-pinned-item-drag-over");
    expect(document.querySelector(".sidebar-pinned-drag-preview")).toBeInTheDocument();
    await fireEvent.drop(rows[2], { dataTransfer, clientX: 800, clientY: 20 });

    expect(props.onReorderPinned).toHaveBeenLastCalledWith([
      { kind: "agent", id: "research" },
      { kind: "person", id: "member-alice" },
      { kind: "agent", id: "chief" },
    ]);
    expect(dataTransfer.setDragImage).toHaveBeenCalledOnce();
    expect(document.querySelector(".sidebar-pinned-drag-preview")).not.toBeInTheDocument();
  });

  it("moves the preview and surrounding chats between pinned rows", async () => {
    const props = sidebarProps([
      { kind: "agent", id: "chief" },
      { kind: "agent", id: "research" },
      { kind: "agent", id: "sales" },
      { kind: "person", id: "member-alice" },
      { kind: "person", id: "member-jon" },
      { kind: "person", id: "member-maya" },
    ]);
    const view = render(() => <Sidebar {...props} />);
    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".sidebar-pinned-item"));
    for (const [index, row] of rows.entries()) {
      const column = index % 3;
      const line = Math.floor(index / 3);
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue(rect(column * 80, line * 102, 72, 94));
    }
    const list = view.container.querySelector<HTMLElement>(".sidebar-pinned-list");
    if (!list) throw new Error("Pinned list is missing.");
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 236, 200));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    await fireEvent.dragStart(rows[0], { dataTransfer, clientX: 36, clientY: 47 });
    await fireEvent.dragOver(rows[3], { dataTransfer, clientX: 36, clientY: 149 });

    expect(rows[3]).toHaveClass("sidebar-pinned-item-drag-over");
    expect(rows[3].style.getPropertyValue("--sidebar-pinned-drag-y")).toBe("-102px");
    expect(document.querySelector(".sidebar-pinned-drag-preview")).toBeInTheDocument();
    await fireEvent.dragEnd(rows[0], { dataTransfer });
    expect(document.querySelector(".sidebar-pinned-drag-preview")).not.toBeInTheDocument();
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
