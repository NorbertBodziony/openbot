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
    onResume: vi.fn(),
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
        paused={false}
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

  it("keeps steer, cancel, edit, and resume actions connected", async () => {
    const props = callbacks();
    render(() => <QueuePanel deliveries={[delivery(1)]} paused canSteer {...props} />);

    await fireEvent.click(screen.getByRole("button", { name: "Steer queued message 1" }));
    await fireEvent.click(screen.getByRole("button", { name: "Delete queued message 1" }));
    await fireEvent.click(screen.getByRole("button", { name: "Edit queued message 1" }));
    await fireEvent.click(screen.getByRole("button", { name: "Resume queue" }));

    expect(props.onSteer).toHaveBeenCalledWith("delivery-1");
    expect(props.onCancel).toHaveBeenCalledWith("delivery-1");
    await waitFor(() => expect(props.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "delivery-1" })));
    expect(props.onResume).toHaveBeenCalledOnce();
  });

  it("shows tooltips for the row actions", async () => {
    const props = callbacks();
    render(() => <QueuePanel deliveries={[delivery(1)]} paused={false} canSteer {...props} />);

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
    const view = render(() => (
      <QueuePanel deliveries={[delivery(1), delivery(2), delivery(3)]} paused={false} canSteer {...props} />
    ));
    const rows = Array.from(view.container.querySelectorAll<HTMLFieldSetElement>(".agent-queue-item"));

    await fireEvent.keyDown(rows[1], { key: "ArrowUp", altKey: true });
    expect(props.onReorder).toHaveBeenLastCalledWith(["delivery-2", "delivery-1", "delivery-3"]);

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
  });
});
