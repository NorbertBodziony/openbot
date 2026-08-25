interface VerticalDragPreviewStart {
  bounds: HTMLElement;
  className: string;
  event: DragEvent;
  source: HTMLElement;
}

export function createVerticalDragPreview() {
  let preview: HTMLElement | undefined;
  let boundsElement: HTMLElement | undefined;
  let sourceLeft = 0;
  let pointerOffsetY = 0;
  let previewWidth = 0;
  let previewHeight = 0;

  function move(clientY: number): void {
    if (!preview || !boundsElement) return;
    const bounds = boundsElement.getBoundingClientRect();
    const left = Math.min(Math.max(sourceLeft, bounds.left), Math.max(bounds.left, bounds.right - previewWidth));
    const top = Math.min(
      Math.max(clientY - pointerOffsetY, bounds.top),
      Math.max(bounds.top, bounds.bottom - previewHeight),
    );
    preview.style.left = `${left}px`;
    preview.style.top = `${top}px`;
  }

  function track(event: DragEvent): void {
    if (!preview || (event.clientX === 0 && event.clientY === 0)) return;
    move(event.clientY);
  }

  function stop(): void {
    window.removeEventListener("dragover", track);
    preview?.remove();
    preview = undefined;
    boundsElement = undefined;
  }

  function start({ bounds, className, event, source }: VerticalDragPreviewStart): void {
    if (!event.dataTransfer?.setDragImage) return;

    const sourceBounds = source.getBoundingClientRect();
    const clone = source.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return;
    stop();
    clone.classList.add(className);
    clone.setAttribute("aria-hidden", "true");
    clone.setAttribute("inert", "");
    clone.removeAttribute("tabindex");
    clone.removeAttribute("draggable");
    clone.style.width = `${sourceBounds.width}px`;
    document.body.append(clone);

    preview = clone;
    boundsElement = bounds;
    sourceLeft = sourceBounds.left;
    pointerOffsetY = Math.min(Math.max(event.clientY - sourceBounds.top, 0), sourceBounds.height);
    previewWidth = sourceBounds.width;
    previewHeight = sourceBounds.height;
    move(event.clientY);
    window.addEventListener("dragover", track);

    const hiddenDragImage = document.createElement("span");
    hiddenDragImage.style.position = "fixed";
    hiddenDragImage.style.left = "-1px";
    hiddenDragImage.style.top = "-1px";
    hiddenDragImage.style.width = "1px";
    hiddenDragImage.style.height = "1px";
    hiddenDragImage.style.opacity = "0";
    document.body.append(hiddenDragImage);
    event.dataTransfer.setDragImage(hiddenDragImage, 0, 0);
    requestAnimationFrame(() => hiddenDragImage.remove());
  }

  return { move, start, stop };
}
