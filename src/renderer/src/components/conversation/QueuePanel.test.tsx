import type { AttachmentSummary, QueueDelivery } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { triggerResize } from "../../setupTests";
import { QueuePanel } from "./QueuePanel";

const imageAttachment: AttachmentSummary = {
  id: "attachment-image",
  name: "preview.png",
  size: 1_024,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl: "data:image/png;base64,iVBORw0KGgo=",
};

const fileAttachment: AttachmentSummary = {
  id: "attachment-file",
  name: "notes.md",
  size: 512,
  kind: "file",
  mimeType: "text/markdown",
  previewKind: "text",
  previewUrl: null,
};

function delivery(position: number, overrides: Partial<QueueDelivery> = {}): QueueDelivery {
  return {
    id: `delivery-${position}`,
    messageId: `message-${position}`,
    recipientBotId: "chief",
    sender: { kind: "user" },
    text: `Queued task ${position}`,
    attachments: [],
    replyToMessageId: null,
    status: "queued",
    position,
    turnId: null,
    error: null,
    createdAt: `2026-08-20T10:0${position}:00.000Z`,
    ...overrides,
  };
}

function callbacks() {
  return {
    onSteer: vi.fn(),
    onCancel: vi.fn(),
    onEdit: vi.fn(),
    onReorder: vi.fn(),
  };
}

describe("QueuePanel", () => {
  it("sorts visible deliveries and renders first-attachment previews", () => {
    const props = callbacks();
    const view = render(() => (
      <QueuePanel
        deliveries={[
          delivery(3, { attachments: [fileAttachment] }),
          delivery(1, { attachments: [imageAttachment] }),
          delivery(4, { status: "completed" }),
          delivery(2, { status: "starting" }),
        ]}
        canSteer
        {...props}
      />
    ));

    expect(Array.from(view.container.querySelectorAll(".agent-queue-message")).map((node) => node.textContent)).toEqual(
      ["Queued task 1", "Queued task 2", "Queued task 3"],
    );
    expect(view.container.querySelector('.agent-queue-attachment img[src^="data:image/png"]')).toBeInTheDocument();
    expect(view.container.querySelector(".agent-queue-attachment")?.textContent).not.toContain("TXT");
    expect(view.container.querySelectorAll(".agent-queue-attachment")[1]).toHaveTextContent("TXT");
    expect(view.container.querySelector(".agent-queue-drag-handle")).toBeNull();
  });

  it("keeps steer, cancel, and edit actions connected", async () => {
    const props = callbacks();
    render(() => <QueuePanel deliveries={[delivery(1), delivery(2), delivery(3)]} canSteer {...props} />);

    await fireEvent.click(screen.getByRole("button", { name: "Steer queued message 1" }));
    await fireEvent.click(screen.getByRole("button", { name: "Edit queued message 2" }));
    await fireEvent.click(screen.getByRole("button", { name: "Delete queued message 3" }));

    expect(props.onSteer).toHaveBeenCalledWith("delivery-1");
    await waitFor(() => expect(props.onCancel).toHaveBeenCalledWith("delivery-3"));
    await waitFor(() => expect(props.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "delivery-2" })));
    expect(screen.queryByRole("button", { name: "Resume queue" })).not.toBeInTheDocument();
  });

  it("shows tooltips for the row actions", async () => {
    const props = callbacks();
    render(() => <QueuePanel deliveries={[delivery(1)]} canSteer {...props} />);

    const steer = screen.getByRole("button", { name: "Steer queued message 1" });
    await fireEvent.pointerEnter(steer);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Steer message");
    await fireEvent.pointerLeave(steer);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    const remove = screen.getByRole("button", { name: "Delete queued message 1" });
    await fireEvent.focus(remove);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Delete message");
    await fireEvent.keyDown(remove, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    const edit = screen.getByRole("button", { name: "Edit queued message 1" });
    await fireEvent.mouseEnter(edit);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Edit message");
  });

  it("reorders queued messages with the keyboard and drag-and-drop", async () => {
    const props = callbacks();
    const view = render(() => <QueuePanel deliveries={[delivery(1), delivery(2), delivery(3)]} canSteer {...props} />);
    const rows = Array.from(view.container.querySelectorAll<HTMLFieldSetElement>(".agent-queue-item"));

    await fireEvent.keyDown(rows[1], { key: "ArrowUp", altKey: true });
    expect(props.onReorder).toHaveBeenLastCalledWith(["delivery-2", "delivery-1", "delivery-3"]);
    expect(screen.getByRole("status")).toHaveTextContent("Moved queued message to position 1 of 3.");

    for (const [index, row] of rows.entries()) {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top: index * 29,
        bottom: (index + 1) * 29,
        left: 0,
        right: 600,
        width: 600,
        height: 29,
        x: 0,
        y: index * 29,
        toJSON: () => ({}),
      });
    }

    const dataTransfer = { setData: vi.fn(), effectAllowed: "move", dropEffect: "move" };
    await fireEvent.dragStart(rows[0], { dataTransfer });
    await fireEvent.dragOver(rows[2], { dataTransfer, clientY: 72.5 });

    expect(rows[0].style.getPropertyValue("--queue-drag-step")).toBe("0");
    expect(rows[1].style.getPropertyValue("--queue-drag-step")).toBe("-1");
    expect(rows[2].style.getPropertyValue("--queue-drag-step")).toBe("-1");
    expect(view.container.querySelector(".agent-queue-panel")).toHaveClass("agent-queue-panel-dragging");

    await fireEvent.drop(rows[2], { dataTransfer, clientY: 72.5 });

    expect(props.onReorder).toHaveBeenLastCalledWith(["delivery-2", "delivery-3", "delivery-1"]);
    expect(rows[0].style.getPropertyValue("--queue-drag-step")).toBe("0");
    expect(view.container.querySelector(".agent-queue-panel")).not.toHaveClass("agent-queue-panel-dragging");
    expect(screen.getByRole("status")).toHaveTextContent("Moved queued message to position 3 of 3.");
  });

  it("does not start row dragging from an action button", async () => {
    const props = callbacks();
    const view = render(() => <QueuePanel deliveries={[delivery(1), delivery(2)]} canSteer {...props} />);
    const edit = screen.getByRole("button", { name: "Edit queued message 1" });
    const dataTransfer = { setData: vi.fn(), effectAllowed: "move", dropEffect: "move" };

    await fireEvent.dragStart(edit, { dataTransfer });

    expect(dataTransfer.setData).not.toHaveBeenCalled();
    expect(view.container.querySelector(".agent-queue-panel")).not.toHaveClass("agent-queue-panel-dragging");
  });

  it("keeps the drag preview inside the queue and locks its horizontal position", async () => {
    const props = callbacks();
    const view = render(() => <QueuePanel deliveries={[delivery(1), delivery(2)]} canSteer {...props} />);
    const list = view.container.querySelector<HTMLDivElement>(".agent-queue-panel-list");
    const row = view.container.querySelector<HTMLFieldSetElement>(".agent-queue-item");
    if (!list || !row) throw new Error("Queue elements are missing.");

    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 100, y: 50, width: 400, height: 150 }),
    );
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 112, y: 60, width: 376, height: 29 }));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };

    const dispatchDrag = (type: "dragstart" | "drag" | "dragend", clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      fireEvent(row, event);
    };

    dispatchDrag("dragstart", 200, 70);
    const preview = document.body.querySelector<HTMLElement>(".agent-queue-drag-preview");
    expect(preview).toBeInTheDocument();
    expect(dataTransfer.setDragImage).toHaveBeenCalled();
    expect(preview).toHaveStyle({
      left: "112px",
      top: "0px",
      width: "376px",
      transform: "translate3d(0px, 60px, 0)",
    });

    window.dispatchEvent(new MouseEvent("dragover", { clientX: -500, clientY: 250 }));
    expect(preview).toHaveStyle({ left: "112px", transform: "translate3d(0px, 171px, 0)" });

    window.dispatchEvent(new MouseEvent("dragover", { clientX: 900, clientY: 25 }));
    expect(preview).toHaveStyle({ left: "112px", transform: "translate3d(0px, 50px, 0)" });

    dispatchDrag("dragend", 900, 25);
    expect(preview).not.toBeInTheDocument();
  });

  it("auto-scrolls a long queue while dragging near its edge", async () => {
    const props = callbacks();
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const view = render(() => (
      <QueuePanel deliveries={Array.from({ length: 10 }, (_, index) => delivery(index + 1))} canSteer {...props} />
    ));
    const list = view.container.querySelector<HTMLDivElement>(".agent-queue-panel-list");
    const panel = view.container.querySelector<HTMLElement>(".agent-queue-panel");
    const rows = view.container.querySelectorAll<HTMLFieldSetElement>(".agent-queue-item");
    if (!list || !panel) throw new Error("Queue panel is missing.");
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 212 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 290 });
    list.scrollTop = 50;
    const listBounds = vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 212,
      left: 0,
      right: 600,
      width: 600,
      height: 212,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    for (const [index, row] of Array.from(rows).entries()) {
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        top: index * 29,
        bottom: (index + 1) * 29,
        left: 0,
        right: 600,
        width: 600,
        height: 29,
        x: 0,
        y: index * 29,
        toJSON: () => ({}),
      });
    }

    const dataTransfer = { setData: vi.fn(), effectAllowed: "move", dropEffect: "move" };
    await fireEvent.dragStart(rows[0], { dataTransfer });
    const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperties(dragOver, {
      clientY: { value: 2 },
      dataTransfer: { value: dataTransfer },
    });
    fireEvent(panel, dragOver);
    expect(listBounds).toHaveBeenCalled();
    expect(list.scrollTop).toBeLessThan(50);
    expect(requestFrame).toHaveBeenCalled();
    const nextFrame = requestFrame.mock.calls[0]?.[0];
    if (!nextFrame) throw new Error("Auto-scroll frame is missing.");
    nextFrame(performance.now());
    expect(list.scrollTop).toBeLessThan(42);
    await fireEvent.dragEnd(rows[0], { dataTransfer });
  });

  it("animates queue additions and removals", async () => {
    const props = callbacks();
    const [deliveries, setDeliveries] = createSignal([delivery(1)]);
    const view = render(() => <QueuePanel deliveries={deliveries()} canSteer {...props} />);

    setDeliveries([delivery(1), delivery(2)]);
    await waitFor(() =>
      expect(view.container.querySelector('[data-queue-delivery-id="delivery-2"]')).toHaveClass(
        "agent-queue-item-entering",
      ),
    );

    await fireEvent.click(screen.getByRole("button", { name: "Delete queued message 1" }));
    expect(view.container.querySelector('[data-queue-delivery-id="delivery-1"]')).toHaveClass(
      "agent-queue-item-removing",
    );
    await waitFor(() => expect(props.onCancel).toHaveBeenCalledWith("delivery-1"));
  });

  it("smoothly resizes the panel when the queue height changes", async () => {
    const props = callbacks();
    const [deliveries, setDeliveries] = createSignal([delivery(1), delivery(2)]);
    const view = render(() => <QueuePanel deliveries={deliveries()} canSteer {...props} />);
    const list = view.container.querySelector<HTMLElement>(".agent-queue-panel-list");
    const resizeContainer = view.container.querySelector<HTMLElement>(".agent-queue-panel-resize");
    if (!list || !resizeContainer) throw new Error("Queue resize elements are missing.");

    let height = 67;
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() =>
      DOMRect.fromRect({ height, width: 600, x: 0, y: 0 }),
    );
    const cancel = vi.fn();
    const animate = vi.fn().mockReturnValue({ cancel, finished: Promise.resolve() });
    Object.defineProperty(resizeContainer, "animate", { configurable: true, value: animate });

    triggerResize(list);
    setDeliveries([delivery(1), delivery(2), delivery(3)]);
    height = 96;
    triggerResize(list);

    expect(animate).toHaveBeenCalledWith([{ height: "67px" }, { height: "96px" }], {
      duration: 240,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
  });

  it("keeps a removed queue entry mounted until its exit transition finishes", async () => {
    const props = callbacks();
    const [deliveries, setDeliveries] = createSignal([delivery(1), delivery(2)]);
    const view = render(() => <QueuePanel deliveries={deliveries()} canSteer {...props} />);

    setDeliveries([delivery(2)]);

    const departingRow = view.container.querySelector<HTMLElement>('[data-queue-delivery-id="delivery-1"]');
    await waitFor(() => expect(departingRow).toHaveClass("agent-queue-item-removing"));
    expect(departingRow).toHaveAttribute("aria-hidden", "true");
    expect(departingRow).toBeDisabled();
    expect(departingRow).toHaveAttribute("draggable", "false");
    await waitFor(() => expect(departingRow).not.toBeInTheDocument());
    expect(screen.getByText("Queued task 2")).toBeInTheDocument();
  });

  it("animates an edited row out and restores it at the same position", async () => {
    const props = callbacks();
    const [editingDeliveryId, setEditingDeliveryId] = createSignal<string | null>(null);
    const view = render(() => (
      <QueuePanel
        deliveries={[delivery(1), delivery(2), delivery(3)]}
        editingDeliveryId={editingDeliveryId()}
        canSteer
        {...props}
      />
    ));

    setEditingDeliveryId("delivery-2");

    await waitFor(() =>
      expect(view.container.querySelector('[data-queue-delivery-id="delivery-2"]')).toHaveClass(
        "agent-queue-item-removing",
      ),
    );
    await waitFor(() =>
      expect(view.container.querySelector('[data-queue-delivery-id="delivery-2"]')).not.toBeInTheDocument(),
    );

    setEditingDeliveryId(null);

    await waitFor(() =>
      expect(view.container.querySelector('[data-queue-delivery-id="delivery-2"]')).toHaveClass(
        "agent-queue-item-entering",
      ),
    );
    expect(Array.from(view.container.querySelectorAll(".agent-queue-message"), (node) => node.textContent)).toEqual([
      "Queued task 1",
      "Queued task 2",
      "Queued task 3",
    ]);
  });
});
