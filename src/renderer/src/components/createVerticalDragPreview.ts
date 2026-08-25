interface VerticalDragPreviewStart {
  bounds: HTMLElement;
  className: string;
  createPreview?: (source: HTMLElement) => HTMLElement;
  event: {
    clientX?: number;
    clientY: number;
    dataTransfer: Pick<DataTransfer, "setDragImage"> | null;
  };
  horizontal?: boolean;
  previewSize?: { height: number; width: number };
  source: HTMLElement;
}

export function createVerticalDragPreview() {
  let preview: HTMLElement | undefined;
  let boundsRect: DOMRect | undefined;
  let previewLeft = 0;
  let pointerOffsetY = 0;
  let previewWidth = 0;
  let previewHeight = 0;
  let horizontal = false;
  let startClientX = 0;

  function render(clientY: number, clientX = startClientX): void {
    if (!preview || !boundsRect) return;
    const left = horizontal
      ? Math.min(
          Math.max(previewLeft + clientX - startClientX, boundsRect.left),
          Math.max(boundsRect.left, boundsRect.right - previewWidth),
        )
      : previewLeft;
    const top = Math.min(
      Math.max(clientY - pointerOffsetY, boundsRect.top),
      Math.max(boundsRect.top, boundsRect.bottom - previewHeight),
    );
    preview.style.transform = `translate3d(${left - previewLeft}px, ${top}px, 0)`;
  }

  function move(clientY: number, clientX?: number): void {
    if (!preview) return;
    render(clientY, clientX);
  }

  function track(event: DragEvent): void {
    if (!preview || (event.clientX === 0 && event.clientY === 0)) return;
    move(event.clientY, event.clientX);
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
    horizontal: allowHorizontal = false,
    previewSize,
    source,
  }: VerticalDragPreviewStart): void {
    stop();
    const sourceBounds = source.getBoundingClientRect();
    const nextBoundsRect = bounds.getBoundingClientRect();
    const clone = createPreview ? createPreview(source) : source.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return;
    clone.classList.add(className);
    clone.setAttribute("aria-hidden", "true");
    clone.setAttribute("inert", "");
    clone.removeAttribute("tabindex");
    clone.removeAttribute("draggable");
    clone.style.width = `${previewSize?.width ?? sourceBounds.width}px`;
    if (previewSize) clone.style.height = `${previewSize.height}px`;
    clone.style.top = "0px";
    clone.style.contain = "layout paint style";
    clone.style.willChange = "transform";
    document.body.append(clone);

    preview = clone;
    boundsRect = nextBoundsRect;
    pointerOffsetY = Math.min(
      Math.max(event.clientY - sourceBounds.top, 0),
      previewSize?.height ?? sourceBounds.height,
    );
    previewWidth = previewSize?.width ?? sourceBounds.width;
    previewHeight = previewSize?.height ?? sourceBounds.height;
    horizontal = allowHorizontal;
    startClientX = event.clientX ?? sourceBounds.left + sourceBounds.width / 2;
    const preferredLeft = previewSize ? sourceBounds.left + (sourceBounds.width - previewWidth) / 2 : sourceBounds.left;
    previewLeft = Math.min(
      Math.max(preferredLeft, boundsRect.left),
      Math.max(boundsRect.left, boundsRect.right - previewWidth),
    );
    clone.style.left = `${previewLeft}px`;
    render(event.clientY);
    window.addEventListener("dragover", track);

    if (event.dataTransfer?.setDragImage) {
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
  }

  return { move, start, stop };
}
