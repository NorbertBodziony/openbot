import type { AttachmentSummary, QueueDelivery } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
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
  });

  it("renders semantic tags as readable queue text", () => {
    render(() => (
      <QueuePanel
        deliveries={[delivery(1, { text: "Use @[Old name](skill:skill-1)." })]}
        skills={[
          {
            skillId: "skill-1",
            slug: "release-notes",
            name: "Release Notes",
            installedVersion: 1,
            availableVersion: 1,
            state: "installed",
          },
        ]}
        canSteer
        {...callbacks()}
      />
    ));

    expect(screen.getByText("Use Release Notes (skill).")).toBeInTheDocument();
    expect(screen.queryByText(/skill:skill-1/u)).not.toBeInTheDocument();
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

    await fireEvent.drop(rows[2], { dataTransfer, clientY: 72.5 });

    expect(props.onReorder).toHaveBeenLastCalledWith(["delivery-2", "delivery-3", "delivery-1"]);
    expect(screen.getByRole("status")).toHaveTextContent("Moved queued message to position 3 of 3.");
  });

  it("does not start row dragging from an action button", async () => {
    const props = callbacks();
    render(() => <QueuePanel deliveries={[delivery(1), delivery(2)]} canSteer {...props} />);
    const edit = screen.getByRole("button", { name: "Edit queued message 1" });
    const dataTransfer = { setData: vi.fn(), effectAllowed: "move", dropEffect: "move" };

    await fireEvent.dragStart(edit, { dataTransfer });

    expect(dataTransfer.setData).not.toHaveBeenCalled();
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
});
