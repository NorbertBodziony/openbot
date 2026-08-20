import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { Dialog, IconButton, X } from "./ui";
import { cx } from "./ui/utils";

interface SettingsDialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: JSX.Element;
  description: JSX.Element;
  sidebar: JSX.Element;
  contentKey: string;
  children: JSX.Element;
  class?: string;
  floatingContent?: JSX.Element;
  closeLabel?: string;
  onContentElement?: (element: HTMLElement) => void;
}

function durationToMilliseconds(value: string, fallback: number): number {
  const duration = value.trim();
  if (duration.endsWith("ms")) return Number.parseFloat(duration) || fallback;
  if (duration.endsWith("s")) return (Number.parseFloat(duration) || fallback / 1_000) * 1_000;
  return fallback;
}

function closeDuration(): number {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  return durationToMilliseconds(
    getComputedStyle(document.documentElement).getPropertyValue("--openbot-duration-fast"),
    120,
  );
}

export function SettingsDialogShell(props: SettingsDialogShellProps) {
  const [rendered, setRendered] = createSignal(untrack(() => props.open));
  const [closing, setClosing] = createSignal(false);
  const [canScrollUp, setCanScrollUp] = createSignal(false);
  const [canScrollDown, setCanScrollDown] = createSignal(false);
  let closeTimer: number | undefined;
  let restoreTarget: HTMLElement | null = null;
  let restoreFrame: number | undefined;
  let modalElement: HTMLElement | undefined;
  let scrollElement: HTMLDivElement | undefined;
  let scrollResizeObserver: ResizeObserver | undefined;

  function clearCloseTimer(): void {
    if (closeTimer === undefined) return;
    window.clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  function restoreFocus(): void {
    if (!restoreTarget?.isConnected) return;
    const target = restoreTarget;
    restoreFrame = window.requestAnimationFrame(() => {
      restoreFrame = window.requestAnimationFrame(() => target.focus());
    });
  }

  function updateScrollFades(): void {
    if (!scrollElement) return;
    setCanScrollUp(scrollElement.scrollTop > 1);
    setCanScrollDown(scrollElement.scrollTop + scrollElement.clientHeight < scrollElement.scrollHeight - 1);
  }

  function registerScrollElement(element: HTMLDivElement): void {
    scrollResizeObserver?.disconnect();
    scrollElement = element;
    scrollResizeObserver = new ResizeObserver(updateScrollFades);
    scrollResizeObserver.observe(element);
    queueMicrotask(updateScrollFades);
  }

  createEffect(
    () => props.contentKey,
    () => {
      if (scrollElement) scrollElement.scrollTop = 0;
      queueMicrotask(updateScrollFades);
    },
  );

  createEffect(
    () => props.open,
    (open) => {
      clearCloseTimer();
      const isRendered = untrack(rendered);

      if (open) {
        if (!isRendered) {
          restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }
        setRendered(true);
        setClosing(false);
        return;
      }

      if (!isRendered) return;
      setClosing(true);
      closeTimer = window.setTimeout(() => {
        closeTimer = undefined;
        setRendered(false);
        setClosing(false);
        restoreFocus();
      }, closeDuration());
    },
  );

  onCleanup(() => {
    clearCloseTimer();
    scrollResizeObserver?.disconnect();
    if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame);
  });

  function requestOpenChange(open: boolean): void {
    if (!open && closing()) return;
    props.onOpenChange(open);
  }

  return (
    <Dialog.Root open={rendered()} onOpenChange={requestOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          class="settings-modal-backdrop"
          data-motion={closing() ? "closing" : "open"}
          data-testid="settings-modal-backdrop"
        >
          <Dialog.Content
            as="section"
            ref={(element) => {
              modalElement = element;
              props.onContentElement?.(element);
            }}
            class={cx("settings-modal", props.class)}
            data-motion={closing() ? "closing" : "open"}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              queueMicrotask(() => modalElement?.focus({ preventScroll: true }));
            }}
          >
            <aside class="settings-modal-sidebar">{props.sidebar}</aside>

            <div class="settings-modal-main">
              <header class="settings-modal-header">
                <div>
                  <Dialog.Title class="settings-modal-title">{props.title}</Dialog.Title>
                  <Dialog.Description class="settings-modal-description">{props.description}</Dialog.Description>
                </div>
                <IconButton
                  label={props.closeLabel ?? "Close settings"}
                  tooltip={props.closeLabel ?? "Close settings"}
                  variant="ghost"
                  onClick={() => requestOpenChange(false)}
                >
                  <X />
                </IconButton>
              </header>

              <div
                class="settings-modal-scroll-frame"
                data-scroll-up={canScrollUp() ? "" : undefined}
                data-scroll-down={canScrollDown() ? "" : undefined}
                data-testid="settings-modal-scroll-frame"
              >
                <div ref={registerScrollElement} class="settings-modal-content" onScroll={updateScrollFades}>
                  {props.children}
                </div>
              </div>
              {props.floatingContent}
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
