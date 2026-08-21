import type { JSX } from "@solidjs/web";
import { createEffect, onCleanup } from "solid-js";
import { Dialog, IconButton, X } from "./ui";
import { cx } from "./ui/utils";

interface CenterMorphModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: JSX.Element;
  description?: JSX.Element;
  children: JSX.Element;
  class?: string;
  closeLabel?: string;
}

export function CenterMorphModal(props: CenterMorphModalProps) {
  let restoreTarget: HTMLElement | null = null;
  let restoreFrame: number | undefined;

  createEffect(
    () => props.open,
    (open, previousOpen) => {
      if (open) {
        restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return;
      }
      if (!previousOpen || !restoreTarget?.isConnected) return;
      const target = restoreTarget;
      restoreFrame = window.requestAnimationFrame(() => target.focus());
    },
  );

  onCleanup(() => {
    if (restoreFrame !== undefined) window.cancelAnimationFrame(restoreFrame);
  });

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="center-morph-modal-backdrop" />
        <div class="center-morph-modal-positioner">
          <Dialog.Content as="section" class={cx("center-morph-modal", props.class)}>
            <header class="center-morph-modal-header">
              <div class="center-morph-modal-heading">
                <Dialog.Title class="center-morph-modal-title">{props.title}</Dialog.Title>
                {props.description ? (
                  <Dialog.Description class="center-morph-modal-description">{props.description}</Dialog.Description>
                ) : null}
              </div>
              <IconButton
                label={props.closeLabel ?? "Close modal"}
                tooltip={props.closeLabel ?? "Close modal"}
                variant="ghost"
                class="center-morph-modal-close"
                onClick={() => props.onOpenChange(false)}
              >
                <X aria-hidden="true" />
              </IconButton>
            </header>
            {props.children}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
