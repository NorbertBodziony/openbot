import type { QueueDelivery } from "@openbot/contracts/ipc";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { Button } from "../ui";
import { AnchoredTooltip } from "./AnchoredTooltip";
import { fileBadge } from "./AttachmentCards";
import { EditIcon, QueueIcon, SteerIcon, TrashIcon } from "./ConversationIcons";

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

interface DragSlot {
  id: string;
  centerY: number;
}

export function QueuePanel(props: QueuePanelProps) {
  const [draggedId, setDraggedId] = createSignal<string | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const actionTooltipId = `queue-action-tooltip-${createUniqueId()}`;
  const [actionTooltip, setActionTooltip] = createSignal<{ anchor: HTMLElement; content: string } | null>(null);
  let queueList: HTMLDivElement | undefined;
  let dragSlots: DragSlot[] = [];
  let dragStartScrollTop = 0;

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

  function dragStep(deliveryId: string): number {
    const sourceId = draggedId();
    const targetId = dragOverId();
    if (!sourceId || !targetId || sourceId === targetId) return 0;

    const ids = queueIds();
    const sourceIndex = ids.indexOf(sourceId);
    const targetIndex = ids.indexOf(targetId);
    const deliveryIndex = ids.indexOf(deliveryId);
    if (sourceIndex < 0 || targetIndex < 0 || deliveryIndex < 0) return 0;

    if (deliveryId === sourceId) return 0;
    if (sourceIndex < targetIndex && deliveryIndex > sourceIndex && deliveryIndex <= targetIndex) return -1;
    if (sourceIndex > targetIndex && deliveryIndex >= targetIndex && deliveryIndex < sourceIndex) return 1;
    return 0;
  }

  function measureDragSlots() {
    if (!queueList) return;
    dragStartScrollTop = queueList.scrollTop;
    dragSlots = [];
    for (const row of queueList.querySelectorAll<HTMLFieldSetElement>('.agent-queue-item[draggable="true"]')) {
      const id = row.dataset.queueDeliveryId;
      if (!id) continue;
      const rect = row.getBoundingClientRect();
      dragSlots.push({ id, centerY: rect.top + rect.height / 2 });
    }
  }

  function updateDragTarget(clientY: number) {
    if (!queueList || dragSlots.length === 0) return;
    const scrollDelta = queueList.scrollTop - dragStartScrollTop;
    let closest = dragSlots[0];
    let closestDistance = Math.abs(clientY - (closest.centerY - scrollDelta));
    for (const slot of dragSlots.slice(1)) {
      const distance = Math.abs(clientY - (slot.centerY - scrollDelta));
      if (distance >= closestDistance) continue;
      closest = slot;
      closestDistance = distance;
    }
    if (dragOverId() !== closest.id) setDragOverId(closest.id);
  }

  function setDragPreview(event: DragEvent & { currentTarget: HTMLFieldSetElement }) {
    if (!event.dataTransfer?.setDragImage) return;

    const source = event.currentTarget;
    const preview = source.cloneNode(true);
    if (!(preview instanceof HTMLFieldSetElement)) return;
    preview.classList.remove("agent-queue-item-dragging", "agent-queue-item-drag-over");
    preview.classList.add("agent-queue-drag-preview");
    preview.setAttribute("aria-hidden", "true");
    preview.removeAttribute("tabindex");
    preview.style.width = `${source.getBoundingClientRect().width}px`;
    document.body.append(preview);
    event.dataTransfer.setDragImage(preview, 28, 15);
    requestAnimationFrame(() => preview.remove());
  }

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

  function openActionTooltip(anchor: HTMLElement, content: string) {
    setActionTooltip({ anchor, content });
  }

  function closeActionTooltip(anchor: HTMLElement) {
    if (actionTooltip()?.anchor === anchor) setActionTooltip(null);
  }

  function closeActionTooltipOnEscape(event: KeyboardEvent) {
    if (event.key === "Escape" && event.currentTarget instanceof HTMLElement) closeActionTooltip(event.currentTarget);
  }

  return (
    <>
      <section
        class={[
          "agent-queue-panel",
          {
            "agent-queue-panel-dragging": Boolean(draggedId()),
          },
        ]}
        aria-label="Message queue"
        onDragOver={(event) => {
          if (!draggedId()) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          updateDragTarget(event.clientY);
        }}
        onDrop={(event) => {
          event.preventDefault();
          const targetId = dragOverId();
          if (targetId) dropDelivery(targetId);
          setDraggedId(null);
          setDragOverId(null);
        }}
      >
        <div class="agent-queue-panel-list" ref={(element) => (queueList = element)}>
          <For each={visibleDeliveries()}>
            {(delivery) => {
              const firstAttachment = delivery.attachments[0];
              return (
                <fieldset
                  class={[
                    "agent-queue-item",
                    {
                      "agent-queue-item-dragging": draggedId() === delivery.id,
                      "agent-queue-item-drag-over": dragOverId() === delivery.id,
                      "agent-queue-item-steering": delivery.status === "starting",
                      "agent-queue-item-has-attachment": Boolean(firstAttachment),
                    },
                  ]}
                  style={{ "--queue-drag-step": dragStep(delivery.id) }}
                  data-queue-delivery-id={delivery.id}
                  draggable={delivery.status === "queued" ? "true" : "false"}
                  onDragStart={(event) => {
                    if (delivery.status !== "queued") return;
                    event.dataTransfer?.setData("text/plain", delivery.id);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                    measureDragSlots();
                    setDragPreview(event);
                    setDraggedId(delivery.id);
                    setDragOverId(delivery.id);
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
                  <span class="agent-queue-icon" aria-hidden="true">
                    <QueueIcon />
                  </span>
                  <Show when={firstAttachment}>
                    {(attachment) => (
                      <span class="agent-queue-attachment" aria-hidden="true">
                        <Show
                          when={attachment().previewKind === "image" && attachment().previewUrl}
                          fallback={<span>{fileBadge(attachment())}</span>}
                        >
                          <img src={attachment().previewUrl ?? ""} alt="" />
                        </Show>
                      </span>
                    )}
                  </Show>
                  <span class="agent-queue-message" title={messagePreview(delivery)}>
                    {messagePreview(delivery)}
                  </span>
                  <div class="agent-queue-actions">
                    <Button
                      type="button"
                      class="agent-queue-steer"
                      disabled={!props.canSteer || delivery.status !== "queued"}
                      aria-describedby={actionTooltipId}
                      aria-label={`Steer queued message ${delivery.position ?? ""}`}
                      onPointerEnter={(event) => openActionTooltip(event.currentTarget, "Steer message")}
                      onMouseEnter={(event) => openActionTooltip(event.currentTarget, "Steer message")}
                      onPointerLeave={(event) => closeActionTooltip(event.currentTarget)}
                      onMouseLeave={(event) => closeActionTooltip(event.currentTarget)}
                      onFocus={(event) => openActionTooltip(event.currentTarget, "Steer message")}
                      onBlur={(event) => closeActionTooltip(event.currentTarget)}
                      onKeyDown={closeActionTooltipOnEscape}
                      onClick={() => {
                        setActionTooltip(null);
                        props.onSteer(delivery.id);
                      }}
                    >
                      <SteerIcon />
                      <span>{delivery.status === "starting" ? "Steering" : "Steer"}</span>
                    </Button>
                    <Button
                      type="button"
                      class="agent-queue-icon-button agent-queue-delete"
                      disabled={delivery.status !== "queued"}
                      aria-describedby={actionTooltipId}
                      aria-label={`Delete queued message ${delivery.position ?? ""}`}
                      onPointerEnter={(event) => openActionTooltip(event.currentTarget, "Delete message")}
                      onMouseEnter={(event) => openActionTooltip(event.currentTarget, "Delete message")}
                      onPointerLeave={(event) => closeActionTooltip(event.currentTarget)}
                      onMouseLeave={(event) => closeActionTooltip(event.currentTarget)}
                      onFocus={(event) => openActionTooltip(event.currentTarget, "Delete message")}
                      onBlur={(event) => closeActionTooltip(event.currentTarget)}
                      onKeyDown={closeActionTooltipOnEscape}
                      onClick={() => {
                        setActionTooltip(null);
                        props.onCancel(delivery.id);
                      }}
                    >
                      <TrashIcon />
                    </Button>
                    <Button
                      type="button"
                      class="agent-queue-icon-button agent-queue-edit"
                      disabled={delivery.status !== "queued"}
                      aria-describedby={actionTooltipId}
                      aria-label={`Edit queued message ${delivery.position ?? ""}`}
                      onPointerEnter={(event) => openActionTooltip(event.currentTarget, "Edit message")}
                      onMouseEnter={(event) => openActionTooltip(event.currentTarget, "Edit message")}
                      onPointerLeave={(event) => closeActionTooltip(event.currentTarget)}
                      onMouseLeave={(event) => closeActionTooltip(event.currentTarget)}
                      onFocus={(event) => openActionTooltip(event.currentTarget, "Edit message")}
                      onBlur={(event) => closeActionTooltip(event.currentTarget)}
                      onKeyDown={closeActionTooltipOnEscape}
                      onClick={() => {
                        setActionTooltip(null);
                        props.onEdit(delivery);
                      }}
                    >
                      <EditIcon />
                    </Button>
                  </div>
                </fieldset>
              );
            }}
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
      <Show when={actionTooltip()}>
        {(current) => <AnchoredTooltip id={actionTooltipId} anchor={current().anchor} content={current().content} />}
      </Show>
    </>
  );
}
