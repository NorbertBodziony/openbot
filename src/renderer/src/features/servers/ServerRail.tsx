import type { ServerSummary } from "@openbot/contracts/ipc";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { createScrollFades } from "../../components/createScrollFades";
import { createVerticalDragPreview } from "../../components/createVerticalDragPreview";
import { buttonVariants, ContextMenu, ServerGradientLogo, Tooltip } from "../../components/ui";

const SERVER_RAIL_TOOLTIP_OPEN_DELAY = 150;

interface ServerRailProps {
  servers: ServerSummary[];
  onSelect: (serverId: string) => void;
  onReorder: (serverIds: string[]) => void;
  onAdd: () => void;
  onOpenSettings: (serverId: string, trigger: HTMLElement | null) => void;
}

interface DragSlot {
  id: string;
  centerY: number;
}

export function ServerRail(props: ServerRailProps) {
  const [draggedId, setDraggedId] = createSignal<string | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [announcement, setAnnouncement] = createSignal("");
  const scrollFades = createScrollFades();
  let railList: HTMLDivElement | undefined;
  let remoteList: HTMLUListElement | undefined;
  let dragSlots: DragSlot[] = [];
  let dragStartScrollTop = 0;
  let lastDragClientY = 0;
  let autoScrollVelocity = 0;
  let autoScrollFrame: number | null = null;
  const dragPreview = createVerticalDragPreview();
  const localServers = () => props.servers.filter((server) => server.kind === "local");
  const remoteServers = () => props.servers.filter((server) => server.kind === "remote");

  onCleanup(() => {
    stopAutoScroll();
    dragPreview.stop();
    scrollFades.stop();
  });

  createEffect(
    () => props.servers.length,
    () => {
      scrollFades.remeasure();
    },
  );

  function remoteServerIds(): string[] {
    return remoteServers().map((server) => server.id);
  }

  function dragStep(serverId: string): number {
    const sourceId = draggedId();
    const targetId = dragOverId();
    if (!sourceId || !targetId || sourceId === targetId) return 0;

    const ids = remoteServerIds();
    const sourceIndex = ids.indexOf(sourceId);
    const targetIndex = ids.indexOf(targetId);
    const serverIndex = ids.indexOf(serverId);
    if (sourceIndex < 0 || targetIndex < 0 || serverIndex < 0 || serverId === sourceId) return 0;
    if (sourceIndex < targetIndex && serverIndex > sourceIndex && serverIndex <= targetIndex) return -1;
    if (sourceIndex > targetIndex && serverIndex >= targetIndex && serverIndex < sourceIndex) return 1;
    return 0;
  }

  function measureDragSlots(): void {
    if (!railList || !remoteList) return;
    dragStartScrollTop = railList.scrollTop;
    dragSlots = [];
    for (const item of remoteList.querySelectorAll<HTMLElement>(".server-rail-server-item")) {
      const id = item.dataset.serverId;
      if (!id) continue;
      const bounds = item.getBoundingClientRect();
      dragSlots.push({ id, centerY: bounds.top + bounds.height / 2 });
    }
  }

  function updateDragTarget(clientY: number): string | null {
    const first = dragSlots[0];
    if (!first) return null;
    const scrollDelta = (railList?.scrollTop ?? 0) - dragStartScrollTop;
    let closest = first;
    let closestDistance = Math.abs(clientY - (first.centerY - scrollDelta));
    for (const slot of dragSlots.slice(1)) {
      const distance = Math.abs(clientY - (slot.centerY - scrollDelta));
      if (distance >= closestDistance) continue;
      closest = slot;
      closestDistance = distance;
    }
    if (dragOverId() !== closest.id) setDragOverId(closest.id);
    return closest.id;
  }

  function scrollRailOnce(): boolean {
    if (!railList) return false;
    const previousScrollTop = railList.scrollTop;
    railList.scrollTop += autoScrollVelocity;
    if (railList.scrollTop !== previousScrollTop) {
      updateDragTarget(lastDragClientY);
      scrollFades.measure();
    }
    return railList.scrollTop !== previousScrollTop;
  }

  function runAutoScroll(): void {
    autoScrollFrame = null;
    if (!railList || !draggedId() || autoScrollVelocity === 0) return;
    if (!scrollRailOnce()) {
      autoScrollVelocity = 0;
      return;
    }
    autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
  }

  function updateAutoScroll(clientY: number): void {
    if (!railList) return;
    lastDragClientY = clientY;
    const bounds = railList.getBoundingClientRect();
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

    if (autoScrollVelocity !== 0 && autoScrollFrame === null && scrollRailOnce()) {
      autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
    }
    if (autoScrollVelocity === 0 && autoScrollFrame !== null) {
      window.cancelAnimationFrame(autoScrollFrame);
      autoScrollFrame = null;
    }
  }

  function stopAutoScroll(): void {
    autoScrollVelocity = 0;
    if (autoScrollFrame === null) return;
    window.cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = null;
  }

  function moveServer(serverId: string, direction: -1 | 1): void {
    const ids = remoteServerIds();
    const index = ids.indexOf(serverId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) return;
    [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
    props.onReorder(ids);
    setAnnouncement(`Moved server to position ${targetIndex + 1} of ${ids.length}.`);
  }

  function dropServer(targetId: string): void {
    const sourceId = draggedId();
    if (!sourceId || sourceId === targetId) return;
    const ids = remoteServerIds();
    const sourceIndex = ids.indexOf(sourceId);
    const targetIndex = ids.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    ids.splice(sourceIndex, 1);
    ids.splice(targetIndex, 0, sourceId);
    props.onReorder(ids);
    setAnnouncement(`Moved server to position ${targetIndex + 1} of ${ids.length}.`);
  }

  function stopDragging(): void {
    setDraggedId(null);
    setDragOverId(null);
    stopAutoScroll();
    dragPreview.stop();
  }

  return (
    <aside
      class="server-rail"
      aria-label="Servers"
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
        const targetId = updateDragTarget(event.clientY) ?? dragOverId();
        if (targetId) dropServer(targetId);
        stopDragging();
      }}
    >
      <div
        class={["server-rail-list", scrollFades.classes()]}
        ref={(element) => {
          railList = element;
          scrollFades.bind(element);
        }}
        onScroll={scrollFades.measure}
      >
        <For each={localServers()} keyed={(server) => server.id}>
          {(server) => (
            <ServerRailButton server={server()} onSelect={props.onSelect} onOpenSettings={props.onOpenSettings} />
          )}
        </For>
        <Show when={remoteServers().length > 0}>
          <ul
            ref={(element) => (remoteList = element)}
            class="server-rail-remote-list"
            data-dragging={draggedId() ? "" : undefined}
          >
            <For each={remoteServers()} keyed={(server) => server.id}>
              {(server) => (
                <li
                  class={[
                    "server-rail-server-item",
                    {
                      "server-rail-server-item-dragging": draggedId() === server().id,
                      "server-rail-server-item-drag-over": dragOverId() === server().id,
                    },
                  ]}
                  style={{ "--server-rail-drag-step": dragStep(server().id) }}
                  data-server-id={server().id}
                  draggable="true"
                  onDragStart={(event) => {
                    event.dataTransfer?.setData("text/plain", server().id);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                    measureDragSlots();
                    if (railList) {
                      dragPreview.start({
                        bounds: railList,
                        className: "server-rail-drag-preview",
                        event,
                        source: event.currentTarget,
                      });
                    }
                    setDraggedId(server().id);
                    setDragOverId(server().id);
                  }}
                  onDragEnd={stopDragging}
                >
                  <ServerRailButton
                    server={server()}
                    onSelect={props.onSelect}
                    onOpenSettings={props.onOpenSettings}
                    onMove={(direction) => moveServer(server().id, direction)}
                  />
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Tooltip.Root
          placement="right"
          gutter={10}
          openDelay={SERVER_RAIL_TOOLTIP_OPEN_DELAY}
          closeDelay={0}
          skipDelayDuration={300}
        >
          <Tooltip.Trigger
            type="button"
            class={`${buttonVariants({ variant: "outline", size: "sm" })} server-rail-button server-rail-action`}
            aria-label="Add remote server"
            onClick={props.onAdd}
          >
            <span class="server-rail-monogram">+</span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content class="server-rail-tooltip">Add remote server</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <span class="sr-only" aria-live="polite">
          {announcement()}
        </span>
      </div>
    </aside>
  );
}

function ServerRailButton(props: {
  server: ServerSummary;
  onSelect: (serverId: string) => void;
  onOpenSettings: (serverId: string, trigger: HTMLElement | null) => void;
  onMove?: (direction: -1 | 1) => void;
}) {
  const [tooltipOpen, setTooltipOpen] = createSignal(false);
  let trigger: HTMLElement | null = null;
  return (
    <Tooltip.Root
      open={tooltipOpen()}
      onOpenChange={setTooltipOpen}
      placement="right"
      gutter={10}
      openDelay={SERVER_RAIL_TOOLTIP_OPEN_DELAY}
      closeDelay={0}
      skipDelayDuration={300}
    >
      <Tooltip.Trigger as="div" class="server-rail-tooltip-trigger">
        <ContextMenu.Root modal={false}>
          <ContextMenu.Trigger
            as="button"
            type="button"
            class={buttonVariants({ variant: "ghost", class: "server-rail-button" })}
            aria-label={`${props.server.name} server${props.server.state === "online" ? "" : `, ${props.server.state}`}`}
            aria-pressed={props.server.active ? "true" : "false"}
            aria-keyshortcuts={props.onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
            onClick={() => props.onSelect(props.server.id)}
            onContextMenu={(event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
              trigger = event.currentTarget;
            }}
            onFocus={() => setTooltipOpen(true)}
            onBlur={() => setTooltipOpen(false)}
            onKeyDown={(event: KeyboardEvent) => {
              if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
              event.preventDefault();
              props.onMove?.(event.key === "ArrowUp" ? -1 : 1);
            }}
          >
            <span class="server-rail-mark" aria-hidden="true" />
            <ServerMark server={props.server} />
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content class="agent-context-menu" aria-label="Server actions">
              <ContextMenu.Item onSelect={() => props.onOpenSettings(props.server.id, trigger)}>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  class="agent-context-icon"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.35"
                >
                  <rect x="3" y="3" width="14" height="5" rx="1.5" />
                  <rect x="3" y="12" width="14" height="5" rx="1.5" />
                  <circle cx="6" cy="5.5" r=".8" />
                  <circle cx="6" cy="14.5" r=".8" />
                </svg>
                <span>Server settings</span>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="server-rail-tooltip">{props.server.name}</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function ServerMark(props: { server: ServerSummary }) {
  const [failed, setFailed] = createSignal(false);
  createEffect(
    () => props.server.logoUrl,
    () => {
      setFailed(false);
    },
  );
  return (
    <Show when={!failed() ? props.server.logoUrl : null} fallback={<ServerGradientLogo seed={props.server.id} />}>
      {(url) => <img class="server-rail-logo" src={url()} alt="" draggable={false} onError={() => setFailed(true)} />}
    </Show>
  );
}
