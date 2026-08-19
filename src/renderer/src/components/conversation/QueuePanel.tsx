import type { QueueDelivery } from "@openbot/contracts/ipc";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Button, DropdownMenu } from "../ui";
import { DragHandleIcon, EditIcon, MoreIcon, QueueIcon, SteerIcon, TrashIcon } from "./ConversationIcons";

interface QueuePanelProps {
  deliveries: QueueDelivery[];
  paused: boolean;
  canSteer: boolean;
  onSteer: (deliveryId: string) => void;
  onCancel: (deliveryId: string) => void;
  onEdit: (delivery: QueueDelivery) => void;
  onReorder: (deliveryIds: string[]) => void;
  onResume: () => void;
}

export function QueuePanel(props: QueuePanelProps) {
  const [draggedId, setDraggedId] = createSignal<string | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);

  const visibleDeliveries = createMemo(() =>
    props.deliveries
      .filter((delivery) => delivery.status === "queued" || delivery.status === "starting")
      .sort((left, right) => {
        const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;
        return leftPosition - rightPosition || left.createdAt.localeCompare(right.createdAt);
      }),
  );

  const queueIds = createMemo(() =>
    visibleDeliveries()
      .filter((delivery) => delivery.status === "queued")
      .map((delivery) => delivery.id),
  );

  function moveDelivery(deliveryId: string, direction: -1 | 1) {
    const ids = [...queueIds()];
    const index = ids.indexOf(deliveryId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    props.onReorder(ids);
  }

  function dropDelivery(targetId: string) {
    const sourceId = draggedId();
    if (!sourceId || sourceId === targetId) return;
    const ids = [...queueIds()];
    const sourceIndex = ids.indexOf(sourceId);
    const targetIndex = ids.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    ids.splice(sourceIndex, 1);
    ids.splice(targetIndex, 0, sourceId);
    props.onReorder(ids);
  }

  function messagePreview(delivery: QueueDelivery): string {
    return delivery.text.trim() || delivery.attachments.map((attachment) => attachment.name).join(", ") || "Attachment";
  }

  return (
    <section class="agent-queue-panel" aria-label="Message queue">
      <div class="agent-queue-panel-list">
        <For each={visibleDeliveries()}>
          {(delivery) => (
            <fieldset
              class={[
                "agent-queue-item",
                {
                  "agent-queue-item-dragging": draggedId() === delivery.id,
                  "agent-queue-item-drag-over": dragOverId() === delivery.id,
                  "agent-queue-item-steering": delivery.status === "starting",
                },
              ]}
              draggable={delivery.status === "queued" ? "true" : "false"}
              onDragStart={(event) => {
                if (delivery.status !== "queued") return;
                event.dataTransfer?.setData("text/plain", delivery.id);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                setDraggedId(delivery.id);
              }}
              onDragOver={(event) => {
                if (delivery.status !== "queued" || !draggedId()) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                setDragOverId(delivery.id);
              }}
              onDragLeave={() => {
                if (dragOverId() === delivery.id) setDragOverId(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropDelivery(delivery.id);
                setDraggedId(null);
                setDragOverId(null);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDragOverId(null);
              }}
              onKeyDown={(event) => {
                if (delivery.status !== "queued" || !event.altKey) return;
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveDelivery(delivery.id, -1);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveDelivery(delivery.id, 1);
                }
              }}
              tabindex={delivery.status === "queued" ? 0 : -1}
              aria-label={`Queued message ${delivery.position ?? ""}: ${messagePreview(delivery)}`}
            >
              <span class="agent-queue-drag-handle" aria-hidden="true">
                <DragHandleIcon />
              </span>
              <span class="agent-queue-icon" aria-hidden="true">
                <QueueIcon />
              </span>
              <span class="agent-queue-message" title={messagePreview(delivery)}>
                {messagePreview(delivery)}
              </span>
              <div class="agent-queue-actions">
                <Button
                  type="button"
                  class="agent-queue-steer"
                  disabled={!props.canSteer || delivery.status !== "queued"}
                  onClick={() => props.onSteer(delivery.id)}
                  aria-label={`Steer queued message ${delivery.position ?? ""}`}
                >
                  <SteerIcon />
                  <span>{delivery.status === "starting" ? "Steering" : "Steer"}</span>
                </Button>
                <Button
                  type="button"
                  class="agent-queue-icon-button"
                  disabled={delivery.status !== "queued"}
                  onClick={() => props.onCancel(delivery.id)}
                  aria-label={`Cancel queued message ${delivery.position ?? ""}`}
                  title="Delete queued message"
                >
                  <TrashIcon />
                </Button>
                <div class="agent-queue-menu-anchor">
                  <DropdownMenu.Root placement="bottom-end" gutter={4} modal={false}>
                    <DropdownMenu.Trigger
                      class="agent-queue-icon-button"
                      aria-label={`More actions for queued message ${delivery.position ?? ""}`}
                    >
                      <MoreIcon />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content class="agent-queue-menu">
                      <DropdownMenu.Item onSelect={() => props.onEdit(delivery)}>
                        <EditIcon />
                        Edit message
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                </div>
              </div>
            </fieldset>
          )}
        </For>
      </div>
      <Show when={props.paused}>
        <div class="agent-queue-panel-footer">
          <span>Queue paused</span>
          <Button type="button" onClick={props.onResume}>
            Resume queue
          </Button>
        </div>
      </Show>
    </section>
  );
}
