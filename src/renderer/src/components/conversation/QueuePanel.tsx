import { expandChatTagReferences } from "@openbot/contracts/chat-tag-references";
import type { InstalledSkill, QueueDelivery } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show, untrack } from "solid-js";
import type { AgentProfile } from "../../data";
import { createVerticalDragPreview } from "../createVerticalDragPreview";
import { Button } from "../ui";
import { AnchoredTooltip } from "./AnchoredTooltip";
import { fileBadge } from "./AttachmentCards";
import { EditIcon, QueueIcon, SteerIcon, TrashIcon } from "./ConversationIcons";
import { createSmoothHeightResize } from "./createSmoothHeightResize";

interface QueuePanelProps {
  deliveries: QueueDelivery[];
  agents?: AgentProfile[];
  skills?: InstalledSkill[];
  editingDeliveryId?: string | null;
  canSteer: boolean;
  onSteer: (deliveryId: string) => void;
  onCancel: (deliveryId: string) => void;
  onEdit: (delivery: QueueDelivery) => void;
  onReorder: (deliveryIds: string[]) => void;
}

interface DragSlot {
  id: string;
  centerY: number;
}

export function QueuePanel(props: QueuePanelProps) {
  const [draggedId, setDraggedId] = createSignal<string | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [announcement, setAnnouncement] = createSignal("");
  const [enteringIds, setEnteringIds] = createSignal<ReadonlySet<string>>(new Set());
  const [removingIds, setRemovingIds] = createSignal<ReadonlySet<string>>(new Set());
  const [editingExitId, setEditingExitId] = createSignal<string | null>(null);
  const [hiddenEditingId, setHiddenEditingId] = createSignal<string | null>(null);
  const actionTooltipId = `queue-action-tooltip-${createUniqueId()}`;
  const [actionTooltip, setActionTooltip] = createSignal<{ anchor: HTMLElement; content: string } | null>(null);
  let queueList: HTMLDivElement | undefined;
  let queueResizeContainer: HTMLDivElement | undefined;
  let dragSlots: DragSlot[] = [];
  let dragStartScrollTop = 0;
  let lastDragClientY = 0;
  let autoScrollVelocity = 0;
  let autoScrollFrame: number | null = null;
  const dragPreview = createVerticalDragPreview();
  let editingExitTimer: ReturnType<typeof setTimeout> | undefined;
  const externalRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const animationTimers = new Set<ReturnType<typeof setTimeout>>();

  const sourceDeliveries = createMemo(() =>
    props.deliveries
      .filter((delivery) => delivery.status === "queued" || delivery.status === "starting")
      .sort((left, right) => {
        const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;
        return leftPosition - rightPosition || left.createdAt.localeCompare(right.createdAt);
      }),
  );
  const initialSourceDeliveries = untrack(sourceDeliveries);
  const [renderedDeliveries, setRenderedDeliveries] = createSignal<QueueDelivery[]>(initialSourceDeliveries);
  const visibleDeliveries = createMemo(() =>
    renderedDeliveries().filter((delivery) => delivery.id !== hiddenEditingId()),
  );
  let knownSourceIds = new Set(initialSourceDeliveries.map((delivery) => delivery.id));

  const queueIds = createMemo(() =>
    visibleDeliveries()
      .filter((delivery) => delivery.status === "queued" && delivery.id !== props.editingDeliveryId)
      .map((delivery) => delivery.id),
  );

  createEffect(
    () => props.editingDeliveryId ?? null,
    (editingId) => {
      if (editingExitTimer) clearTimeout(editingExitTimer);
      editingExitTimer = undefined;
      if (!editingId) {
        const restoredId = untrack(hiddenEditingId);
        setEditingExitId(null);
        setHiddenEditingId(null);
        if (restoredId) {
          setEnteringIds((current) => new Set([...current, restoredId]));
          scheduleAnimationCleanup(
            () =>
              setEnteringIds((current) => {
                const remaining = new Set(current);
                remaining.delete(restoredId);
                return remaining;
              }),
            200,
          );
        }
        return;
      }

      setHiddenEditingId(null);
      setEditingExitId(editingId);
      if (reducedMotion()) {
        setHiddenEditingId(editingId);
        setEditingExitId(null);
        return;
      }
      editingExitTimer = setTimeout(() => {
        editingExitTimer = undefined;
        if (props.editingDeliveryId !== editingId) return;
        setHiddenEditingId(editingId);
        setEditingExitId(null);
      }, 200);
    },
  );

  createEffect(
    () => sourceDeliveries(),
    (deliveries) => {
      const current = untrack(renderedDeliveries);
      const nextIds = new Set(deliveries.map((delivery) => delivery.id));
      const restoredIds = new Set([...nextIds].filter((id) => externalRemovalTimers.has(id)));
      const addedIds = deliveries
        .filter((delivery) => !knownSourceIds.has(delivery.id) && !restoredIds.has(delivery.id))
        .map((delivery) => delivery.id);
      knownSourceIds = nextIds;

      for (const id of nextIds) {
        const timer = externalRemovalTimers.get(id);
        if (!timer) continue;
        clearTimeout(timer);
        externalRemovalTimers.delete(id);
        setRemovingIds((ids) => {
          const next = new Set(ids);
          next.delete(id);
          return next;
        });
      }

      const retainedExits: Array<{ delivery: QueueDelivery; index: number }> = [];
      for (const [index, delivery] of current.entries()) {
        if (nextIds.has(delivery.id)) continue;
        if (untrack(removingIds).has(delivery.id) && !externalRemovalTimers.has(delivery.id)) {
          setRemovingIds((ids) => {
            const next = new Set(ids);
            next.delete(delivery.id);
            return next;
          });
          continue;
        }
        if (reducedMotion()) continue;
        retainedExits.push({ delivery, index });
        if (externalRemovalTimers.has(delivery.id)) continue;
        setRemovingIds((ids) => new Set([...ids, delivery.id]));
        const timer = setTimeout(() => {
          externalRemovalTimers.delete(delivery.id);
          setRenderedDeliveries((items) => items.filter((item) => item.id !== delivery.id));
          setRemovingIds((ids) => {
            const next = new Set(ids);
            next.delete(delivery.id);
            return next;
          });
        }, 200);
        externalRemovalTimers.set(delivery.id, timer);
      }

      const nextRendered = [...deliveries];
      for (const { delivery, index } of retainedExits) {
        nextRendered.splice(Math.min(index, nextRendered.length), 0, delivery);
      }
      setRenderedDeliveries(nextRendered);

      if (addedIds.length > 0) {
        setEnteringIds((current) => new Set([...current, ...addedIds]));
        scheduleAnimationCleanup(
          () =>
            setEnteringIds((current) => {
              const remaining = new Set(current);
              for (const id of addedIds) remaining.delete(id);
              return remaining;
            }),
          200,
        );
      }
    },
  );

  onCleanup(() => {
    stopAutoScroll();
    dragPreview.stop();
    if (editingExitTimer) clearTimeout(editingExitTimer);
    for (const timer of externalRemovalTimers.values()) clearTimeout(timer);
    for (const timer of animationTimers) clearTimeout(timer);
  });

  createSmoothHeightResize({
    container: () => queueResizeContainer,
    content: () => queueList,
    skip: () => Boolean(queueList?.querySelector(".agent-queue-item-removing")),
  });

  function scheduleAnimationCleanup(callback: () => void, delay: number) {
    const timer = setTimeout(() => {
      animationTimers.delete(timer);
      callback();
    }, delay);
    animationTimers.add(timer);
  }

  function reducedMotion(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }

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

  function scrollQueueOnce(): boolean {
    if (!queueList) return false;
    const previousScrollTop = queueList.scrollTop;
    queueList.scrollTop += autoScrollVelocity;
    if (queueList.scrollTop !== previousScrollTop) updateDragTarget(lastDragClientY);
    return queueList.scrollTop !== previousScrollTop;
  }

  function runAutoScroll() {
    autoScrollFrame = null;
    if (!queueList || !draggedId() || autoScrollVelocity === 0) return;
    if (!scrollQueueOnce()) {
      autoScrollVelocity = 0;
      return;
    }
    autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
  }

  function updateAutoScroll(clientY: number) {
    if (!queueList) return;
    lastDragClientY = clientY;
    const bounds = queueList.getBoundingClientRect();
    const edgeSize = Math.min(36, bounds.height / 3);
    const topDistance = clientY - bounds.top;
    const bottomDistance = bounds.bottom - clientY;
    const maxSpeed = 8;

    if (topDistance < edgeSize) {
      autoScrollVelocity = -Math.min(maxSpeed, Math.max(2, Math.ceil((1 - topDistance / edgeSize) * maxSpeed)));
    } else if (bottomDistance < edgeSize) {
      autoScrollVelocity = Math.min(maxSpeed, Math.max(2, Math.ceil((1 - bottomDistance / edgeSize) * maxSpeed)));
    } else {
      autoScrollVelocity = 0;
    }

    if (autoScrollVelocity !== 0 && autoScrollFrame === null && scrollQueueOnce()) {
      autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
    }
    if (autoScrollVelocity === 0 && autoScrollFrame !== null) {
      window.cancelAnimationFrame(autoScrollFrame);
      autoScrollFrame = null;
    }
  }

  function stopAutoScroll() {
    autoScrollVelocity = 0;
    if (autoScrollFrame === null) return;
    window.cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = null;
  }

  function setDragPreview(event: DragEvent & { currentTarget: HTMLFieldSetElement }) {
    if (!queueList) return;
    dragPreview.start({
      bounds: queueList,
      className: "agent-queue-drag-preview",
      event,
      source: event.currentTarget,
    });
  }

  function moveDelivery(deliveryId: string, direction: -1 | 1) {
    const ids = [...queueIds()];
    const index = ids.indexOf(deliveryId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    props.onReorder(ids);
    setAnnouncement(`Moved queued message to position ${target + 1} of ${ids.length}.`);
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
    setAnnouncement(`Moved queued message to position ${targetIndex + 1} of ${ids.length}.`);
  }

  function requestCancel(deliveryId: string) {
    if (removingIds().has(deliveryId)) return;
    setRemovingIds((current) => new Set([...current, deliveryId]));
    scheduleAnimationCleanup(() => props.onCancel(deliveryId), reducedMotion() ? 0 : 200);
  }

  function messagePreview(delivery: QueueDelivery): string {
    const agentNames = new Map((props.agents ?? []).map((agent) => [agent.id, agent.name]));
    const skillNames = new Map((props.skills ?? []).map((skill) => [skill.skillId, skill.name]));
    const text = expandChatTagReferences(delivery.text.trim(), (reference) =>
      reference.kind === "agent" ? agentNames.get(reference.id) : skillNames.get(reference.id),
    );
    return text || delivery.attachments.map((attachment) => attachment.name).join(", ") || "Attachment";
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
          dragPreview.move(event.clientY);
          updateDragTarget(event.clientY);
          updateAutoScroll(event.clientY);
        }}
        onDrop={(event) => {
          event.preventDefault();
          const targetId = dragOverId();
          if (targetId) dropDelivery(targetId);
          setDraggedId(null);
          setDragOverId(null);
          stopAutoScroll();
          dragPreview.stop();
        }}
      >
        <div class="agent-queue-panel-resize" ref={(element) => (queueResizeContainer = element)}>
          <div class="agent-queue-panel-list" ref={(element) => (queueList = element)}>
            <For each={visibleDeliveries()}>
              {(delivery) => {
                const firstAttachment = delivery.attachments[0];
                const removing = () => removingIds().has(delivery.id) || editingExitId() === delivery.id;
                return (
                  <fieldset
                    class={[
                      "agent-queue-item",
                      {
                        "agent-queue-item-dragging": draggedId() === delivery.id,
                        "agent-queue-item-drag-over": dragOverId() === delivery.id,
                        "agent-queue-item-entering": enteringIds().has(delivery.id),
                        "agent-queue-item-removing": removing(),
                        "agent-queue-item-steering": delivery.status === "starting",
                        "agent-queue-item-has-attachment": Boolean(firstAttachment),
                      },
                    ]}
                    style={{ "--queue-drag-step": dragStep(delivery.id) }}
                    data-queue-delivery-id={delivery.id}
                    draggable={delivery.status === "queued" && !removing() ? "true" : "false"}
                    disabled={removing()}
                    aria-hidden={removing() ? "true" : undefined}
                    inert={removing() ? true : undefined}
                    onDragStart={(event) => {
                      if (delivery.status !== "queued") return;
                      if (event.target instanceof Element && event.target.closest(".agent-queue-actions")) {
                        event.preventDefault();
                        return;
                      }
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
                      stopAutoScroll();
                      dragPreview.stop();
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
                    tabindex={delivery.status === "queued" && !removing() ? 0 : -1}
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
                        variant="ghost"
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
                        variant="destructive-ghost"
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
                          requestCancel(delivery.id);
                        }}
                      >
                        <TrashIcon />
                      </Button>
                      <Button
                        variant="ghost"
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
        </div>
        <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement()}
        </div>
      </section>
      <Show when={actionTooltip()}>
        {(current) => <AnchoredTooltip id={actionTooltipId} anchor={current().anchor} content={current().content} />}
      </Show>
    </>
  );
}
