import { Show } from "solid-js";
import { Button, Dialog } from "../ui";
import { CloseIcon } from "./ConversationIcons";
import { useConversationViewScope } from "./conversation-scope";

/** @internal Stable HMR boundary for conversation overlays. */
export function ConversationOverlays() {
  const { attachmentAction, mediaPreview, setMediaPreview } = useConversationViewScope();
  return (
    <Dialog.Root open={Boolean(mediaPreview())} onOpenChange={(open) => !open && setMediaPreview(null)}>
      <Show when={mediaPreview()}>
        {(preview) => (
          <Dialog.Portal>
            <Dialog.Overlay class="media-backdrop">
              <Dialog.Content as="section" class="media-modal" data-dialog-surface="unstyled">
                <Dialog.Title class="sr-only">{preview().attachment.name}</Dialog.Title>
                <Button
                  variant="ghost"
                  type="button"
                  class="media-close"
                  aria-label="Close media preview"
                  onClick={() => setMediaPreview(null)}
                >
                  <CloseIcon />
                </Button>
                <Show when={preview().attachment.previewKind === "image"}>
                  <img
                    class="media-image"
                    src={preview().attachment.previewUrl ?? ""}
                    alt={preview().attachment.name}
                  />
                </Show>
                <Show when={preview().attachment.previewKind === "pdf"}>
                  <iframe
                    class="media-document"
                    title={preview().attachment.name}
                    src={preview().attachment.previewUrl ?? ""}
                  />
                </Show>
                <Show when={preview().attachment.previewKind === "text"}>
                  <pre class="media-text">{preview().loading ? "Loading…" : (preview().error ?? preview().text)}</pre>
                </Show>
                <div class="media-caption">
                  <span>{preview().attachment.name}</span>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => attachmentAction(preview().attachment, "open")}
                  >
                    Open
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => attachmentAction(preview().attachment, "download")}
                  >
                    Download
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => attachmentAction(preview().attachment, "reveal")}
                  >
                    Show in Finder
                  </Button>
                </div>
              </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </Show>
    </Dialog.Root>
  );
}
