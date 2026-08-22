import {
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualItem,
  Virtualizer,
} from "@tanstack/virtual-core";
import { createEffect, createSignal, createStore, onSettled, untrack } from "solid-js";

interface ChatVirtualizerOptions<TScrollElement extends Element, TItemElement extends Element> {
  count: () => number;
  getScrollElement: () => TScrollElement | null;
  estimateSize: (index: number) => number;
  getItemKey: (index: number) => string | number;
  scrollMargin: () => number;
  onChange?: (virtualizer: Virtualizer<TScrollElement, TItemElement>) => void;
}

export interface ChatVirtualizer<TItemElement extends Element> {
  getVirtualItems: () => VirtualItem[];
  getTotalSize: () => number;
  measureElement: (element: TItemElement | null) => void;
  scrollMargin: () => number;
}

export function createChatVirtualizer<TScrollElement extends Element, TItemElement extends Element>(
  options: ChatVirtualizerOptions<TScrollElement, TItemElement>,
): ChatVirtualizer<TItemElement> {
  const initialCount = options.count();
  const [virtualItems, setVirtualItems] = createSignal<VirtualItem[]>(
    fallbackItems(initialCount, options.estimateSize, options.getItemKey),
  );
  const [totalSize, setTotalSize] = createSignal(initialCount * options.estimateSize(0));
  const stableItems = new Map<VirtualItem["key"], { item: VirtualItem; update: (next: VirtualItem) => void }>();
  const virtualizer = new Virtualizer<TScrollElement, TItemElement>({
    count: 0,
    getScrollElement: options.getScrollElement,
    estimateSize: options.estimateSize,
    getItemKey: options.getItemKey,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 5,
    anchorTo: "end",
    followOnAppend: "auto",
    scrollEndThreshold: 80,
    initialRect: { width: 1, height: 600 },
  });
  let refreshQueued = false;

  const refresh = (): void => {
    const measured = [...virtualizer.getVirtualItems()];
    const count = options.count();
    const items = measured.length > 0 ? measured : fallbackItems(count, options.estimateSize, options.getItemKey);
    const activeKeys = new Set(items.map((item) => item.key));
    const nextItems = items.map((item) => {
      const existing = stableItems.get(item.key);
      if (existing) {
        if (!virtualItemsEqual(existing.item, item)) existing.update(item);
        return existing.item;
      }
      const [stored, setStored] = createStore(Object.assign({}, item));
      stableItems.set(item.key, { item: stored, update: (next) => setStored(() => next) });
      return stored;
    });
    for (const key of stableItems.keys()) {
      if (!activeKeys.has(key)) stableItems.delete(key);
    }
    setVirtualItems(nextItems);
    setTotalSize(virtualizer.getTotalSize() || count * options.estimateSize(0));
  };

  const scheduleRefresh = (): void => {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      refresh();
    });
  };

  createEffect(
    () => ({ count: options.count(), scrollMargin: options.scrollMargin() }),
    ({ count, scrollMargin }) => {
      virtualizer.setOptions({
        ...virtualizer.options,
        count,
        getScrollElement: options.getScrollElement,
        estimateSize: options.estimateSize,
        getItemKey: options.getItemKey,
        scrollMargin,
        onChange: (instance) => {
          scheduleRefresh();
          untrack(() => options.onChange?.(instance));
        },
      });
      virtualizer._willUpdate();
      scheduleRefresh();
    },
  );

  onSettled(() => {
    const cleanup = virtualizer._didMount();
    virtualizer._willUpdate();
    scheduleRefresh();
    return cleanup;
  });

  return {
    getVirtualItems: () => {
      return virtualItems();
    },
    getTotalSize: totalSize,
    measureElement: (element) => {
      if (!element) {
        virtualizer.measureElement(null);
        return;
      }
      // Solid can run a ref before data-index and the row contents are committed.
      queueMicrotask(() => {
        if (element.isConnected) virtualizer.measureElement(element);
      });
    },
    scrollMargin: options.scrollMargin,
  };
}

function virtualItemsEqual(left: VirtualItem, right: VirtualItem): boolean {
  return (
    left.key === right.key &&
    left.index === right.index &&
    left.start === right.start &&
    left.end === right.end &&
    left.size === right.size &&
    left.lane === right.lane
  );
}

function fallbackItems(
  count: number,
  estimateSize: (index: number) => number,
  getItemKey: (index: number) => string | number,
): VirtualItem[] {
  const startIndex = count <= 100 ? 0 : Math.max(0, count - 10);
  return Array.from({ length: count - startIndex }, (_, offset): VirtualItem => {
    const index = startIndex + offset;
    const size = estimateSize(index);
    const start = index * size;
    return { key: getItemKey(index), index, start, end: start + size, size, lane: 0 };
  });
}
