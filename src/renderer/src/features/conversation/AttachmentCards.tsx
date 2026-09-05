import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { Button } from "../../components/ui";
import { AnchoredTooltip } from "./AnchoredTooltip";
import { attachmentReferenceTone } from "./AttachmentReference";

export function AttachmentCards(props: {
  attachments: AttachmentSummary[];
  onPreview: (attachment: AttachmentSummary) => void;
  onAction: (attachment: AttachmentSummary, action: "open" | "reveal") => void;
}) {
  const tooltipId = `attachment-action-tooltip-${createUniqueId()}`;
  const [tooltip, setTooltip] = createSignal<{ anchor: HTMLElement; content: string } | null>(null);

  const openTooltip = (anchor: HTMLElement) => {
    setTooltip({ anchor, content: "Open file" });
  };
  const closeTooltip = (anchor: HTMLElement) => {
    if (tooltip()?.anchor === anchor) setTooltip(null);
  };
  const closeTooltipOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && event.currentTarget instanceof HTMLElement) closeTooltip(event.currentTarget);
  };

  return (
    <>
      <div class="message-attachments">
        <For each={props.attachments}>
          {(attachment) => (
            <div class="message-attachment">
              <Button
                variant="ghost"
                type="button"
                class="attachment-preview-button"
                disabled={attachment.previewKind === "none"}
                aria-label={`Preview ${attachment.name}`}
                onClick={() => props.onPreview(attachment)}
              >
                <Show
                  when={attachment.previewKind === "image"}
                  fallback={
                    <span
                      class="attachment-file-visual"
                      data-file-tone={attachmentReferenceTone(attachment.name)}
                      aria-hidden="true"
                    >
                      <AttachmentFileIcon />
                    </span>
                  }
                >
                  <span
                    class="attachment-file-visual attachment-file-image"
                    data-file-tone={attachmentReferenceTone(attachment.name)}
                  >
                    <img src={attachment.previewUrl ?? ""} alt="" />
                  </span>
                </Show>
                <span class="attachment-file-copy">
                  <strong>{attachment.name}</strong>
                  <small>{formatFileSize(attachment.size)}</small>
                </span>
              </Button>
              <Button
                variant="ghost"
                type="button"
                class="attachment-open-button"
                aria-label={`Open ${attachment.name}`}
                aria-describedby={tooltipId}
                onPointerEnter={(event) => openTooltip(event.currentTarget)}
                onMouseEnter={(event) => openTooltip(event.currentTarget)}
                onPointerLeave={(event) => closeTooltip(event.currentTarget)}
                onMouseLeave={(event) => closeTooltip(event.currentTarget)}
                onFocus={(event) => openTooltip(event.currentTarget)}
                onBlur={(event) => closeTooltip(event.currentTarget)}
                onKeyDown={closeTooltipOnEscape}
                onClick={() => {
                  setTooltip(null);
                  props.onAction(attachment, "open");
                }}
              >
                <AttachmentOpenIcon />
              </Button>
            </div>
          )}
        </For>
      </div>
      <Show when={tooltip()}>
        {(current) => <AnchoredTooltip id={tooltipId} anchor={current().anchor} content={current().content} />}
      </Show>
    </>
  );
}

export function fileBadge(attachment: AttachmentSummary): string {
  if (attachment.previewKind === "pdf") return "PDF";
  if (attachment.previewKind === "text") return "TXT";
  return attachment.name.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE";
}

function AttachmentFileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M5.5 2.75h5.75l3.25 3.5v11H5.5z" />
      <path d="M11.25 2.75v3.5h3.25M7.75 10h4.5M7.75 13h4.5" />
    </svg>
  );
}

function AttachmentOpenIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M8.25 5.25H5.5v9.25h9.25v-2.75" />
      <path d="M10.25 5.25h4.5v4.5M14.5 5.5l-6 6" />
    </svg>
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
