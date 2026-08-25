interface BoundedDragPreviewStart {
  bounds: HTMLElement;
  className: string;
  createPreview?: (source: HTMLElement) => HTMLElement;
  event: {
    clientX: number;
    clientY: number;
    dataTransfer: Pick<DataTransfer, "setDragImage"> | null;
  };
  horizontal?: boolean;
  previewSize?: { height: number; width: number };
  source: HTMLElement;
}

export function createBoundedDragPreview() {
  let preview: HTMLElement | undefined;
  let boundsRect: DOMRect | undefined;
  let pointerOffsetX = 0;
  let pointerOffsetY = 0;
  let previewWidth = 0;
  let previewHeight = 0;
  let previewLeft = 0;
  let horizontal = true;

  function move(clientX: number, clientY: number): void {
    if (!preview || !boundsRect) return;
    const left = horizontal
      ? Math.min(
          Math.max(clientX - pointerOffsetX, boundsRect.left),
          Math.max(boundsRect.left, boundsRect.right - previewWidth),
        )
      : previewLeft;
    const top = Math.min(
      Math.max(clientY - pointerOffsetY, boundsRect.top),
      Math.max(boundsRect.top, boundsRect.bottom - previewHeight),
    );
    preview.style.transform = `translate3d(${left}px, ${top}px, 0)`;
  }

  function track(event: DragEvent): void {
    if (!preview || (event.clientX === 0 && event.clientY === 0)) return;
    move(event.clientX, event.clientY);
  }

  function stop(): void {
    window.removeEventListener("dragover", track);
    preview?.remove();
    preview = undefined;
    boundsRect = undefined;
  }

  function start({
    bounds,
    className,
    createPreview,
    event,
    horizontal: allowHorizontal = true,
    previewSize,
    source,
  }: BoundedDragPreviewStart): void {
    if (!event.dataTransfer?.setDragImage) return;

    const sourceBounds = source.getBoundingClientRect();
    const nextBoundsRect = bounds.getBoundingClientRect();
    const clone = createPreview ? createPreview(source) : source.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return;
    stop();
    clone.classList.add(className);
    clone.setAttribute("aria-hidden", "true");
    clone.setAttribute("inert", "");
    clone.removeAttribute("tabindex");
    clone.removeAttribute("draggable");
    clone.style.width = `${previewSize?.width ?? sourceBounds.width}px`;
    if (previewSize) clone.style.height = `${previewSize.height}px`;
    clone.style.left = "0px";
    clone.style.top = "0px";
    clone.style.contain = "layout paint style";
    clone.style.willChange = "transform";
    document.body.append(clone);

    preview = clone;
    boundsRect = nextBoundsRect;
    horizontal = allowHorizontal;
    pointerOffsetX = Math.min(Math.max(event.clientX - sourceBounds.left, 0), previewSize?.width ?? sourceBounds.width);
    pointerOffsetY = Math.min(
      Math.max(event.clientY - sourceBounds.top, 0),
      previewSize?.height ?? sourceBounds.height,
    );
    previewWidth = previewSize?.width ?? sourceBounds.width;
    previewHeight = previewSize?.height ?? sourceBounds.height;
    previewLeft = Math.min(
      Math.max(sourceBounds.left, nextBoundsRect.left),
      Math.max(nextBoundsRect.left, nextBoundsRect.right - previewWidth),
    );
    move(event.clientX, event.clientY);
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
