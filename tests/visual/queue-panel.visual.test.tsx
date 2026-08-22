import type { AttachmentSummary, QueueDelivery } from "@openbot/contracts/ipc";
import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../src/renderer/src/styles.css";
import "../../.storybook/preview.css";
import { QueuePanel } from "../../src/renderer/src/components/conversation/QueuePanel";

const previewUrl = new URL("../../src/renderer/src/assets/openbot-logo-production.png", import.meta.url).href;
const previewAttachment: AttachmentSummary = {
  id: "queue-visual-preview",
  name: "queue-preview.png",
  size: 1_024,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl,
};

const messages = [
  "Improve how right-clicking an agent works in the sidebar. It should match the app…",
  "The inputs are still not right. Check exactly how they work in the application…",
  "Add Command+F to chat, like in Grok Bot, and keep message reordering consistent…",
  "Add the same search modal as Grok Bot for messages and agents…",
  "The latest chat message is too low. Move it up so it stays visible…",
  "Run all checks and fix every failure",
  "Push the final changes to main",
] as const;

const deliveries: QueueDelivery[] = messages.map((text, index) => ({
  id: `queue-visual-${index + 1}`,
  messageId: `queue-visual-message-${index + 1}`,
  recipientBotId: "chief",
  sender: { kind: "user" },
  text,
  attachments: index === 2 || index === 3 ? [{ ...previewAttachment, id: `preview-${index}` }] : [],
  replyToMessageId: null,
  status: "queued",
  position: index + 1,
  turnId: null,
  error: null,
  createdAt: `2026-08-20T10:0${index}:00.000Z`,
}));

test("the queue panel matches the dense seven-row reference", async () => {
  const view = render(() => (
    <div
      data-testid="queue-reference-stage"
      style={{
        position: "relative",
        width: "758px",
        height: "337px",
        display: "flex",
        "align-items": "flex-end",
        background: "var(--openbot-bg-canvas)",
      }}
    >
      <div class="composer-wrap" style={{ width: "100%" }}>
        <QueuePanel
          deliveries={deliveries}
          canSteer
          onSteer={vi.fn()}
          onCancel={vi.fn()}
          onEdit={vi.fn()}
          onReorder={vi.fn()}
        />
        <div class="composer" aria-hidden="true" />
      </div>
    </div>
  ));

  await expect(page.getByTestId("queue-reference-stage")).toMatchScreenshot("queue-panel-reference");

  const rows = document.querySelectorAll<HTMLFieldSetElement>(".agent-queue-item");
  const dataTransfer = new DataTransfer();
  await fireEvent.dragStart(rows[0], { dataTransfer });
  const targetRect = rows[3].getBoundingClientRect();
  await fireEvent.dragOver(rows[3], {
    dataTransfer,
    clientY: targetRect.top + targetRect.height / 2,
  });

  await expect(page.getByTestId("queue-reference-stage")).toMatchScreenshot("queue-panel-drag-state");
  await fireEvent.dragEnd(rows[0], { dataTransfer });
  view.unmount();
});

test("mouse drag-and-drop changes the interactive queue order", async () => {
  const [queue, setQueue] = createSignal(deliveries.slice(0, 4));
  const view = render(() => (
    <div style={{ position: "relative", width: "758px", height: "260px" }}>
      <div class="composer-wrap" style={{ position: "absolute", right: "0", bottom: "0", left: "0" }}>
        <QueuePanel
          deliveries={queue()}
          canSteer
          onSteer={vi.fn()}
          onCancel={vi.fn()}
          onEdit={vi.fn()}
          onReorder={(ids) => {
            const byId = new Map(queue().map((delivery) => [delivery.id, delivery]));
            setQueue(
              ids.flatMap((id, index) => {
                const delivery = byId.get(id);
                return delivery ? [{ ...delivery, position: index + 1 }] : [];
              }),
            );
          }}
        />
        <div class="composer" aria-hidden="true" />
      </div>
    </div>
  ));

  const rows = view.container.querySelectorAll<HTMLFieldSetElement>(".agent-queue-item");
  const first = rows[0];
  const third = rows[2];
  await userEvent.dragAndDrop(first, third);

  await expect
    .poll(() => Array.from(view.container.querySelectorAll(".agent-queue-message"), (row) => row.textContent))
    .toEqual([messages[1], messages[2], messages[0], messages[3]]);
});
